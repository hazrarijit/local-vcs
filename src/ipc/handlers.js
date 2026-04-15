/**
 * handlers.js - IPC Channel Handler Registration
 * 
 * Registers all IPC handlers that bridge the Electron main process
 * with the renderer process. Each handler maps to a service method.
 */

const { ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs-extra');

const AuthService = require('../services/auth.service');
const ProjectService = require('../services/project.service');
const TrackingService = require('../services/tracking.service');
const DiffService = require('../services/diff.service');
const SyncService = require('../services/sync.service');
const ChangelogService = require('../services/changelog.service');
const SyncIgnoreService = require('../services/syncignore.service');

let authService, projectService, trackingService, diffService, syncService, changelogService;
let mainWindow = null;

function registerHandlers(win) {
    mainWindow = win;

    // Initialize services
    authService = new AuthService();
    projectService = new ProjectService();
    trackingService = new TrackingService(projectService);
    diffService = new DiffService(projectService);
    changelogService = new ChangelogService();
    syncService = new SyncService(projectService, changelogService);

    // ========================
    // AUTH HANDLERS
    // ========================

    ipcMain.handle('auth:register', async (event, userData) => {
        return await authService.register(userData);
    });

    ipcMain.handle('auth:login', async (event, identifier, password) => {
        return await authService.login(identifier, password);
    });

    ipcMain.handle('auth:session', async () => {
        return authService.getSession();
    });

    ipcMain.handle('auth:logout', async () => {
        return authService.logout();
    });

    ipcMain.handle('auth:hasUsers', async () => {
        return authService.hasUsers();
    });

    ipcMain.handle('auth:updateProfile', async (event, userId, updates) => {
        return authService.updateProfile(userId, updates);
    });

    // ========================
    // PROJECT HANDLERS
    // ========================

    ipcMain.handle('project:create', async (event, projectData) => {
        return await projectService.createProject(projectData);
    });

    ipcMain.handle('project:getAll', async () => {
        return projectService.getProjects();
    });

    ipcMain.handle('project:get', async (event, projectId) => {
        return projectService.getProject(projectId);
    });

    ipcMain.handle('project:update', async (event, projectId, updates) => {
        return projectService.updateProject(projectId, updates);
    });

    ipcMain.handle('project:delete', async (event, projectId, removeSyncDir) => {
        return await projectService.deleteProject(projectId, removeSyncDir);
    });

    ipcMain.handle('project:getMetadata', async (event, projectId) => {
        return await projectService.getMetadata(projectId);
    });

    ipcMain.handle('project:selectFolder', async () => {
        const result = await dialog.showOpenDialog(mainWindow, {
            properties: ['openDirectory'],
            title: 'Select Project Folder'
        });
        if (result.canceled) return null;
        return result.filePaths[0];
    });

    // ========================
    // TRACKING HANDLERS
    // ========================

    ipcMain.handle('tracking:scan', async (event, projectId) => {
        return await trackingService.scanForChanges(projectId);
    });

    ipcMain.handle('tracking:summary', async (event, projectId) => {
        return await trackingService.getChangeSummary(projectId);
    });

    ipcMain.handle('tracking:startWatch', async (event, projectId) => {
        trackingService.startWatching(projectId, (pid, eventType, filePath) => {
            // Notify renderer process of file changes
            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('tracking:fileChanged', {
                    projectId: pid,
                    eventType,
                    filePath
                });
            }
        });
        return { success: true };
    });

    ipcMain.handle('tracking:stopWatch', async (event, projectId) => {
        trackingService.stopWatching(projectId);
        return { success: true };
    });

    // ========================
    // DIFF HANDLERS
    // ========================

    ipcMain.handle('diff:compute', async (event, projectId, relativePath) => {
        return await diffService.computeDiff(projectId, relativePath);
    });

    ipcMain.handle('diff:newFile', async (event, projectId, relativePath) => {
        return await diffService.computeNewFileDiff(projectId, relativePath);
    });

    ipcMain.handle('diff:deletedFile', async (event, projectId, relativePath) => {
        return await diffService.computeDeletedFileDiff(projectId, relativePath);
    });

    // ========================
    // SYNC HANDLERS
    // ========================

    ipcMain.handle('sync:testConnection', async (event, remoteUrl) => {
        return await syncService.testConnection(remoteUrl);
    });

    ipcMain.handle('sync:file', async (event, projectId, relativePath, changeType) => {
        return await syncService.syncFile(projectId, relativePath, changeType);
    });

    ipcMain.handle('sync:batch', async (event, projectId, files, syncMessage) => {
        return await syncService.stageAndDeploy(projectId, files, syncMessage, (current, total, file) => {
            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('sync:progress', { current, total, file });
            }
        });
    });

    // ========================
    // STAGING HANDLERS
    // ========================

    ipcMain.handle('staging:stage', async (event, projectId, files) => {
        return await projectService.stageFiles(projectId, files);
    });

    ipcMain.handle('staging:getStaged', async (event, projectId) => {
        return await projectService.getStagedFiles(projectId);
    });

    ipcMain.handle('staging:deploy', async (event, projectId, files, syncMessage) => {
        return await syncService.deployStagedFiles(projectId, files, syncMessage, (current, total, file) => {
            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('sync:progress', { current, total, file });
            }
        });
    });

    ipcMain.handle('staging:markDeployed', async (event, projectId, filePaths) => {
        try {
            await projectService.markFilesDeployed(projectId, filePaths);
            return { success: true, marked: filePaths.length, message: `Marked ${filePaths.length} file(s) as deployed.` };
        } catch (err) {
            return { success: false, message: err.message };
        }
    });

    // ========================
    // CHANGELOG HANDLERS
    // ========================

    ipcMain.handle('changelog:getLogs', async (event, projectId, limit, offset) => {
        return changelogService.getLogs(projectId, limit, offset);
    });

    ipcMain.handle('changelog:search', async (event, projectId, query) => {
        return changelogService.searchLogs(projectId, query);
    });

    ipcMain.handle('changelog:count', async (event, projectId) => {
        return changelogService.getLogCount(projectId);
    });

    // ========================
    // FILE CONTEXT MENU HANDLERS
    // ========================

    ipcMain.handle('file:discard', async (event, projectId, relativePath, changeType) => {
        try {
            const project = projectService.getProject(projectId);
            if (!project) return { success: false, message: 'Project not found.' };

            const absolutePath = path.join(project.folderPath, relativePath);

            if (changeType === 'add') {
                // New file — remove it
                if (fs.existsSync(absolutePath)) {
                    await fs.remove(absolutePath);
                }
                return { success: true, message: 'New file removed.' };
            }

            // Modified or Deleted — restore from stored encrypted copy
            const storedContent = await projectService.getStoredFileContent(projectId, relativePath);
            if (storedContent === null) {
                return { success: false, message: 'No stored version found for this file.' };
            }

            // Ensure parent directory exists (for deleted files)
            await fs.ensureDir(path.dirname(absolutePath));
            await fs.writeFile(absolutePath, storedContent, 'utf8');

            return { success: true, message: 'File restored to stored version.' };
        } catch (err) {
            return { success: false, message: err.message };
        }
    });

    ipcMain.handle('file:ignore', async (event, projectId, relativePath) => {
        try {
            const project = projectService.getProject(projectId);
            if (!project) return { success: false, message: 'Project not found.' };

            const ignorePath = path.join(project.folderPath, '.syncignore');

            // Normalize to forward slashes for consistency
            const normalizedPath = relativePath.replace(/\\/g, '/');

            // Read existing content or start fresh
            let content = '';
            if (fs.existsSync(ignorePath)) {
                content = await fs.readFile(ignorePath, 'utf8');
            }

            // Check if already ignored
            const lines = content.split(/\r?\n/);
            if (lines.some(l => l.trim() === normalizedPath)) {
                return { success: true, message: 'File is already in .syncignore.' };
            }

            // Append the path
            const separator = content.length > 0 && !content.endsWith('\n') ? '\n' : '';
            await fs.appendFile(ignorePath, `${separator}${normalizedPath}\n`, 'utf8');

            return { success: true, message: `Added to .syncignore: ${normalizedPath}` };
        } catch (err) {
            return { success: false, message: err.message };
        }
    });

    ipcMain.handle('file:openLocation', async (event, projectId, relativePath) => {
        try {
            const project = projectService.getProject(projectId);
            if (!project) return { success: false, message: 'Project not found.' };

            const absolutePath = path.join(project.folderPath, relativePath);
            shell.showItemInFolder(absolutePath);
            return { success: true };
        } catch (err) {
            return { success: false, message: err.message };
        }
    });

    // ========================
    // UTILITY HANDLERS
    // ========================

    ipcMain.handle('util:readFile', async (event, filePath) => {
        try {
            return await fs.readFile(filePath, 'utf8');
        } catch {
            return null;
        }
    });

    ipcMain.handle('util:fileExists', async (event, filePath) => {
        return fs.existsSync(filePath);
    });

    ipcMain.handle('util:getFileTree', async (event, projectId) => {
        const project = projectService.getProject(projectId);
        if (!project) return null;

        const ignoreService = new SyncIgnoreService();
        ignoreService.load(project.folderPath);

        return await buildFileTree(project.folderPath, project.folderPath, ignoreService);
    });

    // ========================
    // PHP FILE DOWNLOAD
    // ========================

    ipcMain.handle('util:downloadPhpFile', async () => {
        const result = await dialog.showSaveDialog(mainWindow, {
            title: 'Save sync-ftp.php',
            defaultPath: 'sync-ftp.php',
            filters: [{ name: 'PHP Files', extensions: ['php'] }]
        });

        if (result.canceled || !result.filePath) return { success: false };

        try {
            const sourcePath = path.join(__dirname, '..', '..', 'server', 'sync-ftp.php');
            await fs.copy(sourcePath, result.filePath);
            return { success: true, path: result.filePath };
        } catch (err) {
            return { success: false, message: err.message };
        }
    });
}

/**
 * Build a recursive file tree structure for the explorer panel
 */
async function buildFileTree(dir, rootDir, ignoreService, depth = 0) {
    if (depth > 10) return []; // Safety limit

    const entries = await fs.readdir(dir, { withFileTypes: true });
    const tree = [];

    // Sort: directories first, then files, alphabetically
    const sorted = entries.sort((a, b) => {
        if (a.isDirectory() && !b.isDirectory()) return -1;
        if (!a.isDirectory() && b.isDirectory()) return 1;
        return a.name.localeCompare(b.name);
    });

    for (const entry of sorted) {
        const fullPath = path.join(dir, entry.name);
        const relativePath = path.relative(rootDir, fullPath);

        if (ignoreService.isIgnored(relativePath)) continue;

        if (entry.isDirectory()) {
            const children = await buildFileTree(fullPath, rootDir, ignoreService, depth + 1);
            tree.push({
                name: entry.name,
                path: relativePath,
                isDirectory: true,
                children
            });
        } else {
            const ext = path.extname(entry.name).toLowerCase();
            tree.push({
                name: entry.name,
                path: relativePath,
                isDirectory: false,
                extension: ext
            });
        }
    }

    return tree;
}

function cleanup() {
    if (trackingService) {
        trackingService.stopAll();
    }
}

module.exports = { registerHandlers, cleanup };
