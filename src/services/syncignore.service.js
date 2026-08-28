/**
 * syncignore.service.js - .syncignore File Parser
 *
 * Implements gitignore-compatible matching with high accuracy and
 * fast directory-pruning support for large repositories.
 *
 * Spec summary (matching gitignore):
 *  - '#'  comment unless escaped
 *  - '!'  negation (re-include) when first char unescaped
 *  - trailing ' ' trimmed unless escaped
 *  - trailing '/'  => directory-only: matches dir and everything under it
 *  - leading '/'   => anchored to project root
 *  - pattern containing '/' (excluding trailing) => anchored path match
 *  - pattern without '/' => matches basename at any depth
 *  - '*', '?', '**' wildcards ( ** matches any depth incl. empty )
 */

const fs = require('fs-extra');
const path = require('path');

class SyncIgnoreService {
    constructor() {
        this.patterns = []; // compiled patterns in order
        this.rawRules = [];
        this.projectRoot = null;
    }

    _normalizePath(value) {
        return String(value || '').replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '');
        // Keep empty for root; caller decides trailing handling
    }

    _normalizeForMatch(value) {
        return String(value || '').replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '');
    }

    static get DEFAULT_PATTERNS() {
        return [
            'vendor/',
            'storage/',
            'bootstrap/cache/',
            'public/',
            '.idea/',
            '.file-sync/',
            '.git/',
            '.vscode/',
            '*.log',
            '*.zip',
            '.DS_Store',
            'Thumbs.db'
        ];
    }

    createDefaultIgnoreFile(projectRoot) {
        const ignorePath = path.join(projectRoot, '.syncignore');
        if (fs.existsSync(ignorePath)) return false;
        const defaultContent = `# ========================
# .syncignore - SyncVCS Ignore File
# ========================
# Similar to .gitignore — defines files and folders
# that should NOT be tracked or synced.
#
# Patterns:
#   *       → matches any characters (except /)
#   **      → matches any path (including /)
#   ?       → matches a single character
#   !file   → negation (re-include a previously ignored pattern)
#   public  → ignores the public folder and everything inside it
#   folder/ → also matches a directory
#
# Lines starting with # are comments
# Blank lines are ignored
# ========================

# --- Version Control ---
.git
.svn
.hg

# --- Package Managers ---
node_modules
vendor
bower_components

# --- Build Outputs ---
dist
build
out
.next
.nuxt

# --- IDE / Editor ---
.idea
.vscode
*.swp
*.swo
*~
.project
.settings

# --- OS Generated ---
.DS_Store
Thumbs.db
desktop.ini
ehthumbs.db

# --- Logs ---
*.log
npm-debug.log*
yarn-debug.log*
yarn-error.log*

# --- Environment ---
.env
.env.local
.env.*.local

# --- Compiled Files ---
*.pyc
*.pyo
*.class
*.o
*.obj

# --- Temporary Files ---
*.tmp
*.temp
*.bak
*.backup

# --- Archives ---
*.zip
*.tar.gz
*.rar
*.7z

# --- Cache ---
.cache
__pycache__
*.cache

# --- SyncVCS Internal ---
.file-sync
`;
        try {
            fs.ensureDirSync(path.dirname(ignorePath));
            fs.writeFileSync(ignorePath, defaultContent, 'utf8');
        } catch (err) {
            console.error(`Failed to create .syncignore at ${ignorePath}:`, err.message);
            throw err;
        }
        return true;
    }

    /**
     * Ensure a .syncignore file exists; create with basic defaults if missing.
     * Used during project initialization before the .file-sync encryption scan
     * so ignored files are never encrypted/stored.
     * @param {string} projectRoot
     * @returns {boolean} true if created, false if already existed
     */
    ensureDefaultIgnoreFile(projectRoot) {
        return this.createDefaultIgnoreFile(projectRoot);
    }

    load(projectRoot) {
        const ignorePath = path.join(projectRoot, '.syncignore');
        this.projectRoot = projectRoot;
        this.patterns = [];
        this.rawRules = [];
        if (fs.existsSync(ignorePath)) {
            const content = fs.readFileSync(ignorePath, 'utf8');
            const lines = content.split(/\r?\n/);
            for (const rawLine of lines) {
                const parsed = this._parseLine(rawLine);
                if (parsed === null) continue;
                this._addPattern(parsed);
                this.rawRules.push(parsed.originalRaw);
            }
        }
    }

    reload(projectRoot) {
        this.load(projectRoot);
    }

    static getIgnorePath(projectRoot) {
        return path.join(projectRoot, '.syncignore');
    }

    /**
     * Parse a raw line from .syncignore.
     * Returns null for ignored (comment/blank) lines, otherwise { originalRaw, pattern, isNegation }.
     */
    _parseLine(rawLine) {
        if (rawLine === null || rawLine === undefined) return null;
        // Preserve raw for display except we trim trailing \r
        let line = String(rawLine);
        // Remove trailing \r already split, handle.
        // Trim trailing spaces unless escaped with backslash (gitignore behavior)
        // Count trailing backslashes vs spaces: simplify — trim unescaped trailing spaces
        // Detect escaped trailing spaces: ends with '\ ' -> keep space
        let trimmed = line;
        // Blank lines are ignored
        if (!trimmed.trim()) return null;

        // Leading spaces are significant? gitignore: leading spaces trimmed unless escaped.
        // For simplicity, trim leading/trailing for detection but preserve escaped markers
        // Check if line (after trimming leading spaces) starts with # or !
        // Escaped \# or \! should be treated as literal pattern
        let leftTrimmed = line.replace(/^\s+/, '');
        if (!leftTrimmed) return null;

        // Escaped comment: \#
        if (leftTrimmed.startsWith('\\#') || leftTrimmed.startsWith('\\!')) {
            // pattern starts with literal # or !
            // remove the escaping backslash
            const pattern = leftTrimmed.substring(1);
            // Trim unescaped trailing spaces
            const final = this._trimTrailingSpaces(pattern);
            if (!final) return null;
            return { originalRaw: line.trim(), pattern: final, isNegation: false, escaped: true };
        }

        if (leftTrimmed.startsWith('#')) return null;

        let isNegation = false;
        let pattern = leftTrimmed;

        if (pattern.startsWith('!')) {
            isNegation = true;
            pattern = pattern.substring(1);
            // After '!', an empty line means ignore? Skip
            if (!pattern) return null;
            // If negation was escaped (we already handled \# but not \! inside?) already handled.
        }

        // Trim trailing spaces that are not escaped with backslash
        pattern = this._trimTrailingSpaces(pattern);
        if (!pattern) return null;

        // Unescape escaped spaces at end: "\ " -> " "
        pattern = pattern.replace(/\\ /g, ' ');

        return { originalRaw: line.trim(), pattern, isNegation, escaped: false };
    }

    _trimTrailingSpaces(pattern) {
        // Remove trailing spaces unless last space is escaped with backslash
        // Iterate from end counting spaces that are not escaped
        let end = pattern.length;
        while (end > 0 && pattern[end - 1] === ' ') {
            // Check if this space is escaped: count preceding backslashes
            let bsCount = 0;
            let idx = end - 2;
            while (idx >= 0 && pattern[idx] === '\\') { bsCount++; idx--; }
            if (bsCount % 2 === 1) break; // escaped -> keep
            end--;
        }
        return pattern.substring(0, end);
    }

    _addPattern(parsed) {
        const { pattern, isNegation } = parsed;
        // Remember whether original had leading slash for anchoring
        const hasLeadingSlash = pattern.startsWith('/');
        // Determine directory-only from trailing slash before normalization
        const isDirectoryOnly = pattern.endsWith('/') && pattern.length > 1 || pattern === '/';

        // Normalize for regex compilation (strip leading and trailing slashes)
        let normalized = pattern.replace(/^\/+/, '').replace(/\/+$/, '');
        // Empty after stripping slashes (i.e., pattern was "/") -> ignore
        if (!normalized && !isDirectoryOnly) {
            // pattern like "/" is degenerate; skip
            return;
        }
        if (!normalized && isDirectoryOnly) {
            // unlikely; skip
            return;
        }

        // Determine anchoring: gitignore says pattern containing '/' (except trailing) is anchored
        // Also leading '/' anchors
        const containsSlash = normalized.includes('/');
        const anchored = hasLeadingSlash || containsSlash;

        const regex = this._compileGlob(normalized, { isDirectoryOnly, anchored });

        // For pruning, keep normalized prefix (without glob) if possible
        // Compute literal prefix before first wildcard for fast pruning checks
        const literalPrefix = normalized.split(/[*?]/)[0].replace(/\/+$/, '');

        this.patterns.push({
            original: parsed.originalRaw,
            normalized,
            regex,
            isNegation,
            isDirectoryOnly,
            anchored,
            literalPrefix
        });
    }

    /**
     * Convert glob pattern to RegExp respecting anchoring and directory semantics.
     */
    _compileGlob(glob, { isDirectoryOnly, anchored }) {
        if (!glob) return /^$/;

        // Escape regex special chars except * ? / and we handle ** separately
        // We'll use placeholders for ** to avoid double-escaping *
        const GLOBSTAR = '__GLOBSTAR__';
        const GLOBSTAR_SLASH = '__GLOBSTAR_SLASH__';

        // Protect **/ and /** and ** patterns before escaping
        // Replace "**/" -> special
        let pattern = glob;
        pattern = pattern.replace(/\*\*\//g, GLOBSTAR_SLASH);
        pattern = pattern.replace(/\/\*\*/g, '/__GLOBSTAR_TRAILING__');
        pattern = pattern.replace(/\*\*/g, GLOBSTAR);

        // Now escape regex specials (except * ? which we will handle, and our placeholders)
        pattern = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');

        // Convert remaining single * and ? (not part of **) BEFORE restoring globstar placeholders
        // Placeholders don't contain * or ?, so they survive this step
        pattern = pattern.replace(/\*/g, '[^/]*');
        pattern = pattern.replace(/\?/g, '[^/]');

        // Restore and convert placeholders (final step — contains * but won't be re-escaped)
        pattern = pattern.replace(new RegExp(GLOBSTAR_SLASH, 'g'), '(?:.*\\/)?');
        pattern = pattern.replace(/\/__GLOBSTAR_TRAILING__/g, '(?:\\/.*)?');
        pattern = pattern.replace(new RegExp(GLOBSTAR, 'g'), '.*');

        // Handle anchoring and directory semantics
        // For directory-only patterns, they imply matching the directory itself and everything beneath
        // We treat directory match as pattern + (/$ or /.*)
        // For file patterns, they match that file/dir path segment exactly per anchoring rules
        let regexStr;
        if (anchored) {
            // Anchored to root: must match from start
            if (isDirectoryOnly) {
                // e.g., "vendor/" or "a/b/" -> ^vendor(?:/.*)?$
                regexStr = `^${pattern}(?:\\/.*)?$`;
            } else {
                // Pattern with slash, strict path: e.g., "src/*.js" -> ^src/[^/]*\.js(?:/.*)? but files only at that location
                // Also allow matching exactly the pattern, or as prefix for descendants if pattern is a directory path without trailing slash?
                // For gitignore, "a/b" without slash matches file OR directory "a/b" and would not match "a/b/c" unless directory. But we treat non-directory anchored pattern as:
                // - exact file match
                // - OR inside directory: pattern is a file glob anchored at that position, not parent. So we should NOT allow /.* suffix for non-directory file globs.
                // However patterns like "public" (plain without / but anchored? Actually "public" contains no slash, so not anchored per our rule; but "vendor" is considered not anchoredbasename, not anchored). Need branch.
                // For anchored file pattern containing slash (e.g., "a/b/*.txt"), we match anchored path only: ^pattern$
                // But also if pattern is like "a/b" (no wildcard, no dir flag), should it match descendants "a/b/c"? In gitignore, plain path without wildcards and without slash? Let's unify:
                // If pattern is anchored and not directory-only:
                //   If it contains a wildcard, treat as file pattern anchored: ^pattern$
                //   If it is a plain path (no wildcard), treat as match path or prefix: ^pattern(?:/.*)?$
                // So we need to know if plain.
                const hasWildcard = /[*?]/.test(glob);
                if (hasWildcard) {
                    regexStr = `^${pattern}$`;
                } else {
                    // plain anchored path like "public/uploads/temp" should match itself and descendants (even without trailing slash) similar to directory
                    regexStr = `^${pattern}(?:\\/.*)?$`;
                }
            }
        } else {
            // Basename / unanchored pattern: matches any path segment
            // e.g., "*.log" => (^|.*\/)[^/]*\.log$
            // " .DS_Store" => (^|.*\/)\.DS_Store($|/.*)? but for file basename, only file match, not partial?
            // For basename wildcard patterns, we match files at any depth ending with pattern
            if (isDirectoryOnly) {
                // e.g., "vendor/" but basename would be weird? Actually vendor/ without slash is basename dir => matches any "vendor" directory at any depth
                regexStr = `(^|.*\\/)${pattern}(?:\\/.*)?$`;
            } else {
                const hasWildcard = /[*?]/.test(glob);
                if (hasWildcard) {
                    // wildcard basename: match basename of path
                    // Ensure pattern matches the final segment or any segment? gitignore says "*.log" matches any .log file at any level, which is final basename check
                    // But pattern like "*.log" should not match directory containing dot? So we match: (^|.*\/)[^/]*\.log$
                    regexStr = `(^|.*\\/)${pattern}$`;
                } else {
                    // plain basename like ".DS_Store" or "Thumbs.db" -> match any file/dir with that exact name at any level, plus descendants if it's a directory name?
                    // For plain basename without wildcard and without dir flag, spec says it matches basename at any level, but if it's a plain name without slash it could be either file or dir.
                    // We allow descendants for directory-like plain names? Safer to treat as basename match for file or directory and also descendants for dir case: ( ^|.*/ )name(/.*)?$
                    // However that would cause ".DS_Store" to match ".DS_Store/backup"? That's inside .DS_Store directory, unlikely. Allow suffix for generality.
                    regexStr = `(^|.*\\/)${pattern}(?:\\/.*)?$`;
                }
            }
        }

        return new RegExp(regexStr, 'i');
    }

    /**
     * Check if a relative path should be ignored (gitignore semantics: last matching pattern wins)
     * @param {string} relativePath
     * @returns {boolean}
     */
    isIgnored(relativePath) {
        const normalizedPath = this._normalizeForMatch(relativePath);
        if (!normalizedPath) return false;
        let ignored = false;
        for (const pat of this.patterns) {
            if (pat.regex.test(normalizedPath)) {
                ignored = !pat.isNegation;
            }
        }
        return ignored;
    }

    /**
     * Check if a directory path itself is ignored (used for pruning during walk)
     * @param {string} relativeDirPath - directory relative to root, without trailing slash
     */
    isIgnoredDir(relativeDirPath) {
        const normalized = this._normalizeForMatch(relativeDirPath);
        if (!normalized) return false;
        let ignored = false;
        for (const pat of this.patterns) {
            if (pat.regex.test(normalized)) {
                ignored = !pat.isNegation;
            }
            // Also consider that a file pattern marking a directory prefix might not directly test dir, but dir should be considered ignored if it is a parent of an ignored file pattern that is directory-only ambiguous.
            // Our regex already handles directory descendants via (?:/.*)? so parent match will hit.
        }
        return ignored;
    }

    /**
     * Decide whether a directory can be pruned (skipped) during traversal.
     * If dir is ignored and no later negation could re-include a child inside it, prune is safe.
     * @param {string} relativeDirPath
     */
    canPruneDir(relativeDirPath) {
        const normalized = this._normalizeForMatch(relativeDirPath);
        if (!normalized) return false;
        const ignored = this.isIgnoredDir(normalized);
        if (!ignored) return false;

        // Gitignore parent rule: a file inside an ignored directory cannot be
        // re-included unless the ignored directory itself is negated.
        // Therefore an unanchored basename negation (e.g., "!*.log" or "!.env")
        // does NOT effectively re-include files inside an ignored dir, so it
        // should NOT block pruning. Only negations that explicitly reference
        // this directory subtree (anchored prefix or literal prefix) block pruning.
        const prefix = normalized + '/';
        for (const pat of this.patterns) {
            if (!pat.isNegation) continue;
            // Anchored negations that are inside this dir e.g., "!vendor/keep" or "!a/b/keep.txt"
            if (pat.anchored) {
                if (pat.normalized === normalized || pat.normalized.startsWith(prefix) || pat.literalPrefix === normalized || (pat.literalPrefix && pat.literalPrefix.startsWith(prefix))) {
                    return false;
                }
                // Also test regex with a synthetic child that would match the negation's file name
                // e.g., dir vendor with negation "!vendor/keep.txt" — literalPrefix already catches, but wildcard anchored like "!src/*.js" not catch prefix; we test synthetic
                const synthetic = prefix + pat.normalized.split('/').pop().replace(/[*?]/g, 'a');
                if (pat.regex.test(synthetic) && synthetic.startsWith(prefix)) {
                    // This negation is anchored inside dir, so cannot prune
                    // But confirm it could match some child; use regex test on synthetic
                    return false;
                }
            } else {
                // Unanchored basename negation: per git parent rule, cannot re-include inside ignored dir without also negating the dir.
                // So ignore for pruning purposes — safe to prune.
                // However if the ignored dir itself is a basename dir (e.g., "vendor/" matches any vendor) and negation is "!vendor/keep" (anchored), that is anchored case already handled.
                // So unanchored patterns do not block pruning.
                continue;
            }
            // Fallback generic probe for odd patterns like "!**/keep.txt" (anchored via **)
            // For patterns with GLOBSTAR, literalPrefix empty, test a probe inside dir
            if (!pat.literalPrefix && pat.regex.test(prefix + "_probe_")) {
                return false;
            }
        }
        return true;
    }

    filter(filePaths) {
        return filePaths.filter(fp => !this.isIgnored(fp));
    }

    getRules() {
        return this.rawRules.slice();
    }

    /**
     * Get compiled patterns for debugging
     */
    getPatterns() {
        return this.patterns.map(p => ({ original: p.original, anchored: p.anchored, isNegation: p.isNegation, isDirectoryOnly: p.isDirectoryOnly, regex: p.regex.toString() }));
    }
}

module.exports = SyncIgnoreService;
