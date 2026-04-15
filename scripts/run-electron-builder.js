const fs = require('fs');
const https = require('https');
const path = require('path');
const { spawnSync } = require('child_process');

const projectRoot = path.resolve(__dirname, '..');
const builderCli = path.join(projectRoot, 'node_modules', 'electron-builder', 'cli.js');
const sevenZip = path.join(projectRoot, 'node_modules', '7zip-bin', 'win', 'x64', '7za.exe');
const builderCacheDir = path.join(projectRoot, '.cache', 'electron-builder');
const toolCacheDir = path.join(projectRoot, '.cache', 'electron-builder-tools');
const nsisVersion = '3.0.4.1';
const nsisDir = path.join(toolCacheDir, 'nsis', `nsis-${nsisVersion}`);
const nsisArchivePath = path.join(toolCacheDir, 'downloads', `nsis-${nsisVersion}.7z`);
const nsisArchiveUrl = `https://github.com/electron-userland/electron-builder-binaries/releases/download/nsis-${nsisVersion}/nsis-${nsisVersion}.7z`;

function ensureDirectory(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function fileExists(filePath) {
  return fs.existsSync(filePath);
}

function downloadFile(url, outputPath) {
  return new Promise((resolve, reject) => {
    const request = https.get(url, response => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        response.resume();
        downloadFile(response.headers.location, outputPath).then(resolve).catch(reject);
        return;
      }

      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error(`Failed to download ${url}: HTTP ${response.statusCode}`));
        return;
      }

      const fileStream = fs.createWriteStream(outputPath);
      response.pipe(fileStream);

      fileStream.on('finish', () => {
        fileStream.close(resolve);
      });

      fileStream.on('error', error => {
        fs.rmSync(outputPath, { force: true });
        reject(error);
      });
    });

    request.on('error', reject);
  });
}

async function ensureNsis() {
  const nsisExecutable = path.join(nsisDir, 'Bin', 'makensis.exe');
  const elevateExecutable = path.join(nsisDir, 'elevate.exe');

  if (fileExists(nsisExecutable) && fileExists(elevateExecutable)) {
    return;
  }

  ensureDirectory(path.dirname(nsisArchivePath));
  ensureDirectory(path.dirname(nsisDir));

  if (!fileExists(nsisArchivePath)) {
    console.log(`Downloading NSIS ${nsisVersion}...`);
    await downloadFile(nsisArchiveUrl, nsisArchivePath);
  }

  fs.rmSync(nsisDir, { recursive: true, force: true });
  ensureDirectory(nsisDir);

  const extract = spawnSync(
    sevenZip,
    ['x', '-bd', nsisArchivePath, `-o${nsisDir}`, '-aoa'],
    { stdio: 'inherit' }
  );

  if (extract.status !== 0) {
    throw new Error(`Failed to extract NSIS archive, exit code ${extract.status}`);
  }

  if (!fileExists(nsisExecutable) || !fileExists(elevateExecutable)) {
    throw new Error('NSIS extraction completed, but required binaries were not found');
  }
}

async function main() {
  ensureDirectory(builderCacheDir);
  process.env.ELECTRON_BUILDER_CACHE = builderCacheDir;

  if (process.platform === 'win32') {
    await ensureNsis();
    process.env.ELECTRON_BUILDER_NSIS_DIR = nsisDir;
  }

  const result = spawnSync(process.execPath, [builderCli, ...process.argv.slice(2)], {
    stdio: 'inherit',
    env: process.env,
  });

  if (result.error) {
    throw result.error;
  }

  process.exit(result.status === null ? 1 : result.status);
}

main().catch(error => {
  console.error(error.message || error);
  process.exit(1);
});