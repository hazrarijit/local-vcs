/**
 * hashing.js - SHA-256 File Hashing Utility
 * 
 * Provides fast hash computation for file change detection.
 * Uses streaming for large files to avoid memory issues.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

/**
 * Compute SHA-256 hash of a file using streams (memory-efficient for large files)
 * @param {string} filePath - Absolute path to file
 * @returns {Promise<string>} - Hex-encoded hash
 */
/**
 * Internal stream-based hash with timeout
 */
function _hashFileStream(filePath, timeoutMs) {
    return new Promise((resolve, reject) => {
        const hash = crypto.createHash('sha256');
        let settled = false;

        const timer = setTimeout(() => {
            if (!settled) {
                settled = true;
                try { stream.destroy(); } catch (_) {}
                reject(new Error(`Hash timeout after ${timeoutMs}ms: ${filePath}`));
            }
        }, timeoutMs);
        if (timer.unref) timer.unref();

        const stream = fs.createReadStream(filePath);

        stream.on('data', (chunk) => hash.update(chunk));
        stream.on('end', () => {
            if (!settled) {
                settled = true;
                clearTimeout(timer);
                resolve(hash.digest('hex'));
            }
        });
        stream.on('close', () => {
            // On Windows a locked file may emit 'close' without 'end' or 'error'.
            if (!settled) {
                // let timeout handle it
            }
        });
        stream.on('error', (err) => {
            if (!settled) {
                settled = true;
                clearTimeout(timer);
                reject(err);
            }
        });
    });
}

/**
 * Compute SHA-256 hash with retry and fallback.
 * On timeout/lock it retries once after a short delay, then tries a
 * direct fs.readFile fallback (works for small/medium files on Windows
 * when streaming stalls). Timeout is 30s per attempt.
 */
async function hashFile(filePath, timeoutMs = 30000, retries = 1) {
    let lastErr;
    for (let attempt = 0; attempt <= retries; attempt++) {
        try {
            // Fast-path for empty / very small files: try direct read first if stream would stall on lock
            // We still prefer streaming to keep memory low, so only use stream first.
            return await _hashFileStream(filePath, timeoutMs);
        } catch (err) {
            lastErr = err;
            const isTimeout = err.message && err.message.includes('Hash timeout');
            const isBusy = err.code === 'EBUSY' || err.code === 'EPERM' || isTimeout;
            if (attempt < retries && isBusy) {
                // Wait briefly for file lock to release (Apache/antivirus), then retry
                await new Promise(r => setTimeout(r, 400 * (attempt + 1)));
                // On last retry attempt try buffer fallback for files < 50MB
                if (attempt === retries - 1 || retries === 1) {
                    try {
                        const stat = await fs.promises.stat(filePath);
                        if (stat.size < 50 * 1024 * 1024) {
                            const data = await fs.promises.readFile(filePath);
                            return crypto.createHash('sha256').update(data).digest('hex');
                        }
                    } catch (_) {
                        // fall through to next attempt / throw
                    }
                }
                continue;
            }
            // Enhance error message for timeouts
            if (isTimeout) {
                throw new Error(`Hash timeout after ${timeoutMs}ms: ${filePath} — file may be locked by another process (Apache/PHP/antivirus). Try closing the file and retrying.`);
            }
            throw err;
        }
    }
    throw lastErr;
}

/**
 * Compute SHA-256 hash of a string or buffer
 * @param {string|Buffer} data
 * @returns {string} - Hex-encoded hash
 */
function hashData(data) {
    return crypto.createHash('sha256').update(data).digest('hex');
}

/**
 * Generate a short version ID (first 7 chars of a random hash)
 * @returns {string} - e.g. "a3f7c21"
 */
function generateVersionId() {
    const randomBytes = crypto.randomBytes(20);
    return crypto.createHash('sha256').update(randomBytes).digest('hex').substring(0, 7);
}

module.exports = { hashFile, hashData, generateVersionId };
