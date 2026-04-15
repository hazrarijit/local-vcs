/**
 * main.js - Electron Main Process
 * 
 * Entry point for the SyncVCS desktop application.
 * Creates the BrowserWindow, registers IPC handlers,
 * and manages the application lifecycle.
 */

const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const { registerHandlers, cleanup } = require('./src/ipc/handlers');

let mainWindow = null;
const appIcon = process.platform === 'win32'
    ? path.join(__dirname, 'ui', 'assets', 'icon.ico')
    : path.join(__dirname, 'ui', 'assets', 'icon.png');

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1280,
        height: 800,
        minWidth: 900,
        minHeight: 600,
        title: 'SyncVCS Client',
        backgroundColor: '#0d1117',
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: false
        },
        icon: appIcon,
        show: false
    });

    // Load the auth/login page
    mainWindow.loadFile(path.join(__dirname, 'ui', 'index.html'));

    // Show window when ready to avoid flash
    mainWindow.once('ready-to-show', () => {
        mainWindow.show();
    });

    // Register IPC handlers with window reference
    registerHandlers(mainWindow);



    // Navigate handler (SPA-like navigation within Electron)
    ipcMain.handle('navigate', async (event, page) => {
        const filePath = path.join(__dirname, 'ui', page);
        mainWindow.loadFile(filePath);
        return { success: true };
    });

    mainWindow.on('closed', () => {
        mainWindow = null;
    });

    // Open dev tools in development mode
    if (process.argv.includes('--dev')) {
        mainWindow.webContents.openDevTools();
    }
}

// App lifecycle
app.whenReady().then(() => {
    createWindow();

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) {
            createWindow();
        }
    });
});

app.on('window-all-closed', () => {
    cleanup();
    if (process.platform !== 'darwin') {
        app.quit();
    }
});

app.on('before-quit', () => {
    cleanup();
});
