/**
 * sync.service.js - Remote Server Sync Service
 * 
 * Handles file synchronization to a remote PHP server via HTTP POST.
 * Supports single and batch file sync, connection testing, and retry logic.
 */

const fs = require('fs-extra');
const path = require('path');
const axios = require('axios');
const { hashFile, generateVersionId } = require('../utils/hashing');

const SECURE_KEY = 'SYNCVCS_SECURE_KEY_2024'; // Should match PHP server key
const REQUEST_TIMEOUT = 30000; // 30 seconds

class SyncService {
    constructor(projectService, changelogService) {
        this.projectService = projectService;
        this.changelogService = changelogService;
    }

    /**
     * Test connection to the remote server
     * @param {string} remoteUrl
     * @returns {Promise<object>} - { success, message, latency? }
     */
    async testConnection(remoteUrl) {
        if (!remoteUrl) {
            return { success: false, message: 'Remote URL is required.' };
        }

        try {
            const startTime = Date.now();
            const url = `${remoteUrl.replace(/\/$/, '')}/sync-ftp.php?action=connect&key=${encodeURIComponent(SECURE_KEY)}`;

            const response = await axios.get(url, {
                timeout: REQUEST_TIMEOUT,
                validateStatus: () => true
            });

            const latency = Date.now() - startTime;

            if (response.data && response.data.status === 'success') {
                return {
                    success: true,
                    message: 'Connection established successfully.',
                    latency: `${latency}ms`
                };
            }

            return {
                success: false,
                message: response.data?.message || 'Connection failed. Invalid server response.'
            };
        } catch (err) {
            return {
                success: false,
                message: `Connection failed: ${err.message}`
            };
        }
    }

    /**
     * Sync a single file to the remote server
     * @param {string} projectId
     * @param {string} relativePath
     * @param {string} changeType - 'add', 'update', or 'delete'
     * @returns {Promise<object>}
     */
    async syncFile(projectId, relativePath, changeType = 'update') {
        const project = this.projectService.getProject(projectId);
        if (!project) {
            return { success: false, message: 'Project not found.' };
        }

        if (!project.remoteUrl) {
            return { success: false, message: 'No remote URL configured for this project.' };
        }

        try {
            const url = `${project.remoteUrl.replace(/\/$/, '')}/sync-ftp.php?action=sync-file`;

            let fileData = '';
            if (changeType !== 'delete') {
                const absolutePath = path.join(project.folderPath, relativePath);
                if (!await fs.pathExists(absolutePath)) {
                    return { success: false, message: `File not found: ${relativePath}` };
                }
                const content = await fs.readFile(absolutePath);
                fileData = content.toString('base64');
            }

            const payload = {
                key: SECURE_KEY,
                file_path: relativePath.replace(/\\/g, '/'),
                file_data: fileData,
                action_type: changeType
            };

            const response = await axios.post(url, payload, {
                timeout: REQUEST_TIMEOUT,
                headers: { 'Content-Type': 'application/json' },
                maxContentLength: Infinity,
                maxBodyLength: Infinity
            });

            if (response.data && response.data.status === 'success') {
                return {
                    success: true,
                    message: `File synced: ${relativePath}`,
                    file: relativePath
                };
            }

            return {
                success: false,
                message: response.data?.message || 'Sync failed. Server returned error.'
            };
        } catch (err) {
            const detail = err.response?.data?.message || err.message;
            return {
                success: false,
                message: `Sync failed: ${detail}`
            };
        }
    }

    /**
     * Deploy staged files to the server.
     * Flow: Stage files locally → Send to server → Mark as deployed
     * @param {string} projectId
     * @param {object[]} files - Array of { path, type: 'add'|'update'|'delete' }
     * @param {string} syncMessage - Description of this sync
     * @param {function} onProgress - Progress callback: (current, total, file) => void
     * @returns {Promise<object>}
     */
    async deployStagedFiles(projectId, files, syncMessage = '', onProgress = null) {
        const results = {
            total: files.length,
            succeeded: 0,
            failed: 0,
            errors: [],
            files: [],
            deployed: []
        };

        for (let i = 0; i < files.length; i++) {
            const file = files[i];

            if (onProgress) {
                onProgress(i + 1, files.length, file.path);
            }

            const result = await this.syncFile(projectId, file.path, file.type);

            if (result.success) {
                results.succeeded++;
                results.deployed.push(file.path);
                results.files.push({ path: file.path, type: file.type, status: 'success' });
            } else {
                results.failed++;
                results.errors.push({ path: file.path, error: result.message });
                results.files.push({ path: file.path, type: file.type, status: 'failed', error: result.message });
            }
        }

        // Mark successfully deployed files
        if (results.deployed.length > 0) {
            await this.projectService.markFilesDeployed(projectId, results.deployed);
        }

        // Log the sync operation
        if (this.changelogService && results.succeeded > 0) {
            await this.changelogService.addLog(projectId, {
                message: syncMessage || 'Deployed to server',
                files: results.files.filter(f => f.status === 'success'),
                totalFiles: results.succeeded,
                failedFiles: results.failed
            });
        }

        // Update project's lastSyncAt
        if (results.succeeded > 0) {
            const projects = this.projectService.getProjects();
            const idx = projects.findIndex(p => p.id === projectId);
            if (idx !== -1) {
                projects[idx].lastSyncAt = new Date().toISOString();
                const JsonStore = require('../utils/store');
                const store = new JsonStore('projects.json');
                store.set('projects', projects);
            }
        }

        return {
            success: results.failed === 0,
            message: `Deployed ${results.succeeded}/${results.total} files to server.`,
            ...results
        };
    }

    /**
     * Stage + Deploy in one operation (the "Deploy To Server" button flow)
     */
    async stageAndDeploy(projectId, files, syncMessage = '', onProgress = null) {
        // Step 1: Stage all files locally
        const stageResult = await this.projectService.stageFiles(projectId, files);
        if (!stageResult.success) {
            return { success: false, message: stageResult.message };
        }

        // Step 2: Deploy staged files to server
        return await this.deployStagedFiles(projectId, files, syncMessage, onProgress);
    }
}

module.exports = SyncService;
