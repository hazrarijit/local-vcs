/**
 * store.js - JSON-based Local Data Store
 * 
 * Persistent storage for app data (users, projects, settings).
 * Stored in the app's user data directory.
 */

const fs = require('fs-extra');
const path = require('path');
const { app } = require('electron');

class JsonStore {
    constructor(fileName) {
        const userDataPath = app ? app.getPath('userData') : path.join(__dirname, '../../data');
        this.filePath = path.join(userDataPath, 'syncvcs-data', fileName);
        this._cache = null;
        this._cacheTime = 0;
        this._CACHE_TTL = 500;
        this._ensureFile();
    }

    _ensureFile() {
        fs.ensureDirSync(path.dirname(this.filePath));
        if (!fs.existsSync(this.filePath)) {
            fs.writeJsonSync(this.filePath, {}, { spaces: 2 });
        }
    }

    /**
     * Read the entire store (async, non-blocking)
     * @returns {Promise<object>}
     */
    async readAll() {
        try {
            const now = Date.now();
            if (this._cache && (now - this._cacheTime) < this._CACHE_TTL) {
                return this._cache;
            }
            const data = await fs.readJson(this.filePath);
            this._cache = data;
            this._cacheTime = now;
            return data;
        } catch {
            return {};
        }
    }

    /**
     * Get a value by key
     * @param {string} key
     * @param {*} defaultValue
     * @returns {Promise<*>}
     */
    async get(key, defaultValue = null) {
        const data = await this.readAll();
        return key in data ? data[key] : defaultValue;
    }

    /**
     * Set a value by key
     * @param {string} key
     * @param {*} value
     */
    async set(key, value) {
        const data = await this.readAll();
        data[key] = value;
        await fs.writeJson(this.filePath, data, { spaces: 2 });
        this._cache = data;
        this._cacheTime = Date.now();
    }

    /**
     * Delete a key
     * @param {string} key
     */
    async delete(key) {
        const data = await this.readAll();
        delete data[key];
        await fs.writeJson(this.filePath, data, { spaces: 2 });
        this._cache = data;
        this._cacheTime = Date.now();
    }

    /**
     * Check if key exists
     * @param {string} key
     * @returns {Promise<boolean>}
     */
    async has(key) {
        const data = await this.readAll();
        return key in data;
    }

    /**
     * Clear all data
     */
    async clear() {
        await fs.writeJson(this.filePath, {}, { spaces: 2 });
        this._cache = {};
        this._cacheTime = Date.now();
    }

    /**
     * Invalidate the cache (call after external modifications)
     */
    invalidateCache() {
        this._cache = null;
        this._cacheTime = 0;
    }
}

module.exports = JsonStore;
