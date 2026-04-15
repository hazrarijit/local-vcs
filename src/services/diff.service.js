/**
 * diff.service.js - File Diff Engine
 * 
 * Computes line-by-line diffs between the stored encrypted version
 * and the current file on disk. Outputs structured diff data for
 * the side-by-side diff viewer.
 */

const fs = require('fs-extra');
const path = require('path');
const Diff = require('diff');

class DiffService {
    constructor(projectService) {
        this.projectService = projectService;
    }

    /**
     * Compute diff between stored and current version of a file
     * @param {string} projectId
     * @param {string} relativePath
     * @returns {Promise<object>} - Structured diff data
     */
    async computeDiff(projectId, relativePath) {
        const project = this.projectService.getProject(projectId);
        if (!project) {
            return { error: 'Project not found.' };
        }

        const absolutePath = path.join(project.folderPath, relativePath);

        // Get stored (old) content
        let oldContent = '';
        const storedContent = await this.projectService.getStoredFileContent(projectId, relativePath);
        if (storedContent !== null) {
            oldContent = storedContent;
        }

        // Get current (new) content
        let newContent = '';
        if (fs.existsSync(absolutePath)) {
            newContent = await fs.readFile(absolutePath, 'utf8');
        }

        // Compute the diff
        return this._buildDiff(oldContent, newContent, relativePath);
    }

    /**
     * Build structured diff output for the UI
     * @param {string} oldText - Original content  
     * @param {string} newText - Modified content
     * @param {string} filePath - File name for display
     * @returns {object} - { fileName, additions, deletions, hunks }
     */
    _buildDiff(oldText, newText, filePath) {
        const changes = Diff.diffLines(oldText, newText);

        let additions = 0;
        let deletions = 0;
        const oldLines = [];
        const newLines = [];
        let oldLineNum = 1;
        let newLineNum = 1;

        for (const part of changes) {
            const lines = part.value.replace(/\n$/, '').split('\n');

            if (part.added) {
                // Lines only in new version
                additions += lines.length;
                for (const line of lines) {
                    oldLines.push({ num: '', code: '', type: 'empty' });
                    newLines.push({ num: newLineNum++, code: line, type: 'add' });
                }
            } else if (part.removed) {
                // Lines only in old version
                deletions += lines.length;
                for (const line of lines) {
                    oldLines.push({ num: oldLineNum++, code: line, type: 'rem' });
                    newLines.push({ num: '', code: '', type: 'empty' });
                }
            } else {
                // Unchanged lines
                for (const line of lines) {
                    oldLines.push({ num: oldLineNum++, code: line, type: '' });
                    newLines.push({ num: newLineNum++, code: line, type: '' });
                }
            }
        }

        return {
            fileName: path.basename(filePath),
            filePath,
            additions,
            deletions,
            totalChanges: additions + deletions,
            oldLines,
            newLines,
            isNewFile: oldText === '',
            isDeletedFile: newText === ''
        };
    }

    /**
     * Compute diff for a deleted file (everything is removed)
     * @param {string} projectId
     * @param {string} relativePath
     * @returns {Promise<object>}
     */
    async computeDeletedFileDiff(projectId, relativePath) {
        const storedContent = await this.projectService.getStoredFileContent(projectId, relativePath);
        return this._buildDiff(storedContent || '', '', relativePath);
    }

    /**
     * Compute diff for a new file (everything is added)
     * @param {string} projectId
     * @param {string} relativePath
     * @returns {Promise<object>}
     */
    async computeNewFileDiff(projectId, relativePath) {
        const project = this.projectService.getProject(projectId);
        if (!project) return { error: 'Project not found.' };

        const absolutePath = path.join(project.folderPath, relativePath);
        let newContent = '';
        if (fs.existsSync(absolutePath)) {
            newContent = await fs.readFile(absolutePath, 'utf8');
        }

        return this._buildDiff('', newContent, relativePath);
    }

    /**
     * Get a quick text-based diff summary (for logs)
     * @param {string} oldText
     * @param {string} newText
     * @returns {string}
     */
    getTextDiff(oldText, newText) {
        const patch = Diff.createPatch('file', oldText, newText);
        return patch;
    }
}

module.exports = DiffService;
