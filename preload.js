/**
 * preload.js - Electron Preload Script
 * 
 * Exposes a safe API bridge from the main process to the renderer
 * using contextBridge. All IPC communication goes through this bridge.
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('syncvcs', {
    // ========================
    // AUTH API
    // ========================
    auth: {
        register: (userData) => ipcRenderer.invoke('auth:register', userData),
        login: (identifier, password) => ipcRenderer.invoke('auth:login', identifier, password),
        getSession: () => ipcRenderer.invoke('auth:session'),
        logout: () => ipcRenderer.invoke('auth:logout'),
        hasUsers: () => ipcRenderer.invoke('auth:hasUsers'),
        updateProfile: (userId, updates) => ipcRenderer.invoke('auth:updateProfile', userId, updates)
    },

    // ========================
    // PROJECT API
    // ========================
    project: {
        create: (data) => ipcRenderer.invoke('project:create', data),
        getAll: () => ipcRenderer.invoke('project:getAll'),
        get: (id) => ipcRenderer.invoke('project:get', id),
        update: (id, updates) => ipcRenderer.invoke('project:update', id, updates),
        delete: (id, removeSyncDir) => ipcRenderer.invoke('project:delete', id, removeSyncDir),
        getMetadata: (id) => ipcRenderer.invoke('project:getMetadata', id),
        selectFolder: () => ipcRenderer.invoke('project:selectFolder')
    },

    // ========================
    // TRACKING API
    // ========================
    tracking: {
        scan: (projectId) => ipcRenderer.invoke('tracking:scan', projectId),
        summary: (projectId) => ipcRenderer.invoke('tracking:summary', projectId),
        startWatch: (projectId) => ipcRenderer.invoke('tracking:startWatch', projectId),
        stopWatch: (projectId) => ipcRenderer.invoke('tracking:stopWatch', projectId),
        onFileChanged: (callback) => {
            ipcRenderer.on('tracking:fileChanged', (event, data) => callback(data));
        }
    },

    // ========================
    // DIFF API
    // ========================
    diff: {
        compute: (projectId, filePath) => ipcRenderer.invoke('diff:compute', projectId, filePath),
        newFile: (projectId, filePath) => ipcRenderer.invoke('diff:newFile', projectId, filePath),
        deletedFile: (projectId, filePath) => ipcRenderer.invoke('diff:deletedFile', projectId, filePath)
    },

    // ========================
    // SYNC API
    // ========================
    sync: {
        testConnection: (remoteUrl) => ipcRenderer.invoke('sync:testConnection', remoteUrl),
        syncFile: (projectId, filePath, changeType) => ipcRenderer.invoke('sync:file', projectId, filePath, changeType),
        syncBatch: (projectId, files, message) => ipcRenderer.invoke('sync:batch', projectId, files, message),
        onProgress: (callback) => {
            ipcRenderer.on('sync:progress', (event, data) => callback(data));
        }
    },

    // ========================
    // STAGING API
    // ========================
    staging: {
        stage: (projectId, files) => ipcRenderer.invoke('staging:stage', projectId, files),
        getStaged: (projectId) => ipcRenderer.invoke('staging:getStaged', projectId),
        deploy: (projectId, files, message) => ipcRenderer.invoke('staging:deploy', projectId, files, message),
        markDeployed: (projectId, filePaths) => ipcRenderer.invoke('staging:markDeployed', projectId, filePaths)
    },

    // ========================
    // CHANGELOG API
    // ========================
    changelog: {
        getLogs: (projectId, limit, offset) => ipcRenderer.invoke('changelog:getLogs', projectId, limit, offset),
        search: (projectId, query) => ipcRenderer.invoke('changelog:search', projectId, query),
        count: (projectId) => ipcRenderer.invoke('changelog:count', projectId)
    },

    // ========================
    // UTILITY API
    // ========================
    util: {
        readFile: (filePath) => ipcRenderer.invoke('util:readFile', filePath),
        fileExists: (filePath) => ipcRenderer.invoke('util:fileExists', filePath),
        getFileTree: (projectId) => ipcRenderer.invoke('util:getFileTree', projectId),
        downloadPhpFile: () => ipcRenderer.invoke('util:downloadPhpFile')
    },

    // ========================
    // FILE CONTEXT MENU API
    // ========================
    file: {
        discard: (projectId, filePath, changeType) => ipcRenderer.invoke('file:discard', projectId, filePath, changeType),
        ignore: (projectId, filePath) => ipcRenderer.invoke('file:ignore', projectId, filePath),
        openLocation: (projectId, filePath) => ipcRenderer.invoke('file:openLocation', projectId, filePath)
    },

});
