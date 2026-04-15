/**
 * renderer.js - Frontend UI Logic & IPC Bridge
 * 
 * Connects the HTML UI to the Electron IPC API (window.syncvcs).
 * Handles all page-specific logic, event bindings, and dynamic rendering.
 */

// ========================
// GLOBAL STATE
// ========================
const AppState = {
    currentProject: null,
    currentProjectId: null,
    session: null,
    changes: { added: [], modified: [], deleted: [] },
    selectedFile: null,
    checkedFiles: new Set(),
    stagedFiles: [],
    fileFilter: '',
    selectionInitialized: {
        changes: false,
        staged: false
    }
};

function syncCheckedFiles(items, tab = currentTab) {
    const availablePaths = new Set(items.map(item => item.path));
    const nextChecked = new Set();

    AppState.checkedFiles.forEach(filePath => {
        if (availablePaths.has(filePath)) {
            nextChecked.add(filePath);
        }
    });

    if (!AppState.selectionInitialized[tab] && nextChecked.size === 0 && items.length > 0) {
        items.forEach(item => nextChecked.add(item.path));
        AppState.selectionInitialized[tab] = true;
    }

    AppState.checkedFiles = nextChecked;
}

function bindFileListInteractions() {
    const container = document.getElementById('file-list-area');
    if (!container || container.dataset.bound === 'true') {
        return;
    }

    container.addEventListener('change', (event) => {
        const checkbox = event.target.closest('.custom-checkbox[data-path]');
        if (!checkbox) {
            return;
        }

        toggleFileCheck(checkbox.dataset.path, checkbox.checked);
        event.stopPropagation();
    });

    container.addEventListener('click', (event) => {
        const details = event.target.closest('.file-details[data-path]');
        if (!details) {
            return;
        }

        selectFile(details.dataset.path, details.dataset.changeType, Number(details.dataset.idx));
    });

    container.addEventListener('contextmenu', (event) => {
        const item = event.target.closest('.file-item[data-path]');
        if (!item) {
            return;
        }

        event.preventDefault();
        showFileContextMenu(event.clientX, event.clientY, item.dataset.path, item.dataset.type);
    });

    container.dataset.bound = 'true';
}

function getAllChangeFiles() {
    return [
        ...AppState.changes.modified.map(f => ({ ...f, type: 'M', changeType: 'update' })),
        ...AppState.changes.added.map(f => ({ ...f, type: 'A', changeType: 'add' })),
        ...AppState.changes.deleted.map(f => ({ ...f, type: 'D', changeType: 'delete' }))
    ];
}

function filterFiles(items) {
    const query = AppState.fileFilter.trim().toLowerCase();
    if (!query) {
        return items;
    }

    return items.filter(item => {
        const candidates = [item.name, item.path, item.dir].filter(Boolean);
        return candidates.some(value => value.toLowerCase().includes(query));
    });
}

function getVisibleFiles() {
    return currentTab === 'staged' ? filterFiles(AppState.stagedFiles || []) : filterFiles(getAllChangeFiles());
}

function updateMasterCheckbox(items = getVisibleFiles()) {
    const masterCheckbox = document.getElementById('master-file-check');
    if (!masterCheckbox) return;

    const selectedCount = items.filter(item => AppState.checkedFiles.has(item.path)).length;
    const hasItems = items.length > 0;

    masterCheckbox.disabled = !hasItems;
    masterCheckbox.checked = hasItems && selectedCount === items.length;
    masterCheckbox.indeterminate = hasItems && selectedCount > 0 && selectedCount < items.length;
    masterCheckbox.classList.toggle('indeterminate', masterCheckbox.indeterminate);
}

function applyFilterForCurrentTab() {
    if (currentTab === 'staged') {
        renderStagedList(AppState.stagedFiles || []);
        return;
    }

    renderFileList(getAllChangeFiles());
}

function toggleVisibleFiles(checked) {
    const visibleFiles = getVisibleFiles();
    AppState.selectionInitialized[currentTab] = true;

    for (const file of visibleFiles) {
        if (checked) {
            AppState.checkedFiles.add(file.path);
        } else {
            AppState.checkedFiles.delete(file.path);
        }
    }

    applyFilterForCurrentTab();
}

// ========================
// NOTIFICATIONS
// ========================
function showNotification(message, type = 'info', duration = 4000) {
    let container = document.getElementById('notification-container');
    if (!container) {
        container = document.createElement('div');
        container.id = 'notification-container';
        container.style.cssText = 'position:fixed;top:50px;right:20px;z-index:10000;display:flex;flex-direction:column;gap:10px;';
        document.body.appendChild(container);
    }

    const colors = {
        success: 'linear-gradient(135deg, #238636, #2ea043)',
        error: 'linear-gradient(135deg, #da3633, #b62324)',
        info: 'linear-gradient(135deg, #2f81f7, #1f6feb)',
        warning: 'linear-gradient(135deg, #d29922, #bb8009)'
    };

    const icons = {
        success: 'fa-check-circle',
        error: 'fa-exclamation-circle',
        info: 'fa-info-circle',
        warning: 'fa-exclamation-triangle'
    };

    const toast = document.createElement('div');
    toast.style.cssText = `
        background: ${colors[type] || colors.info};
        color: #fff;
        padding: 12px 20px;
        border-radius: 8px;
        font-size: 13px;
        font-weight: 500;
        display: flex;
        align-items: center;
        gap: 10px;
        box-shadow: 0 8px 24px rgba(0,0,0,0.4);
        animation: slideIn 0.3s ease;
        max-width: 380px;
        font-family: 'Inter', sans-serif;
        backdrop-filter: blur(10px);
    `;
    toast.innerHTML = `<i class="fas ${icons[type] || icons.info}"></i> ${message}`;

    container.appendChild(toast);

    setTimeout(() => {
        toast.style.animation = 'slideOut 0.3s ease';
        setTimeout(() => toast.remove(), 300);
    }, duration);
}

// Add notification animations
const notifStyle = document.createElement('style');
notifStyle.textContent = `
@keyframes slideIn { from { transform: translateX(100%); opacity: 0; } to { transform: translateX(0); opacity: 1; } }
@keyframes slideOut { from { transform: translateX(0); opacity: 1; } to { transform: translateX(100%); opacity: 0; } }
@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
@keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
.spinner { animation: spin 1s linear infinite; }
`;
document.head.appendChild(notifStyle);



// ========================
// PAGE: AUTH (index.html)
// ========================
async function initAuthPage() {
    if (!window.syncvcs) return;

    // Check if already logged in
    const session = await window.syncvcs.auth.getSession();
    if (session) {
        window.location.href = 'projects.html';
        return;
    }

    const hasUsers = await window.syncvcs.auth.hasUsers();

    const authBox = document.querySelector('.auth-box');
    if (!authBox) return;

    // Build login/register form
    authBox.innerHTML = `
        <div style="text-align: center; margin-bottom: 30px;">
            <div style="width: 60px; height: 60px; background: rgba(47, 129, 247, 0.1); border-radius: 15px; display: flex; align-items: center; justify-content: center; margin: 0 auto 15px;">
                <i class="fas fa-shield-alt" style="font-size: 28px; color: var(--accent);"></i>
            </div>
            <h2 id="auth-title" style="font-size: 20px; color: var(--text-primary); font-weight: 600; margin-bottom: 5px;">
                ${hasUsers ? 'Welcome Back' : 'Create Account'}
            </h2>
            <p style="color: var(--text-muted); font-size: 13px;">
                ${hasUsers ? 'Sign in to your workspace' : 'Set up your local workspace identity'}
            </p>
        </div>

        <div id="register-fields" style="display: ${hasUsers ? 'none' : 'block'}">
            <div class="form-group">
                <label class="form-label">Full Name</label>
                <input type="text" class="app-input" id="auth-name" placeholder="Your name">
            </div>
            <div class="form-group">
                <label class="form-label">Email</label>
                <input type="email" class="app-input" id="auth-email" placeholder="you@example.com">
            </div>
        </div>

        <div class="form-group">
            <label class="form-label">Username</label>
            <input type="text" class="app-input" id="auth-username" placeholder="Enter username">
        </div>

        <div class="form-group" style="margin-bottom: 30px;">
            <label class="form-label">Password</label>
            <input type="password" class="app-input" id="auth-password" placeholder="Enter password">
        </div>

        <button class="app-btn" id="auth-submit-btn">
            <i class="fas ${hasUsers ? 'fa-sign-in-alt' : 'fa-user-plus'}"></i>
            ${hasUsers ? 'SIGN IN' : 'CREATE ACCOUNT'}
        </button>

        <div style="text-align: center; margin-top: 15px;">
            <a href="#" id="auth-toggle" style="color: var(--accent); font-size: 12px; text-decoration: none;">
                ${hasUsers ? "Don't have an account? Register" : 'Already have an account? Sign In'}
            </a>
        </div>
    `;

    let isLogin = hasUsers;

    // Toggle between login/register
    document.getElementById('auth-toggle').addEventListener('click', (e) => {
        e.preventDefault();
        isLogin = !isLogin;
        const registerFields = document.getElementById('register-fields');
        const title = document.getElementById('auth-title');
        const btn = document.getElementById('auth-submit-btn');
        const toggle = document.getElementById('auth-toggle');

        registerFields.style.display = isLogin ? 'none' : 'block';
        title.textContent = isLogin ? 'Welcome Back' : 'Create Account';
        btn.innerHTML = isLogin
            ? '<i class="fas fa-sign-in-alt"></i> SIGN IN'
            : '<i class="fas fa-user-plus"></i> CREATE ACCOUNT';
        toggle.textContent = isLogin
            ? "Don't have an account? Register"
            : 'Already have an account? Sign In';
    });

    // Submit handler
    document.getElementById('auth-submit-btn').addEventListener('click', async () => {
        const username = document.getElementById('auth-username').value.trim();
        const password = document.getElementById('auth-password').value;

        if (isLogin) {
            const result = await window.syncvcs.auth.login(username, password);
            if (result.success) {
                showNotification('Login successful!', 'success');
                setTimeout(() => window.location.href = 'projects.html', 500);
            } else {
                showNotification(result.message, 'error');
            }
        } else {
            const name = document.getElementById('auth-name').value.trim();
            const email = document.getElementById('auth-email').value.trim();
            const result = await window.syncvcs.auth.register({ name, username, email, password });
            if (result.success) {
                showNotification('Account created!', 'success');
                setTimeout(() => window.location.href = 'projects.html', 500);
            } else {
                showNotification(result.message, 'error');
            }
        }
    });

    // Enter key support
    authBox.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            document.getElementById('auth-submit-btn').click();
        }
    });
}

// ========================
// PAGE: PROJECTS (projects.html)
// ========================
async function initProjectsPage() {
    if (!window.syncvcs) return;

    const session = await window.syncvcs.auth.getSession();
    if (!session) {
        window.location.href = 'index.html';
        return;
    }
    AppState.session = session;

    await loadProjects();

    // Search functionality
    const searchInput = document.querySelector('.search-box .app-input');
    if (searchInput) {
        searchInput.addEventListener('input', (e) => {
            const query = e.target.value.toLowerCase();
            document.querySelectorAll('.project-card').forEach(card => {
                const name = card.querySelector('.project-name')?.textContent?.toLowerCase() || '';
                card.style.display = name.includes(query) ? '' : 'none';
            });
        });
    }
}

async function loadProjects() {
    const projects = await window.syncvcs.project.getAll();
    const grid = document.querySelector('.project-grid');
    if (!grid) return;

    if (projects.length === 0) {
        grid.innerHTML = `
            <div style="grid-column: 1 / -1; text-align: center; padding: 80px 20px; color: var(--text-muted);">
                <i class="fas fa-folder-open" style="font-size: 48px; opacity: 0.3; margin-bottom: 20px; display: block;"></i>
                <h3 style="color: var(--text-primary); margin-bottom: 10px; font-weight: 500;">No projects yet</h3>
                <p style="font-size: 13px;">Click "Add Repository" to link your first workspace.</p>
            </div>
        `;
        return;
    }

    grid.innerHTML = projects.map(project => {
        const lastSync = project.lastSyncAt 
            ? formatTimeAgo(project.lastSyncAt)
            : 'Never synced';
        const statusColor = project.lastSyncAt 
            ? 'var(--success)' 
            : 'var(--warn)';
        const hasRemote = project.remoteUrl ? true : false;

        return `
            <div class="project-card" data-project-id="${project.id}" onclick="openProject('${project.id}')">
                <div class="project-header">
                    <div class="project-icon">
                        <i class="fas fa-code-branch"></i>
                    </div>
                    <div class="project-status" style="background: ${statusColor}; box-shadow: 0 0 8px ${statusColor};" title="${lastSync}"></div>
                </div>
                <div class="project-name">${escapeHtml(project.name)}</div>
                <div class="project-path">
                    <i class="fas fa-hdd"></i> ${escapeHtml(project.folderPath)}
                </div>
                ${hasRemote ? `
                <div class="project-path" style="margin-top: 4px;">
                    <i class="fas fa-globe" style="color: var(--accent);"></i> ${escapeHtml(project.remoteUrl)}
                </div>
                ` : `
                <div class="project-path" style="margin-top: 4px; color: var(--warn);">
                    <i class="fas fa-exclamation-triangle"></i> No remote server configured
                </div>
                `}
                <div class="project-meta">
                    <span><i class="far fa-clock"></i> ${lastSync}</span>
                    <span class="badge">${project.autoSync ? 'Auto-Sync' : 'Manual'}</span>
                </div>
            </div>
        `;
    }).join('');
}

function openProject(projectId) {
    sessionStorage.setItem('currentProjectId', projectId);
    window.location.href = 'changes.html';
}

// ========================
// PAGE: NEW PROJECT (new-project.html)
// ========================
async function initNewProjectPage() {
    if (!window.syncvcs) return;

    const browseBtn = document.getElementById('browse-folder-btn');
    const folderInput = document.getElementById('folder-path');
    const initBtn = document.getElementById('init-project-btn');

    // Replace the browse mechanism with Electron's native dialog
    if (browseBtn && folderInput) {
        const triggerBrowse = async () => {
            const selectedPath = await window.syncvcs.project.selectFolder();
            if (selectedPath) {
                folderInput.value = selectedPath;
            }
        };

        browseBtn.addEventListener('click', triggerBrowse);
        folderInput.addEventListener('click', triggerBrowse);
    }

    // Initialize button
    if (initBtn) {
        initBtn.addEventListener('click', async () => {
            const name = document.getElementById('project-name')?.value?.trim();
            const folderPath = folderInput?.value?.trim();
            const remoteUrl = document.getElementById('remote-url')?.value?.trim();
            const description = document.getElementById('project-desc')?.value?.trim();

            if (!name || !folderPath) {
                showNotification('Project name and folder path are required.', 'warning');
                return;
            }

            // Show loading state
            initBtn.innerHTML = '<i class="fas fa-spinner spinner"></i> INITIALIZING...';
            initBtn.disabled = true;

            const result = await window.syncvcs.project.create({
                name, folderPath, remoteUrl, description
            });

            if (result.success) {
                showNotification('Project initialized successfully!', 'success');
                setTimeout(() => window.location.href = 'projects.html', 800);
            } else {
                showNotification(result.message, 'error');
                initBtn.innerHTML = '<i class="fas fa-save"></i> INITIALIZE SYNC';
                initBtn.disabled = false;
            }
        });
    }
}

// ========================
// PAGE: CHANGES (changes.html)
// ========================
let currentTab = 'changes'; // 'changes' or 'staged'

async function initChangesPage() {
    if (!window.syncvcs) return;

    bindFileListInteractions();

    const projectId = sessionStorage.getItem('currentProjectId');
    if (!projectId) {
        window.location.href = 'projects.html';
        return;
    }

    const session = await window.syncvcs.auth.getSession();
    AppState.session = session;
    AppState.currentProjectId = projectId;
    AppState.currentProject = await window.syncvcs.project.get(projectId);

    if (!AppState.currentProject) {
        showNotification('Project not found.', 'error');
        window.location.href = 'projects.html';
        return;
    }

    // Update window title with project name
    document.title = `SyncVCS - ${AppState.currentProject.name}`;

    // Project Settings nav button
    const projSettingsNav = document.getElementById('nav-project-settings');
    if (projSettingsNav) {
        projSettingsNav.addEventListener('click', (e) => {
            e.preventDefault();
            showProjectSettings();
        });
    }

    // Scan for changes
    await refreshChanges();

    // Load staged count
    await refreshStagedCount();

    // Start file watcher
    await window.syncvcs.tracking.startWatch(projectId);

    // Listen for real-time file changes
    window.syncvcs.tracking.onFileChanged((data) => {
        if (data.projectId === projectId) {
            clearTimeout(window._refreshTimer);
            window._refreshTimer = setTimeout(() => {
                if (currentTab === 'changes') refreshChanges();
            }, 1000);
        }
    });

    // Stage Changes button
    const stageBtn = document.getElementById('btn-stage');
    if (stageBtn) {
        stageBtn.addEventListener('click', () => stageSelectedFiles());
    }

    // Deploy To Server button
    const deployBtn = document.getElementById('btn-deploy');
    if (deployBtn) {
        deployBtn.addEventListener('click', () => deploySelectedFiles());
    }

    // Deploy Staged button
    const deployStagedBtn = document.getElementById('btn-deploy-staged');
    if (deployStagedBtn) {
        deployStagedBtn.addEventListener('click', () => deployStagedFiles());
    }

    // Mark as Deployed button
    const markDeployedBtn = document.getElementById('btn-mark-deployed');
    if (markDeployedBtn) {
        markDeployedBtn.addEventListener('click', () => markStagedAsDeployed());
    }

    const fileFilterInput = document.getElementById('file-filter-input');
    if (fileFilterInput) {
        fileFilterInput.addEventListener('input', (event) => {
            AppState.fileFilter = event.target.value || '';
            applyFilterForCurrentTab();
        });
    }

    const masterFileCheck = document.getElementById('master-file-check');
    if (masterFileCheck) {
        masterFileCheck.addEventListener('change', (event) => {
            toggleVisibleFiles(event.target.checked);
        });
    }

    // Sync progress listener
    window.syncvcs.sync.onProgress((data) => {
        const btns = document.querySelectorAll('#btn-deploy, #btn-deploy-staged');
        btns.forEach(btn => {
            btn.innerHTML = `<i class="fas fa-spinner spinner"></i> SYNCING ${data.current}/${data.total}...`;
        });
    });
}

// Tab switching
function switchTab(tab) {
    currentTab = tab;
    const changesTab = document.getElementById('tab-changes');
    const stagedTab = document.getElementById('tab-staged');
    const changesPanel = document.getElementById('panel-changes');
    const stagedPanel = document.getElementById('panel-staged');

    if (tab === 'changes') {
        changesTab.style.color = 'var(--text-primary)';
        changesTab.style.borderBottom = '2px solid var(--accent)';
        stagedTab.style.color = 'var(--text-muted)';
        stagedTab.style.borderBottom = '2px solid transparent';
        if (changesPanel) changesPanel.style.display = '';
        if (stagedPanel) stagedPanel.style.display = 'none';
        refreshChanges();
    } else {
        stagedTab.style.color = 'var(--text-primary)';
        stagedTab.style.borderBottom = '2px solid var(--accent)';
        changesTab.style.color = 'var(--text-muted)';
        changesTab.style.borderBottom = '2px solid transparent';
        if (changesPanel) changesPanel.style.display = 'none';
        if (stagedPanel) stagedPanel.style.display = '';
        loadStagedFiles();
    }
}

async function refreshStagedCount() {
    const staged = await window.syncvcs.staging.getStaged(AppState.currentProjectId);
    const badge = document.getElementById('staged-count');
    if (badge) badge.textContent = `(${staged.length})`;
}

async function refreshChanges() {
    const projectId = AppState.currentProjectId;
    if (!projectId) return;

    const changes = await window.syncvcs.tracking.scan(projectId);
    AppState.changes = changes;

    const badge = document.getElementById('changes-count');
    const allFiles = getAllChangeFiles();

    if (badge) badge.textContent = `(${allFiles.length})`;

    if (currentTab === 'changes') {
        renderFileList(allFiles);
    }
}

function renderFileList(allFiles) {
    const container = document.getElementById('file-list-area');
    if (!container) return;

    const filteredFiles = filterFiles(allFiles);

    if (allFiles.length === 0) {
        AppState.selectionInitialized.changes = false;
        AppState.checkedFiles.clear();
        container.innerHTML = `
            <div style="text-align: center; padding: 40px 20px; color: var(--text-muted);">
                <i class="fas fa-check-circle" style="font-size: 32px; color: var(--success); margin-bottom: 15px; display: block;"></i>
                <p style="font-size: 13px;">All files are in sync.</p>
            </div>
        `;
        updateMasterCheckbox([]);
        return;
    }

    if (filteredFiles.length === 0) {
        container.innerHTML = `
            <div style="text-align: center; padding: 40px 20px; color: var(--text-muted);">
                <i class="fas fa-search" style="font-size: 28px; opacity: 0.35; margin-bottom: 15px; display: block;"></i>
                <p style="font-size: 13px; margin-bottom: 5px;">No files match the current filter.</p>
                <p style="font-size: 11px;">Try a different file name or path.</p>
            </div>
        `;
        updateMasterCheckbox([]);
        return;
    }

    syncCheckedFiles(allFiles, 'changes');

    container.innerHTML = filteredFiles.map((file, idx) => {
        const statusClass = file.type === 'M' ? 'status-m' : file.type === 'A' ? 'status-a' : 'status-d';
        const isSelected = idx === 0 ? 'selected' : '';

        return `
            <div class="file-item ${isSelected}" data-path="${escapeHtml(file.path)}" data-type="${file.changeType}" data-idx="${idx}">
                <input type="checkbox" class="custom-checkbox" data-path="${escapeHtml(file.path)}" ${AppState.checkedFiles.has(file.path) ? 'checked' : ''}>
                <div class="file-details" data-path="${escapeHtml(file.path)}" data-change-type="${file.changeType}" data-idx="${idx}">
                    <div class="file-name">${escapeHtml(file.name)}</div>
                    <div class="file-path">${escapeHtml(file.dir)}</div>
                </div>
                <div class="status-badge ${statusClass}">${file.type}</div>
            </div>
        `;
    }).join('');

    if (filteredFiles.length > 0) {
        selectFile(filteredFiles[0].path, filteredFiles[0].changeType, 0);
    }

    updateMasterCheckbox(filteredFiles);
}

async function selectFile(filePath, changeType, idx) {
    AppState.selectedFile = { path: filePath, type: changeType };

    document.querySelectorAll('.file-item').forEach(el => el.classList.remove('selected'));
    const item = document.querySelector(`.file-item[data-idx="${idx}"]`);
    if (item) item.classList.add('selected');

    let diffData;
    if (changeType === 'add') {
        diffData = await window.syncvcs.diff.newFile(AppState.currentProjectId, filePath);
    } else if (changeType === 'delete') {
        diffData = await window.syncvcs.diff.deletedFile(AppState.currentProjectId, filePath);
    } else {
        diffData = await window.syncvcs.diff.compute(AppState.currentProjectId, filePath);
    }

    renderDiff(diffData);
}

function renderDiff(diffData) {
    const toolbar = document.querySelector('.diff-toolbar');
    if (toolbar) {
        toolbar.innerHTML = `
            <span style="color: var(--text-primary); font-weight: 500;">${escapeHtml(diffData.fileName)}</span>
            <div style="margin-left: auto; display: flex; gap: 15px;">
                <span><i class="fas fa-plus" style="color: var(--success)"></i> ${diffData.additions} additions</span>
                <span><i class="fas fa-minus" style="color: var(--danger)"></i> ${diffData.deletions} deletions</span>
            </div>
        `;
    }

    const oldColumn = document.getElementById('diff-old');
    if (oldColumn) {
        oldColumn.innerHTML = `
            <div class="diff-header text-muted">Original (Stored)</div>
            <div class="diff-content-wrapper">
                ${diffData.oldLines.map(line => `
                    <div class="diff-line ${line.type}">
                        <div class="diff-num">${line.num || '&nbsp;'}</div>
                        <div class="diff-code">${line.type === 'rem' ? '- ' : ''}${escapeHtml(line.code)}</div>
                    </div>
                `).join('')}
            </div>
        `;
    }

    const newColumn = document.getElementById('diff-new');
    if (newColumn) {
        newColumn.innerHTML = `
            <div class="diff-header text-muted">Modified (Local)</div>
            <div class="diff-content-wrapper">
                ${diffData.newLines.map(line => `
                    <div class="diff-line ${line.type}">
                        <div class="diff-num">${line.num || '&nbsp;'}</div>
                        <div class="diff-code">${line.type === 'add' ? '+ ' : ''}${escapeHtml(line.code)}</div>
                    </div>
                `).join('')}
            </div>
        `;
    }

    syncDiffScroll();
}

function syncDiffScroll() {
    const oldCol = document.getElementById('diff-old');
    const newCol = document.getElementById('diff-new');
    if (!oldCol || !newCol) return;

    let syncing = false;
    oldCol.addEventListener('scroll', () => {
        if (syncing) return;
        syncing = true;
        newCol.scrollTop = oldCol.scrollTop;
        syncing = false;
    });
    newCol.addEventListener('scroll', () => {
        if (syncing) return;
        syncing = true;
        oldCol.scrollTop = newCol.scrollTop;
        syncing = false;
    });
}

function toggleFileCheck(filePath, checked) {
    AppState.selectionInitialized[currentTab] = true;

    if (checked) {
        AppState.checkedFiles.add(filePath);
    } else {
        AppState.checkedFiles.delete(filePath);
    }

    updateMasterCheckbox();
}

// ========================
// FILE CONTEXT MENU
// ========================

function hideContextMenu() {
    const existing = document.getElementById('file-context-menu');
    if (existing) existing.remove();
}

function showFileContextMenu(x, y, filePath, changeType) {
    hideContextMenu();

    const menu = document.createElement('div');
    menu.id = 'file-context-menu';
    menu.className = 'context-menu';

    const discardLabel = changeType === 'add' ? 'Discard (Remove New File)' : 'Discard Change';

    menu.innerHTML = `
        <div class="context-menu-item danger" data-action="discard">
            <i class="fas fa-undo"></i> ${discardLabel}
        </div>
        <div class="context-menu-divider"></div>
        <div class="context-menu-item" data-action="ignore">
            <i class="fas fa-eye-slash"></i> Ignore File
        </div>
        <div class="context-menu-item" data-action="open">
            <i class="fas fa-folder-open"></i> Open File Location
        </div>
    `;

    // Position menu, ensuring it stays on screen
    document.body.appendChild(menu);

    const menuRect = menu.getBoundingClientRect();
    const viewW = window.innerWidth;
    const viewH = window.innerHeight;

    menu.style.left = (x + menuRect.width > viewW ? viewW - menuRect.width - 8 : x) + 'px';
    menu.style.top = (y + menuRect.height > viewH ? viewH - menuRect.height - 8 : y) + 'px';

    // Action handlers
    menu.querySelectorAll('.context-menu-item').forEach(item => {
        item.addEventListener('click', async () => {
            const action = item.dataset.action;
            hideContextMenu();

            if (action === 'discard') {
                await handleDiscardFile(filePath, changeType);
            } else if (action === 'ignore') {
                await handleIgnoreFile(filePath);
            } else if (action === 'open') {
                await handleOpenFileLocation(filePath);
            }
        });
    });

    // Close on click outside or Escape
    const closeHandler = (e) => {
        if (!menu.contains(e.target)) {
            hideContextMenu();
            document.removeEventListener('click', closeHandler);
        }
    };
    // Delay to avoid the same right-click closing it
    setTimeout(() => document.addEventListener('click', closeHandler), 10);

    const keyHandler = (e) => {
        if (e.key === 'Escape') {
            hideContextMenu();
            document.removeEventListener('keydown', keyHandler);
        }
    };
    document.addEventListener('keydown', keyHandler);
}

async function handleDiscardFile(filePath, changeType) {
    const confirmMsg = changeType === 'add'
        ? 'This will permanently delete this new file. Continue?'
        : 'This will restore the file to its last stored version. Unsaved changes will be lost. Continue?';

    if (!confirm(confirmMsg)) return;

    const result = await window.syncvcs.file.discard(AppState.currentProjectId, filePath, changeType);
    if (result.success) {
        showNotification(result.message, 'success');
        await refreshChanges();
    } else {
        showNotification(result.message || 'Discard failed.', 'error');
    }
}

async function handleIgnoreFile(filePath) {
    const result = await window.syncvcs.file.ignore(AppState.currentProjectId, filePath);
    if (result.success) {
        showNotification(result.message, 'success');
        await refreshChanges();
    } else {
        showNotification(result.message || 'Failed to add to .syncignore.', 'error');
    }
}

async function handleOpenFileLocation(filePath) {
    await window.syncvcs.file.openLocation(AppState.currentProjectId, filePath);
}

// ========================
// STAGED FILES TAB
// ========================

async function loadStagedFiles() {
    const container = document.getElementById('file-list-area');
    if (!container) return;

    const staged = await window.syncvcs.staging.getStaged(AppState.currentProjectId);
    
    const badge = document.getElementById('staged-count');
    if (badge) badge.textContent = `(${staged.length})`;

    if (staged.length === 0) {
        AppState.selectionInitialized.staged = false;
        AppState.checkedFiles.clear();
        container.innerHTML = `
            <div style="text-align: center; padding: 40px 20px; color: var(--text-muted);">
                <i class="fas fa-inbox" style="font-size: 32px; opacity: 0.3; margin-bottom: 15px; display: block;"></i>
                <p style="font-size: 13px; margin-bottom: 5px;">No staged files pending deployment.</p>
                <p style="font-size: 11px; color: var(--text-muted);">Use "Stage Changes" to store local changes without deploying.</p>
            </div>
        `;
        AppState.stagedFiles = [];
        updateMasterCheckbox([]);
        return;
    }

    AppState.stagedFiles = staged;
    renderStagedList(staged);
}

function renderStagedList(staged) {
    const container = document.getElementById('file-list-area');
    if (!container) return;

    const filteredFiles = filterFiles(staged);

    if (filteredFiles.length === 0) {
        container.innerHTML = `
            <div style="text-align: center; padding: 40px 20px; color: var(--text-muted);">
                <i class="fas fa-search" style="font-size: 28px; opacity: 0.35; margin-bottom: 15px; display: block;"></i>
                <p style="font-size: 13px; margin-bottom: 5px;">No staged files match the current filter.</p>
                <p style="font-size: 11px;">Try a different file name or path.</p>
            </div>
        `;
        updateMasterCheckbox([]);
        return;
    }

    syncCheckedFiles(staged, 'staged');

    const typeMap = { add: 'A', update: 'M', delete: 'D' };

    container.innerHTML = filteredFiles.map((file, idx) => {
        const typeChar = typeMap[file.type] || 'M';
        const statusClass = typeChar === 'M' ? 'status-m' : typeChar === 'A' ? 'status-a' : 'status-d';
        const stagedTime = formatTimeAgo(file.stagedAt);

        return `
            <div class="file-item" data-path="${escapeHtml(file.path)}" data-type="${file.type}" data-idx="${idx}">
                <input type="checkbox" class="custom-checkbox" data-path="${escapeHtml(file.path)}" ${AppState.checkedFiles.has(file.path) ? 'checked' : ''}>
                <div class="file-details" data-path="${escapeHtml(file.path)}" data-change-type="${file.type}" data-idx="${idx}">
                    <div class="file-name">${escapeHtml(file.name)}</div>
                    <div class="file-path">${escapeHtml(file.dir)} · staged ${stagedTime}</div>
                </div>
                <div class="status-badge ${statusClass}">${typeChar}</div>
            </div>
        `;
    }).join('');

    updateMasterCheckbox(filteredFiles);
}

// ========================
// ACTION: STAGE CHANGES
// ========================

async function stageSelectedFiles() {
    if (AppState.checkedFiles.size === 0) {
        showNotification('No files selected to stage.', 'warning');
        return;
    }

    const stageBtn = document.getElementById('btn-stage');
    const allChanges = [
        ...AppState.changes.modified.map(f => ({ path: f.path, type: 'update' })),
        ...AppState.changes.added.map(f => ({ path: f.path, type: 'add' })),
        ...AppState.changes.deleted.map(f => ({ path: f.path, type: 'delete' }))
    ];
    const selectedFiles = allChanges.filter(f => AppState.checkedFiles.has(f.path));

    if (selectedFiles.length === 0) {
        showNotification('No files selected to stage.', 'warning');
        return;
    }

    if (stageBtn) {
        stageBtn.innerHTML = '<i class="fas fa-spinner spinner"></i> STAGING...';
        stageBtn.disabled = true;
    }

    const result = await window.syncvcs.staging.stage(AppState.currentProjectId, selectedFiles);

    if (result.success) {
        showNotification(`Staged ${result.staged} file(s) successfully!`, 'success');
        await refreshChanges();
        await refreshStagedCount();
        if (currentTab === 'staged') {
            await loadStagedFiles();
        }
    } else {
        showNotification(result.message, 'error');
    }

    if (stageBtn) {
        stageBtn.innerHTML = '<i class="fas fa-inbox"></i> STAGE CHANGES';
        stageBtn.disabled = false;
    }
}

// ========================
// ACTION: DEPLOY TO SERVER (stage + deploy)
// ========================

async function deploySelectedFiles() {
    if (AppState.checkedFiles.size === 0) {
        showNotification('No files selected for deploy.', 'warning');
        return;
    }

    if (!AppState.currentProject?.remoteUrl) {
        showNotification('No remote URL configured. Open Project Settings to set one.', 'warning');
        return;
    }

    const messageInput = document.getElementById('sync-message');
    const syncMessage = messageInput?.value?.trim() || 'Manual deploy';
    const deployBtn = document.getElementById('btn-deploy');

    const allChanges = [
        ...AppState.changes.modified.map(f => ({ path: f.path, type: 'update' })),
        ...AppState.changes.added.map(f => ({ path: f.path, type: 'add' })),
        ...AppState.changes.deleted.map(f => ({ path: f.path, type: 'delete' }))
    ];
    const selectedFiles = allChanges.filter(f => AppState.checkedFiles.has(f.path));

    if (selectedFiles.length === 0) {
        showNotification('No files selected for deploy.', 'warning');
        return;
    }

    if (deployBtn) {
        deployBtn.innerHTML = '<i class="fas fa-spinner spinner"></i> DEPLOYING...';
        deployBtn.disabled = true;
    }

    const result = await window.syncvcs.sync.syncBatch(
        AppState.currentProjectId, selectedFiles, syncMessage
    );

    if (result.success || result.succeeded > 0) {
        showNotification(
            `Deployed ${result.succeeded} file(s) to server!`,
            result.failed > 0 ? 'warning' : 'success'
        );
        if (messageInput) messageInput.value = '';
        await refreshChanges();
        await refreshStagedCount();
    } else {
        showNotification(result.message || 'Deploy failed.', result.succeeded > 0 ? 'warning' : 'error');
        if (result.errors?.length > 0) {
            result.errors.forEach(err => showNotification(`Failed: ${err.path} — ${err.error}`, 'error'));
        }
    }

    if (deployBtn) {
        deployBtn.innerHTML = '<i class="fas fa-cloud-upload-alt"></i> DEPLOY TO SERVER';
        deployBtn.disabled = false;
    }
}

// ========================
// ACTION: DEPLOY STAGED FILES
// ========================

async function deployStagedFiles() {
    if (AppState.checkedFiles.size === 0) {
        showNotification('No staged files selected for deploy.', 'warning');
        return;
    }

    if (!AppState.currentProject?.remoteUrl) {
        showNotification('No remote URL configured. Open Project Settings to set one.', 'warning');
        return;
    }

    const messageInput = document.getElementById('staged-message');
    const syncMessage = messageInput?.value?.trim() || 'Deploy staged files';
    const deployBtn = document.getElementById('btn-deploy-staged');

    const selectedFiles = (AppState.stagedFiles || []).filter(f => AppState.checkedFiles.has(f.path));

    if (selectedFiles.length === 0) {
        showNotification('No staged files selected for deploy.', 'warning');
        return;
    }

    if (deployBtn) {
        deployBtn.innerHTML = '<i class="fas fa-spinner spinner"></i> DEPLOYING...';
        deployBtn.disabled = true;
    }

    const result = await window.syncvcs.staging.deploy(
        AppState.currentProjectId, selectedFiles, syncMessage
    );

    if (result.success || result.succeeded > 0) {
        showNotification(
            `Deployed ${result.succeeded} staged file(s) to server!`,
            result.failed > 0 ? 'warning' : 'success'
        );
        if (messageInput) messageInput.value = '';
        await loadStagedFiles();
        await refreshStagedCount();
    } else {
        showNotification(result.message || 'Deploy failed.', result.succeeded > 0 ? 'warning' : 'error');
    }

    if (deployBtn) {
        deployBtn.innerHTML = '<i class="fas fa-cloud-upload-alt"></i> DEPLOY TO SERVER';
        deployBtn.disabled = false;
    }
}

// ========================
// ACTION: MARK STAGED FILES AS DEPLOYED (without syncing)
// ========================

async function markStagedAsDeployed() {
    if (AppState.checkedFiles.size === 0) {
        showNotification('No staged files selected.', 'warning');
        return;
    }

    const markBtn = document.getElementById('btn-mark-deployed');
    const selectedPaths = (AppState.stagedFiles || [])
        .filter(f => AppState.checkedFiles.has(f.path))
        .map(f => f.path);

    if (selectedPaths.length === 0) {
        showNotification('No staged files selected.', 'warning');
        return;
    }

    if (markBtn) {
        markBtn.innerHTML = '<i class="fas fa-spinner spinner"></i> MARKING...';
        markBtn.disabled = true;
    }

    const result = await window.syncvcs.staging.markDeployed(
        AppState.currentProjectId, selectedPaths
    );

    if (result.success) {
        showNotification(`Marked ${result.marked} file(s) as deployed.`, 'success');
        await loadStagedFiles();
        await refreshStagedCount();
    } else {
        showNotification(result.message || 'Operation failed.', 'error');
    }

    if (markBtn) {
        markBtn.innerHTML = '<i class="fas fa-check-double"></i> MARK AS DEPLOYED';
        markBtn.disabled = false;
    }
}

// ========================
// PAGE: HISTORY (history.html)
// ========================
async function initHistoryPage() {
    if (!window.syncvcs) return;

    const projectId = sessionStorage.getItem('currentProjectId');
    if (!projectId) {
        window.location.href = 'projects.html';
        return;
    }

    const session = await window.syncvcs.auth.getSession();
    AppState.session = session;
    AppState.currentProjectId = projectId;
    AppState.currentProject = await window.syncvcs.project.get(projectId);

    // Update titlebar
    const titleSpan = document.querySelector('.app-brand span');
    if (titleSpan && AppState.currentProject) {
        titleSpan.textContent = `SYNCVCS CLIENT - ${AppState.currentProject.name}`;
    }

    // Project Settings nav button
    const projSettingsNav = document.getElementById('nav-project-settings');
    if (projSettingsNav) {
        projSettingsNav.addEventListener('click', (e) => {
            e.preventDefault();
            showProjectSettings();
        });
    }

    await loadHistory();

    // Search
    const searchInput = document.querySelector('.search-box .app-input');
    if (searchInput) {
        searchInput.addEventListener('input', async (e) => {
            const query = e.target.value.trim();
            if (query.length > 0) {
                const results = await window.syncvcs.changelog.search(projectId, query);
                renderHistory(results);
            } else {
                await loadHistory();
            }
        });
    }
}

async function loadHistory() {
    const logs = await window.syncvcs.changelog.getLogs(AppState.currentProjectId, 50, 0);
    renderHistory(logs);
}

function renderHistory(logs) {
    const timeline = document.querySelector('.history-timeline');
    if (!timeline) return;

    if (!logs || logs.length === 0) {
        timeline.innerHTML = `
            <div style="text-align: center; padding: 80px 20px; color: var(--text-muted);">
                <i class="fas fa-history" style="font-size: 48px; opacity: 0.3; margin-bottom: 20px; display: block;"></i>
                <h3 style="color: var(--text-primary); margin-bottom: 10px; font-weight: 500;">No sync history yet</h3>
                <p style="font-size: 13px;">Deploy files to see your sync history here.</p>
            </div>
        `;
        return;
    }

    const user = AppState.session;

    timeline.innerHTML = logs.map(log => {
        const timeAgo = formatTimeAgo(log.timestamp);
        const formattedDate = new Date(log.timestamp).toLocaleString();

        const typeBadges = { add: 'a', update: 'm', delete: 'd' };
        const typeIcons = { add: 'fa-plus', update: 'fa-pen', delete: 'fa-trash' };

        return `
            <div class="history-item">
                <div class="history-card">
                    <div class="commit-header">
                        <div>
                            <div class="commit-msg">${escapeHtml(log.message)}</div>
                            <div class="commit-meta">
                                <img src="https://ui-avatars.com/api/?name=${encodeURIComponent(user?.name || 'User')}&background=2f81f7&color=fff" alt="User">
                                <span>Synced by <strong>${escapeHtml(user?.name || 'Unknown')}</strong></span>
                                <span><i class="far fa-clock"></i> ${timeAgo} (${formattedDate})</span>
                            </div>
                        </div>
                        <div class="commit-hash">#${log.versionId}</div>
                    </div>
                    ${log.files && log.files.length > 0 ? `
                        <div class="file-pills">
                            ${log.files.map(f => `
                                <span class="file-pill ${typeBadges[f.type] || 'm'}">
                                    <i class="fas ${typeIcons[f.type] || 'fa-pen'}"></i>
                                    ${escapeHtml(f.name || f.path)}
                                </span>
                            `).join('')}
                        </div>
                    ` : ''}
                </div>
            </div>
        `;
    }).join('');
}

// ========================
// PAGE: SETTINGS (settings.html)
// ========================
async function initSettingsPage() {
    if (!window.syncvcs) return;

    const session = await window.syncvcs.auth.getSession();
    AppState.session = session;

    const scrollArea = document.querySelector('.scroll-area');
    if (!scrollArea) return;

    // Add user profile section (connection test is per-project now)
    const existingSettings = scrollArea.innerHTML;

    scrollArea.innerHTML = `
        <!-- User Profile -->
        <div class="settings-group" style="max-width: 600px; margin-bottom: 30px;">
            <h3 style="color: var(--text-primary); margin-bottom: 20px; font-weight: 600; border-bottom: 1px solid var(--border); padding-bottom: 10px;">User Profile</h3>
            <div style="background: var(--bg-panel); padding: 20px; border-radius: 8px; border: 1px solid var(--border);">
                <div style="display: flex; align-items: center; gap: 15px; margin-bottom: 20px;">
                    <img src="https://ui-avatars.com/api/?name=${encodeURIComponent(session?.name || 'U')}&background=2f81f7&color=fff&size=48" 
                         style="border-radius: 50%;" alt="Avatar">
                    <div>
                        <div style="font-weight: 600; color: var(--text-primary);">${escapeHtml(session?.name || 'Unknown')}</div>
                        <div style="font-size: 12px; color: var(--text-muted);">${escapeHtml(session?.email || '')}</div>
                    </div>
                </div>
                <button class="app-btn outline" onclick="handleLogout()" style="width: auto;">
                    <i class="fas fa-sign-out-alt"></i> Sign Out
                </button>
            </div>
        </div>

        ${existingSettings}

        <!-- Info about per-project settings -->
        <div class="settings-group" style="max-width: 600px; margin-top: 30px;">
            <h3 style="color: var(--text-primary); margin-bottom: 20px; font-weight: 600; border-bottom: 1px solid var(--border); padding-bottom: 10px;">Remote Connection</h3>
            <div style="background: var(--bg-panel); padding: 20px; border-radius: 8px; border: 1px solid var(--border);">
                <p style="color: var(--text-muted); font-size: 13px; line-height: 1.6;">
                    <i class="fas fa-info-circle" style="color: var(--accent);"></i>
                    Remote server URLs are configured <strong style="color: var(--text-primary);">per project</strong>. 
                    To set or test a connection, open a project and click the 
                    <i class="fas fa-sliders-h" style="color: var(--accent);"></i> 
                    <strong style="color: var(--text-primary);">Project Settings</strong> icon in the sidebar.
                </p>
            </div>
        </div>
    `;
}

async function handleLogout() {
    await window.syncvcs.auth.logout();
    sessionStorage.removeItem('currentProjectId');
    showNotification('Signed out.', 'info');
    setTimeout(() => window.location.href = 'index.html', 500);
}

// ========================
// PROJECT SETTINGS PANEL (Modal overlay)
// ========================
async function showProjectSettings() {
    if (!AppState.currentProject) return;

    const project = AppState.currentProject;

    // Remove existing modal if any
    const existing = document.getElementById('project-settings-modal');
    if (existing) existing.remove();

    const modal = document.createElement('div');
    modal.id = 'project-settings-modal';
    modal.style.cssText = `
        position: fixed; inset: 0; z-index: 9999;
        background: rgba(0,0,0,0.6); backdrop-filter: blur(4px);
        display: flex; align-items: center; justify-content: center;
        animation: fadeIn 0.2s ease;
    `;

    modal.innerHTML = `
        <div style="
            background: var(--bg-panel); border: 1px solid var(--border); border-radius: 12px;
            width: 520px; max-height: 80vh; overflow-y: auto;
            box-shadow: 0 25px 60px rgba(0,0,0,0.5); padding: 30px;
        ">
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 25px;">
                <h3 style="color: var(--text-primary); font-size: 18px; font-weight: 600; display: flex; align-items: center; gap: 10px;">
                    <i class="fas fa-sliders-h" style="color: var(--accent);"></i> Project Settings
                </h3>
                <button onclick="document.getElementById('project-settings-modal').remove()" 
                    style="background: none; border: none; color: var(--text-muted); cursor: pointer; font-size: 18px; padding: 5px;">
                    <i class="fas fa-times"></i>
                </button>
            </div>

            <div class="form-group">
                <label class="form-label">Project Name</label>
                <input type="text" class="app-input" id="ps-name" value="${escapeHtml(project.name)}">
            </div>

            <div class="form-group">
                <label class="form-label">Local Folder</label>
                <input type="text" class="app-input" value="${escapeHtml(project.folderPath)}" readonly 
                    style="background: var(--bg-darker); opacity: 0.7;">
            </div>

            <div class="form-group">
                <label class="form-label">Remote Server URL <span style="color: var(--warn); font-weight: 400;">(this project only)</span></label>
                <input type="text" class="app-input" id="ps-remote-url" value="${escapeHtml(project.remoteUrl || '')}" 
                    placeholder="https://your-server.com">
            </div>

            <div class="form-group">
                <label class="form-label">Description</label>
                <textarea class="app-input push-textarea" id="ps-description" 
                    style="min-height: 60px; margin-bottom: 0;">${escapeHtml(project.description || '')}</textarea>
            </div>

            <!-- Connection Test (per-project) -->
            <div style="background: var(--bg-darker); border: 1px solid var(--border); border-radius: 8px; padding: 15px; margin-bottom: 20px;">
                <div style="display: flex; justify-content: space-between; align-items: center;">
                    <span style="font-size: 12px; color: var(--text-muted); font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px;">CONNECTION TEST</span>
                    <button class="app-btn outline sm" id="ps-test-btn" style="width: auto;">
                        <i class="fas fa-plug"></i> Test
                    </button>
                </div>
                <div id="ps-connection-result" style="margin-top: 10px; font-size: 13px;"></div>
            </div>

            <div style="display: flex; gap: 12px; justify-content: flex-end;">
                <button class="app-btn outline" onclick="document.getElementById('project-settings-modal').remove()" style="width: auto;">
                    Cancel
                </button>
                <button class="app-btn success" id="ps-save-btn" style="width: auto;">
                    <i class="fas fa-save"></i> Save Changes
                </button>
            </div>
        </div>
    `;

    document.body.appendChild(modal);

    // Close on backdrop click
    modal.addEventListener('click', (e) => {
        if (e.target === modal) modal.remove();
    });

    // Test connection button
    document.getElementById('ps-test-btn').addEventListener('click', async () => {
        const url = document.getElementById('ps-remote-url').value.trim();
        if (!url) {
            showNotification('Enter a remote URL first.', 'warning');
            return;
        }

        const btn = document.getElementById('ps-test-btn');
        btn.innerHTML = '<i class="fas fa-spinner spinner"></i> Testing...';
        btn.disabled = true;

        const result = await window.syncvcs.sync.testConnection(url);
        const resultDiv = document.getElementById('ps-connection-result');

        if (result.success) {
            resultDiv.innerHTML = `<span style="color: var(--success);"><i class="fas fa-check-circle"></i> Connected! Latency: ${result.latency}</span>`;
        } else {
            resultDiv.innerHTML = `<span style="color: var(--danger);"><i class="fas fa-times-circle"></i> ${escapeHtml(result.message)}</span>`;
        }

        btn.innerHTML = '<i class="fas fa-plug"></i> Test';
        btn.disabled = false;
    });

    // Save button
    document.getElementById('ps-save-btn').addEventListener('click', async () => {
        const name = document.getElementById('ps-name').value.trim();
        const remoteUrl = document.getElementById('ps-remote-url').value.trim();
        const description = document.getElementById('ps-description').value.trim();

        if (!name) {
            showNotification('Project name cannot be empty.', 'warning');
            return;
        }

        const result = await window.syncvcs.project.update(AppState.currentProjectId, {
            name, remoteUrl, description
        });

        if (result.success) {
            AppState.currentProject = result.project;
            // Update titlebar
            const titleSpan = document.querySelector('.app-brand span');
            if (titleSpan) {
                titleSpan.textContent = `SYNCVCS CLIENT - ${name}`;
            }
            showNotification('Project settings saved!', 'success');
            modal.remove();
        } else {
            showNotification(result.message, 'error');
        }
    });
}

// ========================
// HELPERS
// ========================
function escapeHtml(str) {
    if (!str) return '';
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

function formatTimeAgo(dateStr) {
    const now = new Date();
    const then = new Date(dateStr);
    const diffMs = now - then;
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);

    if (diffMins < 1) return 'Just now';
    if (diffMins < 60) return `${diffMins} min ago`;
    if (diffHours < 24) return `${diffHours} hours ago`;
    if (diffDays < 7) return `${diffDays} days ago`;
    return then.toLocaleDateString();
}

// ========================
// SERVER SETUP GUIDE MODAL
// ========================
function showServerSetupGuide() {
    const existing = document.getElementById('server-setup-modal');
    if (existing) existing.remove();

    const modal = document.createElement('div');
    modal.id = 'server-setup-modal';
    modal.style.cssText = `
        position: fixed; inset: 0; z-index: 9999;
        background: rgba(0,0,0,0.6); backdrop-filter: blur(4px);
        display: flex; align-items: center; justify-content: center;
        animation: fadeIn 0.2s ease;
    `;

    modal.innerHTML = `
        <div style="
            background: var(--bg-panel); border: 1px solid var(--border); border-radius: 12px;
            width: 600px; max-height: 85vh; overflow-y: auto;
            box-shadow: 0 25px 60px rgba(0,0,0,0.5); padding: 30px;
        ">
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 25px;">
                <h3 style="color: var(--text-primary); font-size: 18px; font-weight: 600; display: flex; align-items: center; gap: 10px;">
                    <i class="fas fa-server" style="color: var(--accent);"></i> Server Setup Guide
                </h3>
                <button onclick="document.getElementById('server-setup-modal').remove()" 
                    style="background: none; border: none; color: var(--text-muted); cursor: pointer; font-size: 18px; padding: 5px;">
                    <i class="fas fa-times"></i>
                </button>
            </div>

            <div style="background: var(--bg-darker); border-radius: 8px; padding: 20px; margin-bottom: 20px; border: 1px solid var(--border);">
                <h4 style="color: var(--accent); font-size: 14px; margin-bottom: 15px;">
                    <i class="fas fa-download"></i> Step 1: Download the PHP Handler
                </h4>
                <p style="color: var(--text-muted); font-size: 13px; margin-bottom: 15px; line-height: 1.6;">
                    The PHP handler file (<code style="color: var(--accent); background: rgba(47,129,247,0.1); padding: 2px 6px; border-radius: 4px;">sync-ftp.php</code>) 
                    is the server-side component that receives and writes files from the SyncVCS desktop client.
                </p>
                <button class="app-btn" id="btn-download-php" style="width: auto;">
                    <i class="fas fa-file-download"></i> Download sync-ftp.php
                </button>
            </div>

            <div style="background: var(--bg-darker); border-radius: 8px; padding: 20px; margin-bottom: 20px; border: 1px solid var(--border);">
                <h4 style="color: var(--accent); font-size: 14px; margin-bottom: 15px;">
                    <i class="fas fa-upload"></i> Step 2: Upload to Your Server
                </h4>
                <p style="color: var(--text-muted); font-size: 13px; line-height: 1.6;">
                    Upload <code style="color: var(--accent); background: rgba(47,129,247,0.1); padding: 2px 6px; border-radius: 4px;">sync-ftp.php</code> 
                    to the root of your PHP-enabled web server (e.g., <code style="color: var(--text-primary);">public_html/</code> 
                    or your web root directory). The file will automatically create a
                    <code style="color: var(--text-primary);">synced-files/</code> directory where deployed files are stored.
                </p>
            </div>

            <div style="background: var(--bg-darker); border-radius: 8px; padding: 20px; margin-bottom: 20px; border: 1px solid var(--border);">
                <h4 style="color: var(--accent); font-size: 14px; margin-bottom: 15px;">
                    <i class="fas fa-key"></i> Step 3: Set Your Secure Key
                </h4>
                <p style="color: var(--text-muted); font-size: 13px; line-height: 1.6; margin-bottom: 10px;">
                    Open <code style="color: var(--accent);">sync-ftp.php</code> and change the <code style="color: var(--text-primary);">SECURE_KEY</code> constant to a unique secret:
                </p>
                <div style="background: var(--bg-panel); padding: 12px; border-radius: 6px; font-family: 'Menlo', 'Courier New', monospace; font-size: 12px; color: var(--text-primary); overflow-x: auto;">
                    define('SECURE_KEY', '<span style="color: var(--warn);">YOUR_UNIQUE_SECRET_HERE</span>');
                </div>
                <p style="color: var(--text-muted); font-size: 12px; margin-top: 10px;">
                    <i class="fas fa-exclamation-triangle" style="color: var(--warn);"></i>
                    <strong style="color: var(--warn);">Important:</strong> The same key must be set in the desktop client's 
                    <code style="color: var(--text-primary);">src/services/sync.service.js</code> file.
                </p>
            </div>

            <div style="background: var(--bg-darker); border-radius: 8px; padding: 20px; margin-bottom: 20px; border: 1px solid var(--border);">
                <h4 style="color: var(--accent); font-size: 14px; margin-bottom: 15px;">
                    <i class="fas fa-link"></i> Step 4: Configure Your Project
                </h4>
                <p style="color: var(--text-muted); font-size: 13px; line-height: 1.6;">
                    When creating or editing a project, set the <strong style="color: var(--text-primary);">Remote Server URL</strong> to your server's base URL 
                    (e.g., <code style="color: var(--text-primary);">https://your-domain.com</code>). SyncVCS will automatically 
                    append <code style="color: var(--text-primary);">/sync-ftp.php</code> to it.
                </p>
            </div>

            <div style="background: var(--bg-darker); border-radius: 8px; padding: 20px; border: 1px solid var(--border);">
                <h4 style="color: var(--accent); font-size: 14px; margin-bottom: 15px;">
                    <i class="fas fa-check-circle"></i> Step 5: Test Connection
                </h4>
                <p style="color: var(--text-muted); font-size: 13px; line-height: 1.6;">
                    Open your project, click the <i class="fas fa-sliders-h" style="color: var(--accent);"></i> 
                    <strong style="color: var(--text-primary);">Project Settings</strong> button in the sidebar, 
                    and use the <strong style="color: var(--text-primary);">Test Connection</strong> button to verify everything works.
                </p>
            </div>

            <div style="text-align: center; margin-top: 20px;">
                <button class="app-btn outline" onclick="document.getElementById('server-setup-modal').remove()" style="width: auto;">
                    <i class="fas fa-check"></i> Got it!
                </button>
            </div>
        </div>
    `;

    document.body.appendChild(modal);

    // Close on backdrop click
    modal.addEventListener('click', (e) => {
        if (e.target === modal) modal.remove();
    });

    // Download PHP button handler
    document.getElementById('btn-download-php').addEventListener('click', async () => {
        const btn = document.getElementById('btn-download-php');
        btn.innerHTML = '<i class="fas fa-spinner spinner"></i> Saving...';
        btn.disabled = true;

        const result = await window.syncvcs.util.downloadPhpFile();
        if (result.success) {
            showNotification(`PHP file saved to: ${result.path}`, 'success');
        } else if (result.message) {
            showNotification(`Failed: ${result.message}`, 'error');
        }

        btn.innerHTML = '<i class="fas fa-file-download"></i> Download sync-ftp.php';
        btn.disabled = false;
    });
}

// ========================
// PAGE ROUTER (auto-detects current page)
// ========================
document.addEventListener('DOMContentLoaded', () => {


    const currentPage = window.location.pathname.split('/').pop() || 'index.html';

    switch (currentPage) {
        case 'index.html':
            initAuthPage();
            break;
        case 'projects.html':
            initProjectsPage();
            break;
        case 'new-project.html':
            initNewProjectPage();
            break;
        case 'changes.html':
            initChangesPage();
            break;
        case 'history.html':
            initHistoryPage();
            break;
        case 'settings.html':
            initSettingsPage();
            break;
    }

    // Theme toggle support
    const savedTheme = localStorage.getItem('vcs-theme') || 'dark';
    if (savedTheme === 'light') {
        document.body.classList.add('light-theme');
    }
});

// Global theme toggle function
function toggleTheme() {
    const isLight = document.body.classList.toggle('light-theme');
    localStorage.setItem('vcs-theme', isLight ? 'light' : 'dark');
}
