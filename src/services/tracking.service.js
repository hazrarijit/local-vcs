/**
 * tracking.service.js - File Tracking Engine
 * 
 * Detects added, modified, and deleted files by comparing
 * current filesystem state against stored metadata.
 * Uses hash comparison first (fast), then provides data for diff.
 * Includes chokidar file watcher for real-time detection.
 */

const fs = require('fs-extra');
const path = require('path');
const chokidar = require('chokidar');
const { hashFile } = require('../utils/hashing');
const SyncIgnoreService = require('./syncignore.service');

class TrackingService {
    constructor(projectService) {
        this.projectService = projectService;
        this.syncIgnore = new SyncIgnoreService();
        this.watchers = new Map(); // projectId -> chokidar.FSWatcher
        this.changeCallbacks = new Map(); // projectId -> callback function
    }

    /**
     * Scan a project for file changes
     * @param {string} projectId
     * @returns {Promise<object>} - { added: [], modified: [], deleted: [] }
     */
    async scanForChanges(projectId) {
        const project = this.projectService.getProject(projectId);
        if (!project) {
            return { added: [], modified: [], deleted: [] };
        }

        const metadata = await this.projectService.getMetadata(projectId);
        if (!metadata) {
            return { added: [], modified: [], deleted: [] };
        }

        // Load ignore rules
        this.syncIgnore.load(project.folderPath);

        // Get current files on disk
        const currentFiles = await this._getAllFiles(project.folderPath);
        const trackedFiles = this.syncIgnore.filter(currentFiles);

        const storedFiles = metadata.files || {};
        const changes = { added: [], modified: [], deleted: [] };

        // Check for added and modified files
        for (const relativePath of trackedFiles) {
            const absolutePath = path.join(project.folderPath, relativePath);

            try {
                const stat = await fs.stat(absolutePath);
                if (!stat.isFile()) continue;

                if (!(relativePath in storedFiles)) {
                    // New file - not in metadata
                    changes.added.push({
                        path: relativePath,
                        name: path.basename(relativePath),
                        dir: path.dirname(relativePath),
                        size: stat.size,
                        lastModified: stat.mtime.toISOString()
                    });
                } else {
                    // File exists in metadata - check if modified via hash
                    const currentHash = await hashFile(absolutePath);

                    if (currentHash !== storedFiles[relativePath].hash) {
                        changes.modified.push({
                            path: relativePath,
                            name: path.basename(relativePath),
                            dir: path.dirname(relativePath),
                            size: stat.size,
                            lastModified: stat.mtime.toISOString(),
                            oldHash: storedFiles[relativePath].hash,
                            newHash: currentHash
                        });
                    }
                }
            } catch (err) {
                console.error(`Error scanning file: ${relativePath}`, err.message);
            }
        }

        // Check for deleted files
        for (const storedPath of Object.keys(storedFiles)) {
            const absolutePath = path.join(project.folderPath, storedPath);
            if (!fs.existsSync(absolutePath)) {
                changes.deleted.push({
                    path: storedPath,
                    name: path.basename(storedPath),
                    dir: path.dirname(storedPath),
                    oldHash: storedFiles[storedPath].hash,
                    lastModified: storedFiles[storedPath].lastModified
                });
            }
        }

        return changes;
    }

    /**
     * Start watching a project directory for real-time changes
     * @param {string} projectId
     * @param {function} onChange - Callback when changes detected: (projectId, eventType, filePath) => void
     */
    startWatching(projectId, onChange) {
        const project = this.projectService.getProject(projectId);
        if (!project) return;

        // Stop existing watcher if any
        this.stopWatching(projectId);

        this.syncIgnore.load(project.folderPath);

        const ignored = [
            path.join(project.folderPath, '.file-sync', '**'),
            path.join(project.folderPath, 'node_modules', '**'),
            path.join(project.folderPath, '.git', '**'),
            /[/\\]\./  // Hidden files/directories
        ];

        const watcher = chokidar.watch(project.folderPath, {
            ignored,
            persistent: true,
            ignoreInitial: true,
            awaitWriteFinish: {
                stabilityThreshold: 500,
                pollInterval: 100
            },
            depth: 20
        });

        // Debounce change notifications
        let debounceTimer = null;
        const debouncedNotify = (eventType, filePath) => {
            const relativePath = path.relative(project.folderPath, filePath);

            // Extra check against syncignore
            if (this.syncIgnore.isIgnored(relativePath)) return;

            clearTimeout(debounceTimer);
            debounceTimer = setTimeout(() => {
                if (onChange) onChange(projectId, eventType, relativePath);
            }, 300);
        };

        watcher
            .on('add', (fp) => debouncedNotify('add', fp))
            .on('change', (fp) => debouncedNotify('change', fp))
            .on('unlink', (fp) => debouncedNotify('unlink', fp));

        this.watchers.set(projectId, watcher);
        this.changeCallbacks.set(projectId, onChange);
    }

    /**
     * Stop watching a project
     * @param {string} projectId
     */
    stopWatching(projectId) {
        const watcher = this.watchers.get(projectId);
        if (watcher) {
            watcher.close();
            this.watchers.delete(projectId);
            this.changeCallbacks.delete(projectId);
        }
    }

    /**
     * Stop all watchers
     */
    stopAll() {
        for (const [id] of this.watchers) {
            this.stopWatching(id);
        }
    }

    /**
     * Recursively get all files in a directory
     * @param {string} dir
     * @param {string} base
     * @returns {Promise<string[]>}
     */
    async _getAllFiles(dir, base = dir) {
        const results = [];

        try {
            const entries = await fs.readdir(dir, { withFileTypes: true });

            for (const entry of entries) {
                const fullPath = path.join(dir, entry.name);
                const relativePath = path.relative(base, fullPath);

                if (entry.isDirectory()) {
                    if (['node_modules', '.git', '.file-sync', '.svn', 'vendor', '__pycache__'].includes(entry.name)) {
                        continue;
                    }
                    const subFiles = await this._getAllFiles(fullPath, base);
                    results.push(...subFiles);
                } else {
                    results.push(relativePath);
                }
            }
        } catch (err) {
            console.error(`Error reading directory: ${dir}`, err.message);
        }

        return results;
    }

    /**
     * Get summary of changes (counts)
     * @param {string} projectId
     * @returns {Promise<object>} - { total, added, modified, deleted }
     */
    async getChangeSummary(projectId) {
        const changes = await this.scanForChanges(projectId);
        return {
            total: changes.added.length + changes.modified.length + changes.deleted.length,
            added: changes.added.length,
            modified: changes.modified.length,
            deleted: changes.deleted.length
        };
    }
}

module.exports = TrackingService;
