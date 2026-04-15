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
        this._ensureFile();
    }

    _ensureFile() {
        fs.ensureDirSync(path.dirname(this.filePath));
        if (!fs.existsSync(this.filePath)) {
            fs.writeJsonSync(this.filePath, {}, { spaces: 2 });
        }
    }

    /**
     * Read the entire store
     * @returns {object}
     */
    readAll() {
        try {
            return fs.readJsonSync(this.filePath);
        } catch {
            return {};
        }
    }

    /**
     * Get a value by key
     * @param {string} key
     * @param {*} defaultValue
     * @returns {*}
     */
    get(key, defaultValue = null) {
        const data = this.readAll();
        return key in data ? data[key] : defaultValue;
    }

    /**
     * Set a value by key
     * @param {string} key
     * @param {*} value
     */
    set(key, value) {
        const data = this.readAll();
        data[key] = value;
        fs.writeJsonSync(this.filePath, data, { spaces: 2 });
    }

    /**
     * Delete a key
     * @param {string} key
     */
    delete(key) {
        const data = this.readAll();
        delete data[key];
        fs.writeJsonSync(this.filePath, data, { spaces: 2 });
    }

    /**
     * Check if key exists
     * @param {string} key
     * @returns {boolean}
     */
    has(key) {
        const data = this.readAll();
        return key in data;
    }

    /**
     * Clear all data
     */
    clear() {
        fs.writeJsonSync(this.filePath, {}, { spaces: 2 });
    }
}

module.exports = JsonStore;
