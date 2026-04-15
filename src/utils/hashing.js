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
async function hashFile(filePath) {
    return new Promise((resolve, reject) => {
        const hash = crypto.createHash('sha256');
        const stream = fs.createReadStream(filePath);

        stream.on('data', (chunk) => hash.update(chunk));
        stream.on('end', () => resolve(hash.digest('hex')));
        stream.on('error', (err) => reject(err));
    });
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
