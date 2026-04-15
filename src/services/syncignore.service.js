/**
 * syncignore.service.js - .syncignore File Parser
 * 
 * Parses .syncignore files (similar to .gitignore) and provides
 * pattern matching to determine if a file should be ignored.
 */

const fs = require('fs-extra');
const path = require('path');

class SyncIgnoreService {
    constructor() {
        this.patterns = [];
        this.rawRules = [];
    }

    _normalizePath(value) {
        return String(value || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
    }

    /**
     * Load and parse a .syncignore file
     * @param {string} projectRoot - Root directory of the project
     */
    load(projectRoot) {
        const ignorePath = path.join(projectRoot, '.syncignore');
        this.patterns = [];
        this.rawRules = [];

        // Default ignores (always applied)
        const defaults = [
            '.file-sync',
            '.file-sync/**',
            'node_modules',
            'node_modules/**',
            '.git',
            '.git/**',
            '.DS_Store',
            'Thumbs.db',
            '*.log'
        ];

        defaults.forEach(p => this._addPattern(p));

        if (fs.existsSync(ignorePath)) {
            const content = fs.readFileSync(ignorePath, 'utf8');
            const lines = content.split(/\r?\n/);

            for (let line of lines) {
                line = line.trim();
                // Skip empty lines and comments
                if (!line || line.startsWith('#')) continue;
                this._addPattern(line);
                this.rawRules.push(line);
            }
        }
    }

    /**
     * Add a pattern to the ignore list
     * @param {string} pattern - Glob-like pattern
     */
    _addPattern(pattern) {
        const isNegation = pattern.startsWith('!');
        const cleanPattern = this._normalizePath(isNegation ? pattern.substring(1) : pattern);
        const isPlainPath = cleanPattern.length > 0 && !/[?*]/.test(cleanPattern);
        const isDirectoryRule = pattern.endsWith('/') || isPlainPath;

        // Convert glob pattern to regex
        const regex = this._globToRegex(cleanPattern);

        this.patterns.push({
            original: pattern,
            regex,
            isNegation,
            isDirectory: isDirectoryRule,
            normalized: cleanPattern
        });
    }

    /**
     * Convert a glob-like pattern to a RegExp
     * Supports: *, **, ?, specific extensions, directory patterns
     * @param {string} glob
     * @returns {RegExp}
     */
    _globToRegex(glob) {
        if (!glob) {
            return /^$/;
        }

        // Remove trailing slash for directory patterns
        let pattern = glob.replace(/\/$/, '');

        // Escape regex special characters (except * and ?)
        pattern = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');

        // Convert glob patterns to regex
        pattern = pattern.replace(/\*\*/g, '{{GLOBSTAR}}');
        pattern = pattern.replace(/\*/g, '[^/]*');
        pattern = pattern.replace(/\?/g, '[^/]');
        pattern = pattern.replace(/\{\{GLOBSTAR\}\}/g, '.*');

        // Match from start or after a separator
        return new RegExp(`(^|/)${pattern}($|/)`, 'i');
    }

    /**
     * Check if a relative file path should be ignored
     * @param {string} relativePath - File path relative to project root
     * @returns {boolean} - true if file should be ignored
     */
    isIgnored(relativePath) {
        // Normalize path separators to forward slashes
        const normalizedPath = this._normalizePath(relativePath);

        let ignored = false;

        for (const pattern of this.patterns) {
            if (this._matchesPattern(pattern, normalizedPath)) {
                ignored = !pattern.isNegation;
            }
        }

        return ignored;
    }

    _matchesPattern(pattern, normalizedPath) {
        if (!normalizedPath) {
            return false;
        }

        if (pattern.isDirectory) {
            return normalizedPath === pattern.normalized || normalizedPath.startsWith(`${pattern.normalized}/`) || pattern.regex.test(normalizedPath);
        }

        return pattern.regex.test(normalizedPath);
    }

    /**
     * Filter an array of relative paths, removing ignored ones
     * @param {string[]} filePaths
     * @returns {string[]} - Non-ignored file paths
     */
    filter(filePaths) {
        return filePaths.filter(fp => !this.isIgnored(fp));
    }

    /**
     * Get the raw rules loaded from .syncignore
     * @returns {string[]}
     */
    getRules() {
        return this.rawRules;
    }
}

module.exports = SyncIgnoreService;
