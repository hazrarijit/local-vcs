/**
 * encryption.js - AES-256-CBC Encryption Utility
 * 
 * Encrypts and decrypts file contents for local storage in .file-sync/
 * Uses AES-256-CBC with random IV for each encryption operation.
 */

const crypto = require('crypto');

const ALGORITHM = 'aes-256-cbc';
const KEY_LENGTH = 32; // 256 bits
const IV_LENGTH = 16;  // 128 bits

class EncryptionUtil {
    constructor(passphrase) {
        // Derive a stable 256-bit key from the passphrase using SHA-256
        this.key = crypto.createHash('sha256').update(passphrase).digest();
    }

    /**
     * Encrypt a buffer or string
     * @param {Buffer|string} data - Data to encrypt
     * @returns {Buffer} - IV (16 bytes) + encrypted data
     */
    encrypt(data) {
        const iv = crypto.randomBytes(IV_LENGTH);
        const cipher = crypto.createCipheriv(ALGORITHM, this.key, iv);

        const inputBuffer = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8');
        const encrypted = Buffer.concat([cipher.update(inputBuffer), cipher.final()]);

        // Prepend IV to encrypted data for self-contained decryption
        return Buffer.concat([iv, encrypted]);
    }

    /**
     * Decrypt a buffer that was encrypted with encrypt()
     * @param {Buffer} encryptedData - IV (16 bytes) + ciphertext
     * @returns {Buffer} - Original data
     */
    decrypt(encryptedData) {
        const iv = encryptedData.subarray(0, IV_LENGTH);
        const ciphertext = encryptedData.subarray(IV_LENGTH);

        const decipher = crypto.createDecipheriv(ALGORITHM, this.key, iv);
        return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    }

    /**
     * Encrypt data and return as base64 string (for JSON storage)
     * @param {Buffer|string} data
     * @returns {string}
     */
    encryptToBase64(data) {
        return this.encrypt(data).toString('base64');
    }

    /**
     * Decrypt a base64-encoded encrypted string
     * @param {string} base64Data
     * @returns {Buffer}
     */
    decryptFromBase64(base64Data) {
        return this.decrypt(Buffer.from(base64Data, 'base64'));
    }
}

module.exports = EncryptionUtil;
