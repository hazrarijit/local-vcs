/**
 * diff.service.js - File Diff Engine (large-file safe)
 *
 * Computes line-by-line diffs between stored encrypted version
 * and current file on disk. Optimized for any size base:
 *  - binary detection (no text diff for binaries)
 *  - size/line limits with graceful truncation
 *  - streaming-safe read with caps
 *  - hash fast-path for identical content
 *  - avoids blocking event loop for huge files
 */

const fs = require('fs-extra');
const path = require('path');
const crypto = require('crypto');
const Diff = require('diff');

const MAX_DIFF_BYTES = 700 * 1024; // 700 KB - beyond this, show truncated preview instead of full line diff
const MAX_DIFF_LINES = 3000; // max lines per side before truncation
const MAX_LINE_LENGTH = 4000; // truncate per line
const BINARY_CHECK_BYTES = 8000;
const PREVIEW_LINES = 200; // lines to show when file is too large

class DiffService {
    constructor(projectService) {
        this.projectService = projectService;
    }

    async computeDiff(projectId, relativePath) {
        const project = await this.projectService.getProject(projectId);
        if (!project) return { error: 'Project not found.' };

        const absolutePath = path.join(project.folderPath, relativePath);

        // Get stored content (decrypt lazily only if needed)
        let oldContent = '';
        const storedContent = await this.projectService.getStoredFileContent(projectId, relativePath);
        if (storedContent !== null) oldContent = storedContent;

        // Get current content with guards
        let newContent = '';
        let fileExists = false;
        let fileStat = null;
        try {
            fileStat = await fs.stat(absolutePath).catch(() => null);
            fileExists = !!fileStat && fileStat.isFile();
        } catch { fileExists = false; }

        if (fileExists) {
            // Quick identical check via size? If no old content (new file), we already handle
            // For large files, enforce cap before reading full content into memory
            if (fileStat && fileStat.size > 8 * 1024 * 1024) {
                // >=8MB treat as too large for full diff - use streaming preview path
                return this._largeFilePreview(oldContent, absolutePath, fileStat, relativePath);
            }
            if (fileStat && fileStat.size > MAX_DIFF_BYTES && oldContent.length > MAX_DIFF_BYTES) {
                // both sides large - truncate
                return this._largeFilePreview(oldContent, absolutePath, fileStat, relativePath, { tooLarge: true });
            }
            // Binary check: read first 8k and look for null byte or high binary ratio
            const head = await this._readHead(absolutePath, BINARY_CHECK_BYTES);
            if (this._isBinary(head) || this._isBinaryString(oldContent.slice(0, BINARY_CHECK_BYTES))) {
                const oldSize = Buffer.byteLength(oldContent, 'utf8');
                const newSize = fileStat ? fileStat.size : Buffer.byteLength(newContent, 'utf8');
                return this._binaryDiff(relativePath, oldSize, newSize, oldContent, head);
            }
            // Safe to read full content
            try {
                newContent = await fs.readFile(absolutePath, 'utf8');
            } catch (e) {
                // Fallback: could be binary but read as utf8 failed
                return this._binaryDiff(relativePath, Buffer.byteLength(oldContent, 'utf8'), fileStat ? fileStat.size : 0, oldContent, head);
            }
        }

        // Fast path identical hash
        if (oldContent === newContent) {
            return this._buildDiff(oldContent, newContent, relativePath, { identical: true });
        }

        // Size guard after reading: if either side exceeds limit, compute truncated preview
        if (oldContent.length > MAX_DIFF_BYTES || newContent.length > MAX_DIFF_BYTES) {
            return this._largeFilePreview(oldContent, absolutePath, fileStat, relativePath, { tooLarge: true, newContent });
        }

        // Normal diff
        return this._buildDiff(oldContent, newContent, relativePath);
    }

    _isBinary(buffer) {
        if (!buffer) return false;
        const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
        if (buf.length === 0) return false;
        // NULL byte is strong binary indicator
        for (let i = 0; i < buf.length; i++) if (buf[i] === 0) return true;
        // Heuristic: count non-printable bytes
        let nonText = 0;
        for (let i = 0; i < buf.length; i++) {
            const c = buf[i];
            if (c < 9 || (c > 13 && c < 32) || c > 126) nonText++;
        }
        return nonText / buf.length > 0.3;
    }

    _isBinaryString(str) {
        if (!str) return false;
        // Look for null char
        if (str.includes('\u0000')) return true;
        return false;
    }

    async _readHead(filePath, bytes) {
        try {
            const fd = await fs.open(filePath, 'r');
            const buf = Buffer.alloc(bytes);
            const { bytesRead } = await fd.read(buf, 0, bytes, 0);
            await fd.close();
            return buf.subarray(0, bytesRead);
        } catch {
            return Buffer.alloc(0);
        }
    }

    _binaryDiff(relativePath, oldSize, newSize, oldContent, newHead) {
        const oldHash = oldContent ? crypto.createHash('sha256').update(oldContent, 'utf8').digest('hex').slice(0, 7) : '—';
        const newHash = newHead ? crypto.createHash('sha256').update(newHead).digest('hex').slice(0, 7) : '—';
        return {
            fileName: path.basename(relativePath),
            filePath: relativePath,
            additions: 0,
            deletions: 0,
            totalChanges: 1,
            oldLines: [{ num: '', code: `[Binary file — ${oldSize} bytes, hash ${oldHash}]`, type: 'rem' }],
            newLines: [{ num: '', code: `[Binary file — ${newSize} bytes, hash ${newHash}]`, type: 'add' }],
            isBinary: true,
            isTooLarge: false,
            isNewFile: !oldContent,
            isDeletedFile: false,
            preview: true,
            message: 'Binary file — diff preview not available. Showing size/hash summary.'
        };
    }

    async _largeFilePreview(oldContent, absolutePath, fileStat, relativePath, opts = {}) {
        let newHead = '';
        let truncatedNew = '';
        try {
            const headBuf = await this._readHead(absolutePath, MAX_DIFF_BYTES);
            truncatedNew = headBuf.toString('utf8');
            // Only first PREVIEW_LINES lines for display
            newHead = truncatedNew.split('\n').slice(0, PREVIEW_LINES).join('\n');
        } catch { newHead = ''; }
        const oldPreview = oldContent ? oldContent.split('\n').slice(0, PREVIEW_LINES).join('\n') : '';
        const result = this._buildDiff(oldPreview, newHead, relativePath, { truncated: true, tooLarge: !!opts.tooLarge });
        result.isTooLarge = true;
        result.preview = true;
        result.message = `File too large for full diff (limit ${Math.round(MAX_DIFF_BYTES / 1024)} KB / ${MAX_DIFF_LINES} lines). Showing first ${PREVIEW_LINES} lines preview.`;
        result.fullSizes = { oldSize: oldContent.length, newSize: fileStat ? fileStat.size : (opts.newContent ? opts.newContent.length : 0) };
        return result;
    }

    _buildDiff(oldText, newText, filePath, flags = {}) {
        if (flags.identical) {
            const lines = oldText ? oldText.split('\n') : [];
            const limited = lines.length > MAX_DIFF_LINES ? lines.slice(0, MAX_DIFF_LINES) : lines;
            const oldLines = limited.map((code, i) => ({ num: i + 1, code: code.slice(0, MAX_LINE_LENGTH), type: '' }));
            const newLines = limited.map((code, i) => ({ num: i + 1, code: code.slice(0, MAX_LINE_LENGTH), type: '' }));
            const truncated = lines.length > MAX_DIFF_LINES;
            return {
                fileName: path.basename(filePath),
                filePath,
                additions: 0,
                deletions: 0,
                totalChanges: 0,
                oldLines,
                newLines,
                isNewFile: oldText === '',
                isDeletedFile: newText === '',
                isTooLarge: !!flags.tooLarge,
                isTruncated: truncated,
                preview: !!flags.truncated
            };
        }

        // Truncate line lengths before diff to avoid pathological long lines freezing diff
        const truncateLines = (text) => text.split('\n').map(l => l.length > MAX_LINE_LENGTH ? l.slice(0, MAX_LINE_LENGTH) + ' …' : l).join('\n');
        const safeOld = oldText.length > 2_000_000 ? truncateLines(oldText.slice(0, 2_000_000)) : truncateLines(oldText);
        const safeNew = newText.length > 2_000_000 ? truncateLines(newText.slice(0, 2_000_000)) : truncateLines(newText);

        // If total lines hugely exceed limit, delegate to preview truncation to keep UI responsive
        const totalLinesEstimate = safeOld.split('\n').length + safeNew.split('\n').length;
        if (totalLinesEstimate > MAX_DIFF_LINES * 2 && !flags.truncated) {
            const oldPreview = safeOld.split('\n').slice(0, PREVIEW_LINES).join('\n');
            const newPreview = safeNew.split('\n').slice(0, PREVIEW_LINES).join('\n');
            const res = this._buildDiff(oldPreview, newPreview, filePath, { truncated: true, tooLarge: true });
            res.message = `Diff truncated — file has ~${totalLinesEstimate} lines (limit ${MAX_DIFF_LINES * 2}). Showing preview.`;
            return res;
        }

        const changes = Diff.diffLines(safeOld, safeNew);

        let additions = 0;
        let deletions = 0;
        const oldLines = [];
        const newLines = [];
        let oldLineNum = 1;
        let newLineNum = 1;

        for (const part of changes) {
            // Diff lib may give empty last part with "\n"; handle
            const rawValue = part.value;
            if (rawValue === '') continue;
            const stripped = rawValue.endsWith('\n') ? rawValue.slice(0, -1) : rawValue;
            const lines = stripped === '' ? [''] : stripped.split('\n');

            // Safety cap: if building would exceed limits, truncate remaining as preview
            if (oldLines.length + newLines.length > MAX_DIFF_LINES * 2) {
                oldLines.push({ num: '', code: `… truncated (${lines.length} more lines)`, type: 'empty' });
                newLines.push({ num: '', code: `… truncated (${lines.length} more lines)`, type: 'empty' });
                break;
            }

            if (part.added) {
                additions += lines.length;
                for (const line of lines) {
                    if (oldLines.length >= MAX_DIFF_LINES * 2) break;
                    oldLines.push({ num: '', code: '', type: 'empty' });
                    newLines.push({ num: newLineNum++, code: line, type: 'add' });
                }
            } else if (part.removed) {
                deletions += lines.length;
                for (const line of lines) {
                    if (oldLines.length >= MAX_DIFF_LINES * 2) break;
                    oldLines.push({ num: oldLineNum++, code: line, type: 'rem' });
                    newLines.push({ num: '', code: '', type: 'empty' });
                }
            } else {
                for (const line of lines) {
                    if (oldLines.length >= MAX_DIFF_LINES * 2) break;
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
            isDeletedFile: newText === '',
            isTooLarge: !!flags.tooLarge,
            preview: !!flags.truncated,
            ...(flags.message ? { message: flags.message } : {}),
            ...(flags.truncated ? { preview: true } : {})
        };
    }

    async computeDeletedFileDiff(projectId, relativePath) {
        const storedContent = await this.projectService.getStoredFileContent(projectId, relativePath);
        // For deleted binary/large, handle gracefully
        if (storedContent && storedContent.length > MAX_DIFF_BYTES) {
            const preview = storedContent.split('\n').slice(0, PREVIEW_LINES).join('\n');
            const r = this._buildDiff(preview, '', relativePath, { truncated: true, tooLarge: true });
            r.message = 'Deleted file — preview of first lines.';
            return r;
        }
        if (storedContent && this._isBinaryString(storedContent.slice(0, 4000))) {
            return this._binaryDiff(relativePath, Buffer.byteLength(storedContent, 'utf8'), 0, storedContent, Buffer.alloc(0));
        }
        return this._buildDiff(storedContent || '', '', relativePath);
    }

    async computeNewFileDiff(projectId, relativePath) {
        const project = await this.projectService.getProject(projectId);
        if (!project) return { error: 'Project not found.' };
        const absolutePath = path.join(project.folderPath, relativePath);
        let newContent = '';
        let stat = null;
        try { stat = await fs.stat(absolutePath); } catch { /* ignore */ }
        if (stat && stat.size > 8 * 1024 * 1024) {
            return this._largeFilePreview('', absolutePath, stat, relativePath, { tooLarge: true });
        }
        if (fs.existsSync(absolutePath)) {
            const head = await this._readHead(absolutePath, BINARY_CHECK_BYTES);
            if (this._isBinary(head)) {
                return this._binaryDiff(relativePath, 0, stat ? stat.size : 0, '', head);
            }
            newContent = await fs.readFile(absolutePath, 'utf8').catch(() => head.toString('utf8'));
        }
        if (newContent.length > MAX_DIFF_BYTES) {
            return this._largeFilePreview('', absolutePath, stat, relativePath, { tooLarge: true, newContent });
        }
        return this._buildDiff('', newContent, relativePath);
    }

    getTextDiff(oldText, newText) {
        // Guard large
        if ((oldText && oldText.length > MAX_DIFF_BYTES) || (newText && newText.length > MAX_DIFF_BYTES)) {
            return `--- large file preview truncated (limit ${MAX_DIFF_BYTES} bytes) ---\n` + Diff.createPatch('file', oldText.slice(0, 5000), newText.slice(0, 5000));
        }
        const patch = Diff.createPatch('file', oldText, newText);
        return patch;
    }
}

module.exports = DiffService;
