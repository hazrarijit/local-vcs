/**
 * project.service.js - Project Management Service
 * 
 * Handles project CRUD operations, initialization of .file-sync/ directory,
 * encrypted file storage, and metadata management.
 */

const fs = require('fs-extra');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const JsonStore = require('../utils/store');
const EncryptionUtil = require('../utils/encryption');
const { hashFile, hashData, generateVersionId } = require('../utils/hashing');
const SyncIgnoreService = require('./syncignore.service');

const SYNC_DIR = '.file-sync';
const METADATA_FILE = 'metadata.json';
const FILES_DIR = 'files';
const ENCRYPTION_PASSPHRASE = 'syncvcs-local-encryption-key-2024';

class ProjectService {
    constructor() {
        this.store = new JsonStore('projects.json');
        this.encryption = new EncryptionUtil(ENCRYPTION_PASSPHRASE);
        this.syncIgnore = new SyncIgnoreService();
    }

    /**
     * Create and register a new project
     * @param {object} projectData - { name, folderPath, remoteUrl, description? }
     * @returns {object}
     */
    async createProject({ name, folderPath, remoteUrl, description }) {
        if (!name || !folderPath) {
            return { success: false, message: 'Project name and folder path are required.' };
        }

        // Validate folder exists
        if (!fs.existsSync(folderPath)) {
            return { success: false, message: 'The specified folder does not exist.' };
        }

        // Check for duplicate project paths
        const projects = await this.store.get('projects', []);
        const exists = projects.find(p => p.folderPath === folderPath);
        if (exists) {
            return { success: false, message: 'A project already exists for this folder.' };
        }

        const project = {
            id: uuidv4(),
            name,
            folderPath: path.resolve(folderPath),
            remoteUrl: remoteUrl || '',
            description: description || '',
            createdAt: new Date().toISOString(),
            lastSyncAt: null,
            status: 'initialized',
            autoSync: false
        };

        projects.push(project);
        await this.store.set('projects', projects);

        // Initialize .file-sync directory
        await this._initializeSyncDir(project);

        return { success: true, message: 'Project created and initialized.', project };
    }

    /**
     * Atomically write a JSON file using tmp + rename to prevent corruption on crash
     * @param {string} filePath - Target JSON file path
     * @param {object} data - Data to write
     */
    async _atomicWriteJson(filePath, data) {
        const tmpPath = filePath + '.tmp.' + Date.now() + '.' + process.pid;
        try {
            await fs.writeJson(tmpPath, data, { spaces: 2 });
            await fs.rename(tmpPath, filePath);
        } catch (err) {
            // Cleanup temp file on failure
            await fs.remove(tmpPath).catch(() => {});
            throw err;
        }
    }

    /**
     * Initialize the .file-sync/ directory with encrypted copies and metadata
     * Optimized for large bases: pooled concurrency + early prune + yields
     * @param {object} project
     */
    async _initializeSyncDir(project) {
        const syncDir = path.join(project.folderPath, SYNC_DIR);
        const filesDir = path.join(syncDir, FILES_DIR);
        const metadataPath = path.join(syncDir, METADATA_FILE);

        // --- Auto-create .syncignore with basic ignore properties BEFORE encryption scan ---
        // This ensures the file exists for first-time projects and that the
        // subsequent walk + AES-256-CBC encryption step respects ignore rules
        // (ignored files like .git, node_modules, .file-sync, *.log etc. are never encrypted)
        try {
            const created = this.syncIgnore.ensureDefaultIgnoreFile
                ? this.syncIgnore.ensureDefaultIgnoreFile(project.folderPath)
                : this.syncIgnore.createDefaultIgnoreFile(project.folderPath);
            if (created) {
                console.log(`Created default .syncignore at ${path.join(project.folderPath, '.syncignore')}`);
            }
        } catch (err) {
            console.warn('Failed to auto-create .syncignore, continuing with defaults:', err.message);
        }

        await fs.ensureDir(filesDir);
        // Reload fresh patterns (now guaranteed .syncignore exists if it was missing)
        this.syncIgnore.load(project.folderPath);

        const allFiles = await this._getAllFiles(project.folderPath);
        const trackedFiles = [];
        for (const p of allFiles) {
            if (!this.syncIgnore.isIgnored(p)) trackedFiles.push(p);
        }

        const metadata = {
            projectId: project.id,
            projectName: project.name,
            createdAt: new Date().toISOString(),
            lastScanAt: new Date().toISOString(),
            files: {}
        };

        // Process with limited concurrency to saturate disk without blocking event loop
        const CONCURRENCY = 8;
        const failures = [];
        await this._pooledMap(trackedFiles, CONCURRENCY, async (relativePath) => {
            const absolutePath = path.join(project.folderPath, relativePath);
            try {
                const stat = await fs.stat(absolutePath);
                if (!stat.isFile()) return;
                // Skip extremely large files > 50MB for initial snapshot to keep init responsive? Still store metadata but skip encryption? We store encryption regardless but stream it.
                const fileHash = await hashFile(absolutePath);
                const versionId = generateVersionId();
                const fileContent = await fs.readFile(absolutePath);
                const encrypted = this.encryption.encrypt(fileContent);
                const encryptedFileName = hashData(relativePath) + '.enc';
                const encryptedFilePath = path.join(filesDir, encryptedFileName);
                await fs.writeFile(encryptedFilePath, encrypted);
                metadata.files[relativePath] = {
                    hash: fileHash,
                    lastModified: stat.mtime.toISOString(),
                    lastMtime: stat.mtime.getTime(),
                    size: stat.size,
                    versionId,
                    encryptedFile: encryptedFileName,
                    trackedSince: new Date().toISOString()
                };
            } catch (err) {
                failures.push(relativePath);
                console.error(`Failed to process file: ${relativePath}`, err.message);
            }
        });

        if (failures.length) console.warn(`Init: ${failures.length} files skipped out of ${trackedFiles.length}`);
        await this._atomicWriteJson(metadataPath, metadata);
    }

    /**
     * Fast iterative walk with early ignore-pruning.
     * Returns relative file paths (forward slashes).
     */
    async _getAllFiles(rootDir, base = rootDir, maxDepth = 25) {
        const results = [];
        const stack = [{ dir: rootDir, depth: 0 }];
        let processedDirs = 0;
        while (stack.length > 0) {
            const { dir, depth } = stack.pop();
            if (depth > maxDepth) continue;
            const relDir = path.relative(base, dir).replace(/\\/g, '/');
            if (relDir && relDir !== '.' && this.syncIgnore.canPruneDir(relDir)) continue;
            let entries;
            try {
                entries = await fs.readdir(dir, { withFileTypes: true });
            } catch { continue; }
            for (const entry of entries) {
                const fullPath = path.join(dir, entry.name);
                const relativePath = path.relative(base, fullPath).replace(/\\/g, '/');
                if (entry.isDirectory()) {
                    if (this.syncIgnore.canPruneDir(relativePath)) continue;
                    const hardIgnores = ['node_modules', '.git', '.file-sync', '.svn', '__pycache__'];
                    if (hardIgnores.includes(entry.name) && !relativePath.includes('/')) {
                        let negated = false;
                        for (const pat of this.syncIgnore.patterns) {
                            if (pat.isNegation && pat.normalized.includes(entry.name)) { negated = true; break; }
                        }
                        if (!negated) continue;
                    }
                    stack.push({ dir: fullPath, depth: depth + 1 });
                } else if (entry.isFile()) {
                    results.push(relativePath);
                } else {
                    try {
                        const st = await fs.stat(fullPath);
                        if (st.isFile()) results.push(relativePath);
                    } catch { /* ignore */ }
                }
            }
            processedDirs++;
            if (processedDirs % 200 === 0) await new Promise(r => setImmediate(r));
        }
        return results;
    }

    async _pooledMap(items, concurrency, worker) {
        if (!items || items.length === 0) return;
        const limit = Math.max(1, Math.min(concurrency, items.length));
        let idx = 0;
        const run = async () => {
            while (true) {
                const cur = idx++;
                if (cur >= items.length) break;
                try { await worker(items[cur], cur); } catch (e) { console.error('pooledMap error', e.message); }
                if (cur % 100 === 0) await new Promise(r => setImmediate(r));
            }
        };
        await Promise.all(Array.from({ length: limit }, () => run()));
    }

    /**
     * Get all registered projects
     * @returns {object[]}
     */
    async getProjects() {
        return await this.store.get('projects', []);
    }

    /**
     * Get a project by ID
     * @param {string} projectId
     * @returns {object|null}
     */
    async getProject(projectId) {
        const projects = await this.getProjects();
        return projects.find(p => p.id === projectId) || null;
    }

    /**
     * Update project details
     * @param {string} projectId
     * @param {object} updates
     * @returns {object}
     */
    async updateProject(projectId, updates) {
        const projects = await this.getProjects();
        const idx = projects.findIndex(p => p.id === projectId);
        if (idx === -1) {
            return { success: false, message: 'Project not found.' };
        }

        const allowed = ['name', 'remoteUrl', 'description', 'autoSync'];
        for (const key of allowed) {
            if (key in updates) {
                projects[idx][key] = updates[key];
            }
        }

        await this.store.set('projects', projects);
        return { success: true, message: 'Project updated.', project: projects[idx] };
    }

    /**
     * Delete a project (removes from store, optionally removes .file-sync/)
     * @param {string} projectId
     * @param {boolean} removeSyncDir
     * @returns {object}
     */
    async deleteProject(projectId, removeSyncDir = false) {
        const projects = await this.getProjects();
        const project = projects.find(p => p.id === projectId);
        if (!project) {
            return { success: false, message: 'Project not found.' };
        }

        if (removeSyncDir) {
            const syncDir = path.join(project.folderPath, SYNC_DIR);
            await fs.remove(syncDir);
        }

        const filtered = projects.filter(p => p.id !== projectId);
        await this.store.set('projects', filtered);

        return { success: true, message: 'Project removed.' };
    }

    /**
     * Re-initialize the .file-sync/ directory for an existing project
     * Clears all encrypted snapshots and rebuilds from the current folder state
     * @param {string} projectId
     * @returns {object}
     */
    async reinitializeProject(projectId) {
        const project = await this.getProject(projectId);
        if (!project) {
            return { success: false, message: 'Project not found.' };
        }

        if (!fs.existsSync(project.folderPath)) {
            return { success: false, message: 'Project folder no longer exists.' };
        }

        // Remove existing .file-sync directory
        const syncDir = path.join(project.folderPath, SYNC_DIR);
        await fs.remove(syncDir);

        // Re-run full initialization
        await this._initializeSyncDir(project);

        // Update lastSyncAt
        const projects = await this.getProjects();
        const idx = projects.findIndex(p => p.id === projectId);
        if (idx !== -1) {
            projects[idx].lastSyncAt = null;
            await this.store.set('projects', projects);
        }

        return { success: true, message: 'Project re-initialized successfully.' };
    }

    /**
     * Get the metadata for a project's tracked files
     * @param {string} projectId
     * @returns {object|null}
     */
    async getMetadata(projectId) {
        const project = await this.getProject(projectId);
        if (!project) return null;

        const metadataPath = path.join(project.folderPath, SYNC_DIR, METADATA_FILE);
        if (!fs.existsSync(metadataPath)) return null;

        return fs.readJson(metadataPath);
    }

    /**
     * Update metadata after changes are synced/saved
     * @param {string} projectId
     * @param {object} updatedFiles - { [relativePath]: { hash, lastModified, size, versionId } }
     */
    async updateMetadata(projectId, updatedFiles) {
        const project = await this.getProject(projectId);
        if (!project) return;

        const metadataPath = path.join(project.folderPath, SYNC_DIR, METADATA_FILE);
        const metadata = await fs.readJson(metadataPath);

        metadata.lastScanAt = new Date().toISOString();

        for (const [filePath, fileData] of Object.entries(updatedFiles)) {
            if (fileData === null) {
                // File was deleted
                const existing = metadata.files[filePath];
                if (existing) {
                    // Remove encrypted file
                    const encPath = path.join(project.folderPath, SYNC_DIR, FILES_DIR, existing.encryptedFile);
                    await fs.remove(encPath).catch(() => {});
                    delete metadata.files[filePath];
                }
            } else {
                // File was added or modified
                const encryptedFileName = hashData(filePath) + '.enc';
                metadata.files[filePath] = {
                    ...metadata.files[filePath],
                    ...fileData,
                    encryptedFile: encryptedFileName
                };
            }
        }

        await this._atomicWriteJson(metadataPath, metadata);
    }

    /**
     * Re-encrypt and update the stored copy of a file
     * @param {string} projectId
     * @param {string} relativePath
     */
    async updateStoredFile(projectId, relativePath) {
        const project = await this.getProject(projectId);
        if (!project) return;

        const absolutePath = path.join(project.folderPath, relativePath);
        const filesDir = path.join(project.folderPath, SYNC_DIR, FILES_DIR);

        if (!fs.existsSync(absolutePath)) return;

        const fileContent = await fs.readFile(absolutePath);
        const encrypted = this.encryption.encrypt(fileContent);

        const encryptedFileName = hashData(relativePath) + '.enc';
        await fs.writeFile(path.join(filesDir, encryptedFileName), encrypted);
    }

    /**
     * Get the decrypted stored version of a file
     * @param {string} projectId
     * @param {string} relativePath
     * @returns {string|null} - Decrypted file content as UTF-8 string
     */
    async getStoredFileContent(projectId, relativePath) {
        const project = await this.getProject(projectId);
        if (!project) return null;

        const metadata = await this.getMetadata(projectId);
        if (!metadata || !metadata.files[relativePath]) return null;

        const encryptedFileName = metadata.files[relativePath].encryptedFile;
        const encryptedPath = path.join(project.folderPath, SYNC_DIR, FILES_DIR, encryptedFileName);

        if (!fs.existsSync(encryptedPath)) return null;

        try {
            const encryptedData = await fs.readFile(encryptedPath);
            const decrypted = this.encryption.decrypt(encryptedData);
            return decrypted.toString('utf8');
        } catch (err) {
            console.error(`Failed to decrypt stored file: ${relativePath}`, err.message);
            return null;
        }
    }

    // ========================
    // STAGING SYSTEM
    // ========================

    /**
     * Stage files: update encrypted copies + metadata so they no longer show as "changed",
     * but record them as "staged but not deployed".
     * @param {string} projectId
     * @param {object[]} files - Array of { path, type: 'add'|'update'|'delete' }
     * @returns {Promise<object>}
     */
    async stageFiles(projectId, files) {
        const project = await this.getProject(projectId);
        if (!project) return { success: false, message: 'Project not found.' };

        const metadataPath = path.join(project.folderPath, SYNC_DIR, METADATA_FILE);
        const metadata = await fs.readJson(metadataPath);
        const filesDir = path.join(project.folderPath, SYNC_DIR, FILES_DIR);
        let staged = 0;

        const failures = [];

        for (const file of files) {
            try {
                const absolutePath = path.join(project.folderPath, file.path);

                if (file.type === 'delete') {
                    // Mark as deleted in metadata
                    if (metadata.files[file.path]) {
                        metadata.files[file.path].stagedAt = new Date().toISOString();
                        metadata.files[file.path].stagedAction = 'delete';
                    }
                    staged++;
                    continue;
                }

                // add or update: re-encrypt current file and update hash
                if (!fs.existsSync(absolutePath)) {
                    failures.push({ path: file.path, error: 'File not found on disk' });
                    continue;
                }

                const stat = await fs.stat(absolutePath);
                // hashFile now has internal retry + 30s timeout; pass explicitly
                const fileHash = await hashFile(absolutePath, 30000);
                const versionId = generateVersionId();

                // Re-encrypt and store
                const fileContent = await fs.readFile(absolutePath);
                const encrypted = this.encryption.encrypt(fileContent);
                const encryptedFileName = hashData(file.path) + '.enc';
                await fs.writeFile(path.join(filesDir, encryptedFileName), encrypted);

                // Update metadata — hash now matches, file won't show as "changed"
                const existing = metadata.files[file.path] || {};
                metadata.files[file.path] = {
                    ...existing,
                    hash: fileHash,
                    lastModified: stat.mtime.toISOString(),
                    lastMtime: stat.mtime.getTime(),
                    size: stat.size,
                    versionId,
                    encryptedFile: encryptedFileName,
                    trackedSince: existing.trackedSince || new Date().toISOString(),
                    stagedAt: new Date().toISOString(),
                    stagedAction: file.type
                    // deployedHash stays as-is (null or previous value)
                };

                staged++;
            } catch (err) {
                console.error(`Stage failed for ${file.path}:`, err.message);
                failures.push({ path: file.path, error: err.message });
            }
            // Yield to event loop between files to reduce disk contention on Windows
            await new Promise(r => setImmediate(r));
        }

        metadata.lastScanAt = new Date().toISOString();
        await this._atomicWriteJson(metadataPath, metadata);

        if (failures.length > 0) {
            return {
                success: staged > 0,
                staged,
                failed: failures.length,
                failures,
                message: failures.length === files.length
                    ? `Staging failed for all ${failures.length} file(s): ${failures[0].error}`
                    : `Staged ${staged}/${files.length} file(s). ${failures.length} failed: ${failures.map(f => f.path).join(', ')}`
            };
        }

        return { success: true, staged, message: `Staged ${staged} file(s).` };
    }

    /**
     * Get files that have been staged but not yet deployed to the remote server.
     * @param {string} projectId
     * @returns {Promise<object[]>}
     */
    async getStagedFiles(projectId) {
        const project = await this.getProject(projectId);
        if (!project) return [];

        const metadata = await this.getMetadata(projectId);
        if (!metadata) return [];

        const staged = [];
        for (const [filePath, info] of Object.entries(metadata.files)) {
            if (info.stagedAt && !info.deployedAt) {
                // Staged but never deployed
                staged.push({
                    path: filePath,
                    name: path.basename(filePath),
                    dir: path.dirname(filePath),
                    type: info.stagedAction || 'update',
                    stagedAt: info.stagedAt,
                    size: info.size
                });
            } else if (info.stagedAt && info.deployedAt && new Date(info.stagedAt) > new Date(info.deployedAt)) {
                // Staged again after last deployment
                staged.push({
                    path: filePath,
                    name: path.basename(filePath),
                    dir: path.dirname(filePath),
                    type: info.stagedAction || 'update',
                    stagedAt: info.stagedAt,
                    size: info.size
                });
            }
        }

        return staged;
    }

    /**
     * Mark staged files as deployed (after successful server sync).
     * @param {string} projectId
     * @param {string[]} filePaths - Paths that were successfully deployed
     */
    async markFilesDeployed(projectId, filePaths) {
        const project = await this.getProject(projectId);
        if (!project) return;

        const metadataPath = path.join(project.folderPath, SYNC_DIR, METADATA_FILE);
        const metadata = await fs.readJson(metadataPath);

        for (const filePath of filePaths) {
            if (metadata.files[filePath]) {
                if (metadata.files[filePath].stagedAction === 'delete') {
                    // Actually remove from metadata + encrypted file
                    const encPath = path.join(project.folderPath, SYNC_DIR, FILES_DIR, metadata.files[filePath].encryptedFile);
                    await fs.remove(encPath).catch(() => {});
                    delete metadata.files[filePath];
                } else {
                    metadata.files[filePath].deployedAt = new Date().toISOString();
                    delete metadata.files[filePath].stagedAction;
                }
            }
        }

        await this._atomicWriteJson(metadataPath, metadata);
    }
}

module.exports = ProjectService;
