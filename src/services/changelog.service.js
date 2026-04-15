/**
 * changelog.service.js - Change Log System
 * 
 * Records every sync or manual save with:
 * - Timestamp
 * - Changed files (with type: add/update/delete)
 * - Version IDs
 * - Sync message
 */

const fs = require('fs-extra');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { generateVersionId } = require('../utils/hashing');
const JsonStore = require('../utils/store');

class ChangelogService {
    constructor() {
        this.store = new JsonStore('changelogs.json');
    }

    /**
     * Add a log entry for a sync operation
     * @param {string} projectId
     * @param {object} logData - { message, files, totalFiles, failedFiles? }
     * @returns {object} - The created log entry
     */
    async addLog(projectId, logData) {
        const logs = this.store.get(projectId, []);

        const entry = {
            id: uuidv4(),
            versionId: generateVersionId(),
            timestamp: new Date().toISOString(),
            message: logData.message || 'File sync',
            files: (logData.files || []).map(f => ({
                path: f.path,
                name: path.basename(f.path),
                type: f.type // 'add', 'update', 'delete'
            })),
            totalFiles: logData.totalFiles || 0,
            failedFiles: logData.failedFiles || 0,
            status: (logData.failedFiles || 0) === 0 ? 'success' : 'partial'
        };

        // Prepend (most recent first)
        logs.unshift(entry);

        // Keep last 500 logs per project
        if (logs.length > 500) {
            logs.splice(500);
        }

        this.store.set(projectId, logs);

        return entry;
    }

    /**
     * Get logs for a project
     * @param {string} projectId
     * @param {number} limit - Max number of logs to return
     * @param {number} offset - Offset for pagination
     * @returns {object[]}
     */
    getLogs(projectId, limit = 50, offset = 0) {
        const logs = this.store.get(projectId, []);
        return logs.slice(offset, offset + limit);
    }

    /**
     * Get a single log entry
     * @param {string} projectId
     * @param {string} logId
     * @returns {object|null}
     */
    getLog(projectId, logId) {
        const logs = this.store.get(projectId, []);
        return logs.find(l => l.id === logId) || null;
    }

    /**
     * Search logs by message
     * @param {string} projectId
     * @param {string} query
     * @returns {object[]}
     */
    searchLogs(projectId, query) {
        const logs = this.store.get(projectId, []);
        const lowerQuery = query.toLowerCase();
        return logs.filter(l =>
            l.message.toLowerCase().includes(lowerQuery) ||
            l.versionId.includes(lowerQuery) ||
            l.files.some(f => f.path.toLowerCase().includes(lowerQuery))
        );
    }

    /**
     * Get total log count for a project
     * @param {string} projectId
     * @returns {number}
     */
    getLogCount(projectId) {
        return this.store.get(projectId, []).length;
    }

    /**
     * Clear all logs for a project
     * @param {string} projectId
     */
    clearLogs(projectId) {
        this.store.set(projectId, []);
    }
}

module.exports = ChangelogService;
