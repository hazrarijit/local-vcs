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
        const projects = this.store.get('projects', []);
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
        this.store.set('projects', projects);

        // Initialize .file-sync directory
        await this._initializeSyncDir(project);

        return { success: true, message: 'Project created and initialized.', project };
    }

    /**
     * Initialize the .file-sync/ directory with encrypted copies and metadata
     * @param {object} project
     */
    async _initializeSyncDir(project) {
        const syncDir = path.join(project.folderPath, SYNC_DIR);
        const filesDir = path.join(syncDir, FILES_DIR);
        const metadataPath = path.join(syncDir, METADATA_FILE);

        // Create directories
        await fs.ensureDir(filesDir);

        // Load .syncignore
        this.syncIgnore.load(project.folderPath);

        // Scan all files
        const allFiles = await this._getAllFiles(project.folderPath);
        const trackedFiles = this.syncIgnore.filter(allFiles);

        const metadata = {
            projectId: project.id,
            projectName: project.name,
            createdAt: new Date().toISOString(),
            lastScanAt: new Date().toISOString(),
            files: {}
        };

        // Process each file: hash, encrypt, store
        for (const relativePath of trackedFiles) {
            const absolutePath = path.join(project.folderPath, relativePath);

            try {
                const stat = await fs.stat(absolutePath);
                if (!stat.isFile()) continue;

                const fileHash = await hashFile(absolutePath);
                const versionId = generateVersionId();

                // Read and encrypt the file
                const fileContent = await fs.readFile(absolutePath);
                const encrypted = this.encryption.encrypt(fileContent);

                // Store encrypted file with hash-based name
                const encryptedFileName = hashData(relativePath) + '.enc';
                const encryptedFilePath = path.join(filesDir, encryptedFileName);
                await fs.writeFile(encryptedFilePath, encrypted);

                // Store metadata
                metadata.files[relativePath] = {
                    hash: fileHash,
                    lastModified: stat.mtime.toISOString(),
                    size: stat.size,
                    versionId,
                    encryptedFile: encryptedFileName,
                    trackedSince: new Date().toISOString()
                };
            } catch (err) {
                console.error(`Failed to process file: ${relativePath}`, err.message);
            }
        }

        // Write metadata
        await fs.writeJson(metadataPath, metadata, { spaces: 2 });
    }

    /**
     * Recursively get all files in a directory (relative paths)
     * @param {string} dir - Root directory
     * @param {string} base - Base for relative path calculation
     * @returns {Promise<string[]>}
     */
    async _getAllFiles(dir, base = dir) {
        const results = [];
        const entries = await fs.readdir(dir, { withFileTypes: true });

        for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);
            const relativePath = path.relative(base, fullPath);

            if (entry.isDirectory()) {
                // Quick skip for known heavy dirs
                if (['node_modules', '.git', '.file-sync', '.svn', 'vendor'].includes(entry.name)) {
                    continue;
                }
                const subFiles = await this._getAllFiles(fullPath, base);
                results.push(...subFiles);
            } else {
                results.push(relativePath);
            }
        }

        return results;
    }

    /**
     * Get all registered projects
     * @returns {object[]}
     */
    getProjects() {
        return this.store.get('projects', []);
    }

    /**
     * Get a project by ID
     * @param {string} projectId
     * @returns {object|null}
     */
    getProject(projectId) {
        const projects = this.getProjects();
        return projects.find(p => p.id === projectId) || null;
    }

    /**
     * Update project details
     * @param {string} projectId
     * @param {object} updates
     * @returns {object}
     */
    updateProject(projectId, updates) {
        const projects = this.getProjects();
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

        this.store.set('projects', projects);
        return { success: true, message: 'Project updated.', project: projects[idx] };
    }

    /**
     * Delete a project (removes from store, optionally removes .file-sync/)
     * @param {string} projectId
     * @param {boolean} removeSyncDir
     * @returns {object}
     */
    async deleteProject(projectId, removeSyncDir = false) {
        const projects = this.getProjects();
        const project = projects.find(p => p.id === projectId);
        if (!project) {
            return { success: false, message: 'Project not found.' };
        }

        if (removeSyncDir) {
            const syncDir = path.join(project.folderPath, SYNC_DIR);
            await fs.remove(syncDir);
        }

        const filtered = projects.filter(p => p.id !== projectId);
        this.store.set('projects', filtered);

        return { success: true, message: 'Project removed.' };
    }

    /**
     * Get the metadata for a project's tracked files
     * @param {string} projectId
     * @returns {object|null}
     */
    async getMetadata(projectId) {
        const project = this.getProject(projectId);
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
        const project = this.getProject(projectId);
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

        await fs.writeJson(metadataPath, metadata, { spaces: 2 });
    }

    /**
     * Re-encrypt and update the stored copy of a file
     * @param {string} projectId
     * @param {string} relativePath
     */
    async updateStoredFile(projectId, relativePath) {
        const project = this.getProject(projectId);
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
        const project = this.getProject(projectId);
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
        const project = this.getProject(projectId);
        if (!project) return { success: false, message: 'Project not found.' };

        const metadataPath = path.join(project.folderPath, SYNC_DIR, METADATA_FILE);
        const metadata = await fs.readJson(metadataPath);
        const filesDir = path.join(project.folderPath, SYNC_DIR, FILES_DIR);
        let staged = 0;

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
                if (!fs.existsSync(absolutePath)) continue;

                const stat = await fs.stat(absolutePath);
                const fileHash = await hashFile(absolutePath);
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
            }
        }

        metadata.lastScanAt = new Date().toISOString();
        await fs.writeJson(metadataPath, metadata, { spaces: 2 });

        return { success: true, staged, message: `Staged ${staged} file(s).` };
    }

    /**
     * Get files that have been staged but not yet deployed to the remote server.
     * @param {string} projectId
     * @returns {Promise<object[]>}
     */
    async getStagedFiles(projectId) {
        const project = this.getProject(projectId);
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
        const project = this.getProject(projectId);
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

        await fs.writeJson(metadataPath, metadata, { spaces: 2 });
    }
}

module.exports = ProjectService;
