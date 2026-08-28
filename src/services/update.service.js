/**
 * update.service.js - Auto Update Service (GitHub Releases via electron-updater)
 *
 * Handles checking, downloading and installing updates from GitHub Releases.
 * Works only in packaged app (not in dev). Renderer is notified via
 * mainWindow.webContents.send('update:status', payload).
 */

const { app } = require('electron');
const log = require('electron-log');
const semver = require('semver');

let autoUpdater = null;
try {
    ({ autoUpdater } = require('electron-updater'));
} catch (e) {
    log.warn('[UpdateService] electron-updater not available:', e.message);
}

class UpdateService {
    constructor() {
        this.mainWindow = null;
        this.isInitialized = false;
        this.lastCheckResult = null;
        this.downloadProgress = null;
        this.isDownloading = false;
        this.isUpdateDownloaded = false;
        this.pendingVersion = null;
        // Auto-check interval (6 hours)
        this.autoCheckIntervalMs = 6 * 60 * 60 * 1000;
        this.intervalId = null;
    }

    init(mainWindow) {
        this.mainWindow = mainWindow;

        if (!autoUpdater) {
            log.warn('[UpdateService] Skipped - autoUpdater not loaded');
            return;
        }

        // Do not run updater in dev / unpacked mode
        if (!app.isPackaged) {
            log.info('[UpdateService] Skipped - app not packaged (dev mode)');
            // Still enable manual GitHub API fallback check for dev testing
            return;
        }

        // Configure autoUpdater
        autoUpdater.logger = log;
        autoUpdater.autoDownload = false; // let user confirm
        autoUpdater.autoInstallOnAppQuit = true;
        // Allow downgrade if needed (false by default)
        // autoUpdater.allowDowngrade = false;

        // Forward events to renderer
        autoUpdater.on('checking-for-update', () => {
            log.info('[UpdateService] checking-for-update');
            this._sendStatus({ state: 'checking', message: 'Checking for updates...' });
        });

        autoUpdater.on('update-available', (info) => {
            log.info('[UpdateService] update-available:', info.version);
            this.lastCheckResult = { available: true, version: info.version, info };
            this.pendingVersion = info.version;
            this.isDownloading = false;
            this.isUpdateDownloaded = false;
            this._sendStatus({
                state: 'available',
                version: info.version,
                releaseNotes: info.releaseNotes,
                releaseName: info.releaseName,
                message: `Update available: v${info.version}`
            });
        });

        autoUpdater.on('update-not-available', (info) => {
            log.info('[UpdateService] update-not-available:', info.version);
            this.lastCheckResult = { available: false, version: info.version, info };
            this._sendStatus({
                state: 'not-available',
                version: info.version,
                currentVersion: app.getVersion(),
                message: `You're on the latest version (v${app.getVersion()})`
            });
        });

        autoUpdater.on('download-progress', (progress) => {
            this.downloadProgress = progress;
            this.isDownloading = true;
            const percent = Math.round(progress.percent);
            log.info(`[UpdateService] download-progress: ${percent}%`);
            this._sendStatus({
                state: 'downloading',
                percent,
                bytesPerSecond: progress.bytesPerSecond,
                transferred: progress.transferred,
                total: progress.total,
                message: `Downloading ${percent}%`
            });
        });

        autoUpdater.on('update-downloaded', (info) => {
            log.info('[UpdateService] update-downloaded:', info.version);
            this.isDownloading = false;
            this.isUpdateDownloaded = true;
            this.pendingVersion = info.version;
            this._sendStatus({
                state: 'downloaded',
                version: info.version,
                message: `Update v${info.version} ready - restart to install`
            });
        });

        autoUpdater.on('error', (err) => {
            log.error('[UpdateService] error:', err);
            this.isDownloading = false;
            // Try fallback GitHub check to give user at least a link
            this._sendStatus({
                state: 'error',
                message: err?.message || 'Update check failed',
                error: String(err)
            });
        });

        this.isInitialized = true;

        // Initial check after 3s (window ready)
        setTimeout(() => this.checkForUpdates(false), 3000);

        // Periodic check
        this.intervalId = setInterval(() => this.checkForUpdates(true), this.autoCheckIntervalMs);
        // Don't keep process alive just for this interval
        if (this.intervalId && this.intervalId.unref) this.intervalId.unref();

        log.info('[UpdateService] initialized');
    }

    _sendStatus(payload) {
        try {
            if (this.mainWindow && !this.mainWindow.isDestroyed()) {
                this.mainWindow.webContents.send('update:status', payload);
            }
        } catch (e) {
            log.warn('[UpdateService] _sendStatus failed:', e.message);
        }
    }

    getCurrentVersion() {
        return app.getVersion();
    }

    /**
     * Fallback: Direct GitHub API check (works in dev too, and if autoUpdater fails).
     * Compares latest release tag vs current version using semver.
     */
    async checkViaGitHubApi() {
        try {
            const axios = require('axios');
            const res = await axios.get('https://api.github.com/repos/hazrarijit/local-vcs/releases/latest', {
                headers: { 'Accept': 'application/vnd.github.v3+json' },
                timeout: 8000
            });
            const tag = (res.data.tag_name || '').replace(/^v/, '');
            const current = this.getCurrentVersion();
            const hasUpdate = semver.valid(tag) && semver.valid(current) ? semver.gt(tag, current) : tag !== current;
            return {
                source: 'github-api',
                available: hasUpdate,
                version: tag,
                currentVersion: current,
                htmlUrl: res.data.html_url,
                name: res.data.name,
                body: res.data.body,
                publishedAt: res.data.published_at
            };
        } catch (e) {
            log.warn('[UpdateService] GitHub API check failed:', e.message);
            return { source: 'github-api', available: false, error: e.message, currentVersion: this.getCurrentVersion() };
        }
    }

    /**
     * Trigger update check.
     * @param {boolean} silent - if true, don't send 'checking' if already downloaded
     */
    async checkForUpdates(silent = false) {
        const currentVersion = this.getCurrentVersion();

        // Already downloaded - just notify renderer
        if (this.isUpdateDownloaded && this.pendingVersion) {
            this._sendStatus({
                state: 'downloaded',
                version: this.pendingVersion,
                message: `Update v${this.pendingVersion} ready - restart to install`
            });
            return { success: true, state: 'downloaded', version: this.pendingVersion, currentVersion };
        }

        if (!autoUpdater || !app.isPackaged) {
            // Fallback to GitHub API (also useful in dev for testing UI)
            if (!silent) this._sendStatus({ state: 'checking', message: 'Checking for updates...' });
            const apiResult = await this.checkViaGitHubApi();
            if (apiResult.available) {
                this.lastCheckResult = { available: true, version: apiResult.version, info: apiResult };
                this.pendingVersion = apiResult.version;
                this._sendStatus({
                    state: 'available',
                    version: apiResult.version,
                    htmlUrl: apiResult.htmlUrl,
                    releaseNotes: apiResult.body,
                    message: `Update available: v${apiResult.version}`,
                    fallback: true
                });
                return { success: true, state: 'available', version: apiResult.version, currentVersion, fallback: true, htmlUrl: apiResult.htmlUrl };
            } else if (apiResult.error) {
                this._sendStatus({ state: 'error', message: apiResult.error });
                return { success: false, state: 'error', message: apiResult.error, currentVersion };
            } else {
                this.lastCheckResult = { available: false, version: apiResult.version, info: apiResult };
                this._sendStatus({ state: 'not-available', version: currentVersion, currentVersion, message: `You're on the latest version (v${currentVersion})` });
                return { success: true, state: 'not-available', version: currentVersion, currentVersion };
            }
        }

        try {
            if (!silent) {
                // autoUpdater will emit 'checking-for-update' itself, but ensure UI feedback
            }
            const result = await autoUpdater.checkForUpdates();
            // checkForUpdates returns UpdateCheckResult; events will notify renderer
            // Provide immediate response too
            if (result && result.updateInfo) {
                const available = semver.gt(result.updateInfo.version, currentVersion);
                return {
                    success: true,
                    state: available ? 'available' : 'not-available',
                    version: result.updateInfo.version,
                    currentVersion,
                    updateInfo: result.updateInfo
                };
            }
            return { success: true, state: 'checking', currentVersion };
        } catch (err) {
            log.error('[UpdateService] checkForUpdates failed:', err);
            // Fallback to API
            const apiResult = await this.checkViaGitHubApi();
            if (apiResult.available) {
                this._sendStatus({
                    state: 'available',
                    version: apiResult.version,
                    htmlUrl: apiResult.htmlUrl,
                    releaseNotes: apiResult.body,
                    message: `Update available: v${apiResult.version}`,
                    fallback: true
                });
                return { success: true, state: 'available', version: apiResult.version, currentVersion, fallback: true, htmlUrl: apiResult.htmlUrl };
            }
            this._sendStatus({ state: 'error', message: err.message || String(err) });
            return { success: false, state: 'error', message: err.message || String(err), currentVersion };
        }
    }

    async downloadUpdate() {
        if (!autoUpdater || !app.isPackaged) {
            // In dev/fallback mode, just open browser
            const apiResult = await this.checkViaGitHubApi();
            if (apiResult.htmlUrl) {
                const { shell } = require('electron');
                await shell.openExternal(apiResult.htmlUrl);
                return { success: true, fallback: true, htmlUrl: apiResult.htmlUrl, message: 'Opened releases page in browser' };
            }
            return { success: false, message: 'Download not available in dev mode. Use packaged build.' };
        }

        if (this.isDownloading) {
            return { success: false, message: 'Already downloading...' };
        }
        if (this.isUpdateDownloaded) {
            return { success: true, state: 'downloaded', version: this.pendingVersion, message: 'Update already downloaded' };
        }

        try {
            this.isDownloading = true;
            await autoUpdater.downloadUpdate();
            // 'update-downloaded' event will fire; but return immediate ack
            return { success: true, state: 'downloading', message: 'Downloading started' };
        } catch (err) {
            this.isDownloading = false;
            log.error('[UpdateService] downloadUpdate failed:', err);
            this._sendStatus({ state: 'error', message: err.message || String(err) });
            return { success: false, message: err.message || String(err) };
        }
    }

    quitAndInstall() {
        if (!autoUpdater || !app.isPackaged) {
            return { success: false, message: 'Not available in dev mode' };
        }
        if (!this.isUpdateDownloaded) {
            return { success: false, message: 'No update downloaded yet' };
        }
        // AutoUpdater will quit and install
        setTimeout(() => autoUpdater.quitAndInstall(), 300);
        return { success: true, message: 'Installing...' };
    }

    getStatus() {
        return {
            currentVersion: this.getCurrentVersion(),
            isPackaged: app.isPackaged,
            lastCheckResult: this.lastCheckResult,
            isDownloading: this.isDownloading,
            isUpdateDownloaded: this.isUpdateDownloaded,
            pendingVersion: this.pendingVersion,
            downloadProgress: this.downloadProgress
        };
    }

    destroy() {
        if (this.intervalId) {
            clearInterval(this.intervalId);
            this.intervalId = null;
        }
        if (autoUpdater) {
            autoUpdater.removeAllListeners();
        }
    }
}

module.exports = UpdateService;
