/**
 * tracking.service.js - File Tracking Engine (optimized for large bases)
 *
 * Detects added, modified, and deleted files by comparing
 * current filesystem state against stored metadata.
 * Optimizations:
 *  - Prunes ignored directories early using SyncIgnore semantics (no wasted traversal)
 *  - Iterative BFS walk with configurable depth and yield-to-event-loop
 *  - mtime + size fast-path before hashing
 *  - Concurrent hashing with limited parallelism (keeps disk/ Electron responsive)
 *  - Async deleted-check (no sync blocking)
 *  - Progress-friendly and memory efficient
 */

const fs = require('fs-extra');
const path = require('path');
const chokidar = require('chokidar');
const { hashFile } = require('../utils/hashing');
const SyncIgnoreService = require('./syncignore.service');

// Tuning constants for large repositories
const DEFAULT_DEPTH_LIMIT = 25;
const YIELD_EVERY_N_DIRS = 200;
const HASH_CONCURRENCY = 8; // parallel hash operations
const STAT_CONCURRENCY = 20;
const LARGE_FILE_THRESHOLD = 50 * 1024 * 1024; // 50MB - use size+mtime heuristic for super-large, skip hash unless needed

class TrackingService {
    constructor(projectService) {
        this.projectService = projectService;
        this.syncIgnore = new SyncIgnoreService();
        this.watchers = new Map();
        this.changeCallbacks = new Map();
    }

    /**
     * Scan a project for file changes - optimized for arbitrary file base sizes
     * @param {string} projectId
     * @param {object} opts - { onProgress?: (processed, totalHint) => void }
     * @returns {Promise<object>} - { added: [], modified: [], deleted: [] }
     */
    async scanForChanges(projectId, opts = {}) {
        const project = await this.projectService.getProject(projectId);
        if (!project) return { added: [], modified: [], deleted: [] };

        const metadata = await this.projectService.getMetadata(projectId);
        if (!metadata) return { added: [], modified: [], deleted: [] };

        // Load ignore rules (fresh)
        this.syncIgnore.load(project.folderPath);

        // Get current files on disk using pruned walk
        const currentFiles = await this._getAllFiles(project.folderPath);
        // Walk already prunes directories, but file-level ignores like *.log still need filtering
        // Use Set for deduplication and fast lookup
        const trackedSet = new Set();
        const trackedFiles = [];
        for (const p of currentFiles) {
            if (!this.syncIgnore.isIgnored(p)) {
                trackedSet.add(p);
                trackedFiles.push(p);
            }
        }

        const storedFiles = metadata.files || {};
        const storedSet = new Set(Object.keys(storedFiles));
        const changes = { added: [], modified: [], deleted: [] };

        // Build list of paths that need stat/hash checks
        // Fast-path: added files are those not in storedSet
        // For existing files, we need stat first
        const candidates = trackedFiles; // includes added + possibly modified

        // Batch stat phase with concurrency limit to avoid EMFILE and keep responsive
        const statResults = new Map(); // path -> stat or null
        await this._pooledMap(candidates, STAT_CONCURRENCY, async (relativePath) => {
            const absolutePath = path.join(project.folderPath, relativePath);
            try {
                const stat = await fs.stat(absolutePath);
                if (!stat.isFile()) {
                    statResults.set(relativePath, null);
                    return;
                }
                statResults.set(relativePath, stat);
            } catch {
                statResults.set(relativePath, null);
            }
        });

        // Separate added vs potentially-modified
        const toHash = []; // { relativePath, stat, storedEntry }
        for (const relativePath of trackedFiles) {
            const stat = statResults.get(relativePath);
            if (!stat) continue;
            const storedEntry = storedFiles[relativePath];
            if (!storedEntry) {
                changes.added.push({
                    path: relativePath,
                    name: path.basename(relativePath),
                    dir: path.dirname(relativePath),
                    size: stat.size,
                    lastModified: stat.mtime.toISOString()
                });
            } else {
                // fast-path: size + mtime check (both must match to skip hash)
                const currentMtime = stat.mtime.getTime();
                const storedMtime = storedEntry.lastMtime;
                const storedSize = storedEntry.size;
                if (storedMtime !== undefined && storedSize !== undefined && currentMtime === storedMtime && stat.size === storedSize) {
                    continue; // unchanged
                }
                // Also if size differs, we know it's modified without hashing, but we still want newHash for completeness? We can report without hash or with lazy hash.
                // For correctness we hash to confirm; size diff implies modified even if mtime collided.
                // Super-large files: if > LARGE_FILE_THRESHOLD and mtime/size changed, report modified without hashing to avoid heavy I/O, unless size is small diff?
                if (stat.size > LARGE_FILE_THRESHOLD) {
                    // For huge files, use size+mtime as change signal directly, avoid reading full file
                    if (stat.size !== storedSize || currentMtime !== storedMtime) {
                        changes.modified.push({
                            path: relativePath,
                            name: path.basename(relativePath),
                            dir: path.dirname(relativePath),
                            size: stat.size,
                            lastModified: stat.mtime.toISOString(),
                            oldHash: storedEntry.hash,
                            newHash: storedEntry.hash // placeholder, will be updated on stage
                        });
                        continue;
                    }
                }
                toHash.push({ relativePath, stat, storedEntry });
            }
            // Yield periodically when building
            if (toHash.length % 100 === 0) await this._yield();
        }

        // Hash remaining candidates with limited concurrency and yield between batches
        // We do hashed verification only for potentially modified files
        await this._pooledMap(toHash, HASH_CONCURRENCY, async ({ relativePath, stat, storedEntry }) => {
            const absolutePath = path.join(project.folderPath, relativePath);
            try {
                const currentHash = await hashFile(absolutePath);
                if (currentHash !== storedEntry.hash) {
                    changes.modified.push({
                        path: relativePath,
                        name: path.basename(relativePath),
                        dir: path.dirname(relativePath),
                        size: stat.size,
                        lastModified: stat.mtime.toISOString(),
                        oldHash: storedEntry.hash,
                        newHash: currentHash
                    });
                }
            } catch (err) {
                console.error(`Error hashing file: ${relativePath}`, err.message);
                // If hashing failed (locked/large), fallback to size/mtime based modified report
                if (stat.size !== storedEntry.size || stat.mtime.getTime() !== storedEntry.lastMtime) {
                    changes.modified.push({
                        path: relativePath,
                        name: path.basename(relativePath),
                        dir: path.dirname(relativePath),
                        size: stat.size,
                        lastModified: stat.mtime.toISOString(),
                        oldHash: storedEntry.hash,
                        newHash: storedEntry.hash
                    });
                }
            }
        });

        // Deleted detection: stored paths not in trackedSet and not on disk
        // Use async checks with pooling rather than sync existsSync loop
        const storedPaths = Object.keys(storedFiles);
        const maybeDeleted = storedPaths.filter(p => !trackedSet.has(p));
        await this._pooledMap(maybeDeleted, STAT_CONCURRENCY, async (storedPath) => {
            const absolutePath = path.join(project.folderPath, storedPath);
            try {
                const exists = await fs.pathExists(absolutePath);
                if (!exists) {
                    changes.deleted.push({
                        path: storedPath,
                        name: path.basename(storedPath),
                        dir: path.dirname(storedPath),
                        oldHash: storedFiles[storedPath].hash,
                        lastModified: storedFiles[storedPath].lastModified
                    });
                } else {
                    // Exists but was filtered as ignored => treat as not deleted; if ignored, we intentionally hide it
                    // No action
                }
            } catch {
                // assume deleted if error
            }
        });

        return changes;
    }

    async startWatching(projectId, onChange) {
        const project = await this.projectService.getProject(projectId);
        if (!project) return;
        this.stopWatching(projectId);
        this.syncIgnore.load(project.folderPath);

        // Build chokidar ignored handlers that respect .syncignore plus defaults
        const ignoredHandler = (absPath) => {
            try {
                const rel = path.relative(project.folderPath, absPath);
                if (!rel || rel === '.' ) return false;
                // Always ignore .file-sync internals
                if (rel === '.file-sync' || rel.startsWith('.file-sync/') || rel.startsWith('.file-sync\\')) return true;
                // Use syncIgnore for directory/file check; but avoid calling for every file inside pruned dirs by checking dir prefix quickly
                // Also avoid ignoring the project root itself
                // For performance, do a quick check for .git/node_modules etc. but allow syncignore to override
                const base = path.basename(absPath);
                if (base === 'node_modules' || base === '.git' || base === '.svn') return true;
                // Let syncIgnore decide for files; directories that canPrune are also ignored
                // Note: chokidar expects function returning true to ignore
                // We normalize separators
                const norm = rel.replace(/\\/g, '/');
                // If path is a directory and canPrune, ignore entire subtree
                // We need to know if it's dir; fs stat would be expensive here, so just check via ignore patterns that match with suffix
                // Simplify: check isIgnored for files, and for dirs check isIgnoredDir/canPrune
                // Since we don't know isDir in this callback, we check both
                if (this.syncIgnore.isIgnored(norm)) return true;
                // Also check if any parent dir is prunable
                const parts = norm.split('/');
                let accum = '';
                for (let i = 0; i < parts.length - 1; i++) {
                    accum = accum ? accum + '/' + parts[i] : parts[i];
                    if (this.syncIgnore.canPruneDir(accum)) return true;
                }
                return false;
            } catch {
                return false;
            }
        };

        const ignoredList = [
            ignoredHandler,
            path.join(project.folderPath, '.file-sync', '**'),
        ];

        const watcher = chokidar.watch(project.folderPath, {
            ignored: ignoredList,
            persistent: true,
            ignoreInitial: true,
            awaitWriteFinish: { stabilityThreshold: 500, pollInterval: 100 },
            depth: DEFAULT_DEPTH_LIMIT,
            ignorePermissionErrors: true,
            usePolling: false
        });

        let debounceTimer = null;
        const debouncedNotify = (eventType, filePath) => {
            const relativePath = path.relative(project.folderPath, filePath);
            if (!relativePath || relativePath.startsWith('.file-sync')) return;
            if (this.syncIgnore.isIgnored(relativePath)) return;
            clearTimeout(debounceTimer);
            debounceTimer = setTimeout(() => {
                if (onChange) onChange(projectId, eventType, relativePath);
            }, 300);
        };

        watcher.on('add', (fp) => debouncedNotify('add', fp))
            .on('change', (fp) => debouncedNotify('change', fp))
            .on('unlink', (fp) => debouncedNotify('unlink', fp));

        this.watchers.set(projectId, watcher);
        this.changeCallbacks.set(projectId, onChange);
    }

    stopWatching(projectId) {
        const watcher = this.watchers.get(projectId);
        if (watcher) {
            watcher.close();
            this.watchers.delete(projectId);
            this.changeCallbacks.delete(projectId);
        }
    }

    stopAll() {
        for (const [id] of this.watchers) this.stopWatching(id);
    }

    /**
     * Fast walk: iterative BFS/DFS with early pruning, depth limit, and periodic yielding
     * Returns array of relative file paths
     */
    async _getAllFiles(rootDir, base = rootDir, maxDepth = DEFAULT_DEPTH_LIMIT) {
        const results = [];
        const stack = [{ dir: rootDir, depth: 0 }];
        let processedDirs = 0;

        while (stack.length > 0) {
            const { dir, depth } = stack.pop();
            if (depth > maxDepth) continue;

            // Check if this directory itself should be pruned (skip descending)
            const relDir = path.relative(base, dir).replace(/\\/g, '/');
            if (relDir && relDir !== '.' ) {
                // Normalize empty vs '.'
                const norm = relDir === '' ? '' : relDir;
                if (norm && this.syncIgnore.canPruneDir(norm)) {
                    continue;
                }
                if (norm && this.syncIgnore.isIgnoredDir(norm)) {
                    // If directory is ignored but canPrune is false (meaning negated child could exist), we still need to descend but filter files later.
                    // To avoid traversing huge ignored dirs that contain negation wildcard (rare), we still descend but this is safe.
                    // However if pattern is "vendor/" and we are in vendor, isIgnoredDir true and canPruneDir true means we already continued above.
                }
            }

            let entries;
            try {
                entries = await fs.readdir(dir, { withFileTypes: true });
            } catch (err) {
                continue;
            }

            for (const entry of entries) {
                const fullPath = path.join(dir, entry.name);
                const relativePath = path.relative(base, fullPath).replace(/\\/g, '/');

                // Quick skip for dotfiles at root level already handled by ignore but keep fast path
                // Hidden file handling now delegated to syncignore; remove hard-coded vendor skip unless prune says to?
                // Keep hard skips for truly heavy standard dirs to avoid unnecessary regex, but still allow .syncignore to override? Those dirs are almost always ignored anyway.
                if (entry.isDirectory()) {
                    // Early prune check for this child dir before pushing
                    if (this.syncIgnore.canPruneDir(relativePath)) {
                        continue;
                    }
                    // Also skip known heavy dirs instantly without regex if not already pruned (performance)
                    // Note: if user has negated them via !node_modules/keep, canPruneDir would have returned false so we descend
                    const hardIgnores = ['node_modules', '.git', '.file-sync', '.svn', '__pycache__'];
                    if (hardIgnores.includes(entry.name) && !relativePath.includes('/')) {
                        // At root level skip unless negation could include
                        let negated = false;
                        for (const pat of this.syncIgnore.patterns) {
                            if (pat.isNegation && pat.normalized.includes(entry.name)) { negated = true; break; }
                        }
                        if (!negated) continue;
                    }
                    stack.push({ dir: fullPath, depth: depth + 1 });
                } else if (entry.isFile()) {
                    // Symlinks etc: we treat as file if not directory; exclude special file names that are definitely ignored?
                    results.push(relativePath);
                } else {
                    // Could be symlink, socket, etc. - attempt to stat to see if it's file-like
                    try {
                        const st = await fs.stat(fullPath);
                        if (st.isFile()) results.push(relativePath);
                    } catch { /* ignore */ }
                }
            }

            processedDirs++;
            if (processedDirs % YIELD_EVERY_N_DIRS === 0) {
                await this._yield();
            }
        }

        return results;
    }

    async getChangeSummary(projectId) {
        const changes = await this.scanForChanges(projectId);
        return {
            total: changes.added.length + changes.modified.length + changes.deleted.length,
            added: changes.added.length,
            modified: changes.modified.length,
            deleted: changes.deleted.length
        };
    }

    // --- helpers ---

    async _yield() {
        return new Promise(r => setImmediate(r));
    }

    /**
     * Process items with limited concurrency
     * @param {Array} items
     * @param {number} concurrency
     * @param {Function} worker - async (item, index) => void
     */
    async _pooledMap(items, concurrency, worker) {
        if (!items || items.length === 0) return;
        const limit = Math.max(1, Math.min(concurrency, items.length));
        let idx = 0;
        const run = async () => {
            while (true) {
                const current = idx++;
                if (current >= items.length) break;
                try {
                    await worker(items[current], current);
                } catch (e) {
                    console.error('pooledMap worker error', e.message);
                }
                // periodic yield to keep event loop breathing
                if (current % 100 === 0) await this._yield();
            }
        };
        const workers = Array.from({ length: limit }, () => run());
        await Promise.all(workers);
    }
}

module.exports = TrackingService;
