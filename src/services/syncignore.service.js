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
        this.projectRoot = null;
    }

    _normalizePath(value) {
        return String(value || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
    }

    /**
     * Default ignore patterns for new projects
     */
    static get DEFAULT_PATTERNS() {
        return [
            // Folders to ignore
            'vendor/',
            'storage/',
            'bootstrap/cache/',
            'public/',
            '.idea/',
            '.file-sync/',
            '.git/',
            '.vscode/',
            // File types to ignore
            '*.log',
            '*.zip',            
            // System files
            '.DS_Store',
            'Thumbs.db'
        ];
    }

    /**
     * Create the default .syncignore file at project root
     * @param {string} projectRoot - Root directory of the project
     */
    createDefaultIgnoreFile(projectRoot) {
        const ignorePath = path.join(projectRoot, '.syncignore');

        // Don't overwrite if file already exists
        if (fs.existsSync(ignorePath)) {
            return false;
        }

        const defaultContent = `# .syncignore - Patterns for files to ignore during sync
# https://docs.example.com/syncignore

# Ignore entire folders
vendor/
storage/
bootstrap/cache/
public/
.idea/
.file-sync/
.git/
.vscode/

# Ignore specific file types
*.log
*.zip

# Ignore uploaded temp folders
public/uploads/temp/

# Include specific files (negation patterns)
!.env
!.mcp.json
!.syncignore
!.gitignore
`;

        fs.writeFileSync(ignorePath, defaultContent, 'utf8');
        return true;
    }

    /**
     * Load and parse a .syncignore file
     * Always starts fresh - clears previous patterns before loading
     * @param {string} projectRoot - Root directory of the project
     */
    load(projectRoot) {
        const ignorePath = path.join(projectRoot, '.syncignore');
        this.projectRoot = projectRoot;

        // ALWAYS reset - ensures reload with new ignore options doesn't hold old changes
        this.patterns = [];
        this.rawRules = [];

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
     * Reload the ignore file - useful when .syncignore has been modified externally
     * Ensures fresh state without holding onto previous patterns
     * @param {string} projectRoot - Root directory of the project
     */
    reload(projectRoot) {
        // load() already resets patterns each time
        this.load(projectRoot);
    }

    /**
     * Get the path to the .syncignore file for a project
     * @param {string} projectRoot - Root directory of the project
     * @returns {string}
     */
    static getIgnorePath(projectRoot) {
        return path.join(projectRoot, '.syncignore');
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
