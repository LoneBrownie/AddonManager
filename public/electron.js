const { app, BrowserWindow, dialog, ipcMain } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');
const fs = require('fs').promises;
const fssync = require('fs');

// Better development check - look for build folder and dev environment
const isDev = process.env.NODE_ENV === 'development' || !app.isPackaged;

// Security: Enable security warnings in development
if (isDev) {
  process.env.ELECTRON_ENABLE_SECURITY_WARNINGS = 'true';
}

let mainWindow;

function createWindow() {
  // Create the browser window with secure configurations
  mainWindow = new BrowserWindow({
    width: 1440,  // 1200 * 1.2 = 1440
    height: 960,  // 800 * 1.2 = 960
    autoHideMenuBar: true, // Hide the File/Edit/View/Window/Help menu bar
    // Resolve icon path: prefer a Logo.ico next to this file, otherwise check repo assets (useful in dev)
    icon: (function resolveIcon() {
      try {
        const candidates = [
          path.join(__dirname, 'Logo.ico'),
          path.join(__dirname, '..', 'assets', 'Logo.ico')
        ];
        for (const c of candidates) {
          if (fssync.existsSync(c)) return c;
        }
      } catch (e) {
        // ignore and let Electron use default
      }
      return undefined;
    })(), // Application icon
    title: "Brownie's Addon Manager", // Set window title
    webPreferences: {
      // ✅ Security: Disable Node.js integration in renderer
      nodeIntegration: false,
      // ✅ Security: Enable context isolation
      contextIsolation: true,
      // ✅ Security: Enable web security
      webSecurity: true,
      // ✅ Security: Use preload script for secure IPC
      preload: path.join(__dirname, 'preload.js'),
      // ✅ Security: Disable remote module
      enableRemoteModule: false,
      // ✅ Security: Disable experimental features
      experimentalFeatures: false,
      // ✅ Security: Enable sandbox
      sandbox: false, // We need file system access, but we'll use secure IPC
      // ✅ Security: Disable allowRunningInsecureContent
      allowRunningInsecureContent: false
    },
    show: false,
    // ✅ Security: Set minimum window size
    minWidth: 800,
    minHeight: 600
  });

  // Load the app
  if (isDev) {
    // Development: Load from localhost
    mainWindow.loadURL('http://localhost:3000');
    // Open DevTools in development
    mainWindow.webContents.openDevTools();
  } else {
    // Production: Load from built files
    const indexPath = path.join(__dirname, '../build/index.html');
    mainWindow.loadFile(indexPath);
  }

  // Add Content Security Policy for production
  if (!isDev) {
    mainWindow.webContents.session.webRequest.onHeadersReceived((details, callback) => {
      callback({
        responseHeaders: {
          ...details.responseHeaders,
          'Content-Security-Policy': [
            "default-src 'self'; " +
            "script-src 'self' 'unsafe-inline'; " +
            "style-src 'self' 'unsafe-inline'; " +
            "img-src 'self' data: https:; " +
            "connect-src 'self' https://api.github.com https://gitlab.com; " +
            "font-src 'self';"
          ]
        }
      });
    });
  }

  // Show window when ready
  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// App event handlers
app.whenReady().then(() => {
  // Set the app icon for taskbar and app lists
  if (process.platform === 'win32') {
    app.setAppUserModelId("com.brownies.addon-manager");
  }
  
  createWindow();
  
  // Configure auto-updater (only for production builds)
  if (!isDev) {
    autoUpdater.setFeedURL({
      provider: 'github',
      owner: 'LoneBrownie',
      repo: 'AddonManager'
    });
    
    // Configure silent updates
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    
    // Check for updates 30 seconds after app start
    setTimeout(() => {
      autoUpdater.checkForUpdatesAndNotify();
    }, 30000);
    
    // Check for updates every 6 hours
    setInterval(() => {
      autoUpdater.checkForUpdatesAndNotify();
    }, 6 * 60 * 60 * 1000);
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

// Auto-updater event handlers
autoUpdater.on('checking-for-update', () => {
  console.log('Checking for update...');
  if (mainWindow) {
    mainWindow.webContents.send('update-status', 'checking');
  }
});

autoUpdater.on('update-available', (info) => {
  console.log('Update available.');
  if (mainWindow) {
    mainWindow.webContents.send('update-status', 'available', info);
  }
});

autoUpdater.on('update-not-available', (info) => {
  console.log('Update not available.');
  if (mainWindow) {
    mainWindow.webContents.send('update-status', 'not-available', info);
  }
});

autoUpdater.on('error', (err) => {
  console.log('Error in auto-updater: ', err);
  if (mainWindow) {
    mainWindow.webContents.send('update-status', 'error', err.message);
  }
});

autoUpdater.on('download-progress', (progressObj) => {
  let log_message = "Download speed: " + progressObj.bytesPerSecond;
  log_message = log_message + ' - Downloaded ' + progressObj.percent + '%';
  log_message = log_message + ' (' + progressObj.transferred + "/" + progressObj.total + ')';
  console.log(log_message);
  if (mainWindow) {
    mainWindow.webContents.send('update-progress', progressObj);
  }
});

autoUpdater.on('update-downloaded', (info) => {
  console.log('Update downloaded');
  if (mainWindow) {
    mainWindow.webContents.send('update-status', 'downloaded', info);
  }
  
  // Automatically restart and install silently after 3 seconds
  console.log('Installing update and restarting...');
  setTimeout(() => {
    autoUpdater.quitAndInstall(true, true); // Silent install and force restart
  }, 3000);
});

// IPC handlers for secure file operations
ipcMain.handle('select-directory', async () => {
  if (!mainWindow) return null;
  
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
    title: 'Select WoW Installation Directory'
  });
  
  if (!result.canceled && result.filePaths.length > 0) {
    return result.filePaths[0];
  }
  return null;
});

ipcMain.handle('read-file', async (event, filePath) => {
  try {
    // ✅ Security: Validate file path
    if (!filePath || typeof filePath !== 'string') {
      throw new Error('Invalid file path');
    }
    
    const content = await fs.readFile(filePath, 'utf8');
    return content;
  } catch (error) {
    throw new Error(`Failed to read file: ${error.message}`);
  }
});

ipcMain.handle('write-file', async (event, filePath, content, encoding = 'utf8') => {
  try {
    // ✅ Security: Validate inputs
    if (!filePath || typeof filePath !== 'string') {
      throw new Error('Invalid file path');
    }
    if (typeof content !== 'string') {
      throw new Error('Invalid content type');
    }
    
    // Handle base64 encoding for binary files
    if (encoding === 'base64') {
      const buffer = Buffer.from(content, 'base64');
      await fs.writeFile(filePath, buffer);
    } else {
      await fs.writeFile(filePath, content, encoding);
    }
    return true;
  } catch (error) {
    throw new Error(`Failed to write file: ${error.message}`);
  }
});

ipcMain.handle('check-directory', async (event, dirPath) => {
  try {
    if (!dirPath || typeof dirPath !== 'string') {
      return false;
    }
    
    const stats = await fs.stat(dirPath);
    return stats.isDirectory();
  } catch (error) {
    return false;
  }
});

ipcMain.handle('open-external', async (event, url) => {
  const { shell } = require('electron');
  try {
    // ✅ Security: Additional URL validation in main process
    const urlObj = new URL(url);
    if (urlObj.protocol === 'https:' || urlObj.protocol === 'http:') {
      await shell.openExternal(url);
      return true;
    }
    return false;
  } catch (error) {
    console.error('Failed to open external URL:', error);
    return false;
  }
});

// Check if the app is running with elevated privileges (Windows only)
ipcMain.handle('is-elevated', async () => {
  try {
    if (process.platform !== 'win32') {
      return false; // Not Windows, elevation doesn't apply
    }

    // On Windows, check if we're running as admin
    const { execSync } = require('child_process');
    try {
      // This command will throw an error if not running as admin
      execSync('net session', { stdio: 'ignore' });
      return true; // Running as admin
    } catch (error) {
      return false; // Not running as admin
    }
  } catch (error) {
    console.error('Error checking elevation status:', error);
    return false; // Assume not elevated on error
  }
});

// Restart the app elevated (Windows only)
ipcMain.handle('restart-as-admin', async () => {
  try {
    if (process.platform !== 'win32') {
      throw new Error('Elevated restart is only supported on Windows');
    }

    // Get the correct executable path
    let exePath;
    if (app.isPackaged) {
      // In production, use the app executable
      exePath = process.execPath;
    } else {
      // In development, restart the npm script or electron command
      // Since we can't easily restart the dev environment elevated,
      // we'll show an error message instead
      throw new Error('Cannot restart development environment as admin. Please manually restart the application as Administrator.');
    }

    // Use PowerShell to start the process elevated
    const { execFile } = require('child_process');
    const psCommand = `Start-Process -FilePath '"${exePath}"' -Verb runAs`;

    // Spawn powershell to run the elevation command
    execFile('powershell', ['-Command', psCommand], (error) => {
      if (error) {
        console.error('Failed to relaunch elevated:', error);
      }
      // Quit the current app regardless (the elevated instance may have started)
      app.quit();
    });

    return true;
  } catch (error) {
    console.error('restart-as-admin error:', error);
    throw error;
  }
});

// Additional IPC handlers for addon management
ipcMain.handle('create-directory', async (event, dirPath) => {
  try {
    // ✅ Security: Validate path
    if (!dirPath || typeof dirPath !== 'string') {
      throw new Error('Invalid directory path');
    }
    
    await fs.mkdir(dirPath, { recursive: true });
    return true;
  } catch (error) {
    console.error('Failed to create directory:', error);
    throw error;
  }
});

ipcMain.handle('read-directory', async (event, dirPath) => {
  try {
    // ✅ Security: Validate path
    if (!dirPath || typeof dirPath !== 'string') {
      throw new Error('Invalid directory path');
    }
    
    const files = await fs.readdir(dirPath, { withFileTypes: true });
    return files.map(file => ({
      name: file.name,
      isDirectory: file.isDirectory(),
      isFile: file.isFile()
    }));
  } catch (error) {
    console.error('Failed to read directory:', error);
    throw error;
  }
});

ipcMain.handle('extract-zip', async (event, zipPath, extractPath) => {
  try {
    // ✅ Security: Validate paths
    if (!zipPath || !extractPath || typeof zipPath !== 'string' || typeof extractPath !== 'string') {
      throw new Error('Invalid zip or extract path');
    }
    
    const AdmZip = require('adm-zip');
    const zip = new AdmZip(zipPath);
    
    // ✅ Security: Ensure extraction directory exists
    await fs.mkdir(extractPath, { recursive: true });
    
    // Extract all files
    zip.extractAllTo(extractPath, true);
    
    return true;
  } catch (error) {
    console.error('Failed to extract zip:', error);
    throw error;
  }
});

ipcMain.handle('delete-file', async (event, filePath) => {
  try {
    // ✅ Security: Validate path
    if (!filePath || typeof filePath !== 'string') {
      throw new Error('Invalid file path');
    }
    
    await fs.unlink(filePath);
    return true;
  } catch (error) {
    // If file doesn't exist, that's fine - consider it already deleted
    if (error.code === 'ENOENT') {
      return true;
    }
    console.error('Failed to delete file:', error);
    throw error;
  }
});

ipcMain.handle('get-file-stats', async (event, filePath) => {
  try {
    // ✅ Security: Validate path
    if (!filePath || typeof filePath !== 'string') {
      throw new Error('Invalid file path');
    }
    
    const stats = await fs.stat(filePath);
    return {
      isFile: stats.isFile(),
      isDirectory: stats.isDirectory(),
      size: stats.size,
      mtime: stats.mtime
    };
  } catch (error) {
    // File doesn't exist or other error
    return null;
  }
});

ipcMain.handle('copy-folder-recursive', async (event, sourcePath, destPath) => {
  try {
    // ✅ Security: Validate paths
    if (!sourcePath || !destPath || typeof sourcePath !== 'string' || typeof destPath !== 'string') {
      throw new Error('Invalid source or destination path');
    }
    
    const stats = await fs.stat(sourcePath);
    if (!stats.isDirectory()) {
      throw new Error('Source path is not a directory');
    }
    
    // Create destination directory
    await fs.mkdir(destPath, { recursive: true });
    
    // Read source directory
    const files = await fs.readdir(sourcePath, { withFileTypes: true });
    
    // Copy each file/folder
    for (const file of files) {
      const srcFile = path.join(sourcePath, file.name);
      const destFile = path.join(destPath, file.name);
      
      if (file.isDirectory()) {
        // Recursively copy directories
        await copyFolderRecursiveInternal(srcFile, destFile);
      } else {
        // Copy files
        await fs.copyFile(srcFile, destFile);
      }
    }
    
    return true;
  } catch (error) {
    console.error('Failed to copy folder:', error);
    throw error;
  }
});

// Internal helper function for recursive copying
async function copyFolderRecursiveInternal(sourcePath, destPath) {
  const stats = await fs.stat(sourcePath);
  if (!stats.isDirectory()) {
    // It's a file, copy it
    await fs.copyFile(sourcePath, destPath);
    return;
  }
  
  // Create destination directory
  await fs.mkdir(destPath, { recursive: true });
  
  // Read source directory
  const files = await fs.readdir(sourcePath, { withFileTypes: true });
  
  // Copy each file/folder
  for (const file of files) {
    const srcFile = path.join(sourcePath, file.name);
    const destFile = path.join(destPath, file.name);
    
    if (file.isDirectory()) {
      await copyFolderRecursiveInternal(srcFile, destFile);
    } else {
      await fs.copyFile(srcFile, destFile);
    }
  }
}

ipcMain.handle('download-file', async (event, url, destinationPath) => {
  try {
    // ✅ Security: Validate inputs
    if (!url || !destinationPath || typeof url !== 'string' || typeof destinationPath !== 'string') {
      throw new Error('Invalid URL or destination path');
    }
    
    // ✅ Security: Validate URL format
    const urlObj = new URL(url);
    if (urlObj.protocol !== 'https:' && urlObj.protocol !== 'http:') {
      throw new Error('Only HTTP and HTTPS URLs are allowed');
    }
    
    const https = require('https');
    const http = require('http');
    const fs = require('fs');
    
    function downloadWithRedirects(downloadUrl, maxRedirects = 5) {
      return new Promise((resolve, reject) => {
        if (maxRedirects <= 0) {
          reject(new Error('Too many redirects'));
          return;
        }
        
        const urlObj = new URL(downloadUrl);
        const client = urlObj.protocol === 'https:' ? https : http;
        
        const options = {
          headers: {
            'User-Agent': 'Wow-Addon-Manager/1.0 (+https://github.com)',
            'Accept': '*/*'
          }
        };

        const request = client.get(downloadUrl, options, (response) => {
          // Handle redirects
          if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
            response.resume(); // Consume response data to free memory
            // Recursively follow redirect
            downloadWithRedirects(response.headers.location, maxRedirects - 1)
              .then(resolve)
              .catch(reject);
            return;
          }
          
          if (response.statusCode !== 200) {
            reject(new Error(`Download failed: ${response.statusCode} ${response.statusMessage}`));
            return;
          }
          
          const fileStream = fs.createWriteStream(destinationPath);
          response.pipe(fileStream);
          
          fileStream.on('finish', () => {
            fileStream.close();
            resolve(destinationPath);
          });
          
          fileStream.on('error', (error) => {
            fs.unlink(destinationPath, () => {}); // Clean up on error
            reject(error);
          });
          
          response.on('error', (error) => {
            fs.unlink(destinationPath, () => {}); // Clean up on error
            reject(error);
          });
        });
        
        request.on('error', reject);
        request.setTimeout(30000, () => {
          request.destroy();
          reject(new Error('Download timeout'));
        });
      });
    }
    
    return await downloadWithRedirects(url);
    
  } catch (error) {
    throw new Error(`Download failed: ${error.message}`);
  }
});

ipcMain.handle('remove-directory', async (event, dirPath) => {
  try {
    // ✅ Security: Validate path
    if (!dirPath || typeof dirPath !== 'string') {
      throw new Error('Invalid directory path');
    }
    
    await fs.rm(dirPath, { recursive: true });
    return true;
  } catch (error) {
    // If directory doesn't exist, that's fine - consider it already removed
    if (error.code === 'ENOENT') {
      return true;
    }
    console.error('Failed to remove directory:', error);
    throw error;
  }
});

// User data storage handlers for persistent data across app updates
ipcMain.handle('save-user-data', async (event, key, data) => {
  try {
    // ✅ Security: Validate inputs
    if (!key || typeof key !== 'string') {
      throw new Error('Invalid key');
    }
    
    const userDataPath = app.getPath('userData');
    const dataFilePath = path.join(userDataPath, `${key}.json`);
    
    // Ensure user data directory exists
    await fs.mkdir(userDataPath, { recursive: true });
    
    // Save data as JSON
    await fs.writeFile(dataFilePath, JSON.stringify(data, null, 2), 'utf8');
    return true;
  } catch (error) {
    console.error('Failed to save user data:', error);
    throw new Error(`Failed to save user data: ${error.message}`);
  }
});

ipcMain.handle('load-user-data', async (event, key) => {
  try {
    // ✅ Security: Validate inputs
    if (!key || typeof key !== 'string') {
      throw new Error('Invalid key');
    }
    
    const userDataPath = app.getPath('userData');
    const dataFilePath = path.join(userDataPath, `${key}.json`);
    
    try {
      const content = await fs.readFile(dataFilePath, 'utf8');
      return JSON.parse(content);
    } catch (error) {
      // File doesn't exist or is corrupted, return null
      if (error.code === 'ENOENT') {
        return null;
      }
      console.error('Failed to parse user data:', error);
      return null;
    }
  } catch (error) {
    console.error('Failed to load user data:', error);
    return null;
  }
});

// Update-related IPC handlers
ipcMain.handle('get-app-version', async () => {
  return app.getVersion();
});

// Show a native context menu and return the selected id
ipcMain.handle('show-context-menu', async (event, items) => {
  try {
    if (!Array.isArray(items)) throw new Error('Invalid menu items');
    const { Menu } = require('electron');

    // Build a radio menu so the current choice is visually checked
    const template = items.map(it => ({
      label: String(it.label || ''),
      type: 'radio',
      checked: !!it.checked,
      id: it.id,
      click: () => {
        // No-op here; we'll resolve via promise mapping below
      }
    }));

    return await new Promise((resolve) => {
      // Attach click handlers that resolve with the selected id
      const mapped = template.map((t, idx) => ({
        label: t.label,
        type: 'radio',
        checked: !!items[idx].checked,
        click: () => resolve(items[idx].id)
      }));

      const menu = Menu.buildFromTemplate(mapped);
      menu.popup({ window: BrowserWindow.fromWebContents(event.sender) });

      // If the menu is dismissed without selection, resolve null after a short timeout
      setTimeout(() => resolve(null), 5000);
    });
  } catch (error) {
    console.error('show-context-menu error:', error);
    return null;
  }
});

ipcMain.handle('check-for-updates', async () => {
  if (isDev) {
    return { message: 'Updates not available in development mode' };
  }
  
  try {
    const result = await autoUpdater.checkForUpdates();
    return result;
  } catch (error) {
    throw new Error(`Failed to check for updates: ${error.message}`);
  }
});

ipcMain.handle('install-update', async () => {
  if (isDev) {
    throw new Error('Updates not available in development mode');
  }
  
  console.log('Manual update install triggered');
  autoUpdater.quitAndInstall(true, true); // Silent install and force restart
});

// Fetch release/tag via web in main process to avoid renderer CORS issues
ipcMain.handle('fetch-release-web', async (event, repoUrl) => {
  try {
    if (!repoUrl || typeof repoUrl !== 'string') throw new Error('Invalid repoUrl');
    const repoInfo = (function parse(url) {
      try {
        const u = new URL(url);
        const host = u.hostname.toLowerCase();
        const parts = u.pathname.split('/').filter(Boolean);
        if ((host === 'github.com' || host === 'www.github.com') && parts.length >= 2) {
          return { platform: 'github', owner: parts[0], repo: parts[1] };
        }
        if ((host === 'gitlab.com' || host === 'www.gitlab.com') && parts.length >= 2) {
          return { platform: 'gitlab', owner: parts[0], repo: parts[1] };
        }
      } catch (err) {
        return null;
      }
      return null;
    })(repoUrl);

    if (!repoInfo) throw new Error('Unsupported or invalid repo URL');

    const https = require('https');
    const http = require('http');

    function fetchText(url) {
      return new Promise((resolve, reject) => {
        try {
          const urlObj = new URL(url);
          const client = urlObj.protocol === 'https:' ? https : http;
          const req = client.get(urlObj, { headers: { 'User-Agent': 'Wow-Addon-Manager/1.0' } }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk.toString());
            res.on('end', () => resolve({ status: res.statusCode, url: res.responseUrl || urlObj.href, text: data }));
          });
          req.on('error', reject);
        } catch (err) {
          reject(err);
        }
      });
    }

    // Try platform-specific web flows
    if (repoInfo.platform === 'github') {
      // 1) Try /releases/latest redirect
      try {
        const releasesLatest = `https://github.com/${repoInfo.owner}/${repoInfo.repo}/releases/latest`;
        const r = await fetchText(releasesLatest);
        // If the server redirected, res.url may include final URL; fallback to header parsing
        const finalUrl = r.url || '';
        const m = (finalUrl.match(/\/releases\/tag\/(.+)$/) || [])[1];
        if (m) {
          const tag = decodeURIComponent(m);
          return { version: tag, downloadUrl: `https://codeload.github.com/${repoInfo.owner}/${repoInfo.repo}/zip/${tag}`, source: 'release-web' };
        }
      } catch (err) { /** ignore */ }

      // 2) Fetch releases page and look for /releases/tag/ link
      try {
        const list = await fetchText(`https://github.com/${repoInfo.owner}/${repoInfo.repo}/releases`);
        if (list.status === 200 && list.text) {
          const m = list.text.match(/\/releases\/tag\/([\w%\-.+]+)/);
          if (m && m[1]) {
            const tag = decodeURIComponent(m[1]);
            return { version: tag, downloadUrl: `https://codeload.github.com/${repoInfo.owner}/${repoInfo.repo}/zip/${tag}`, source: 'release-web' };
          }
        }
      } catch (err) { /** ignore */ }

      // 3) Fallback to tags page
      try {
        const tags = await fetchText(`https://github.com/${repoInfo.owner}/${repoInfo.repo}/tags`);
        if (tags.status === 200 && tags.text) {
          const m = tags.text.match(/\/(?:[^\/]+)\/(?:[^\/]+)\/tree\/([\w%\-.+]+)/) || tags.text.match(/\/releases\/tag\/([\w%\-.+]+)/);
          if (m && m[1]) {
            const tag = decodeURIComponent(m[1]);
            return { version: tag, downloadUrl: `https://codeload.github.com/${repoInfo.owner}/${repoInfo.repo}/zip/${tag}`, source: 'tag-web' };
          }
        }
      } catch (err) { /** ignore */ }
    }

    if (repoInfo.platform === 'gitlab') {
      try {
        const releasesLatest = `https://gitlab.com/${repoInfo.owner}/${repoInfo.repo}/-/releases/latest`;
        const r = await fetchText(releasesLatest);
        const finalUrl = r.url || '';
  const m = (finalUrl.match(/\/-\/releases\/(?:[^\/]+)\/(.+)$/) || finalUrl.match(/\/-\/releases\/(.+)$/) || [])[1];
        if (m) {
          const tag = decodeURIComponent(m);
          return { version: tag, downloadUrl: `https://gitlab.com/${repoInfo.owner}/${repoInfo.repo}/-/archive/${tag}/${repoInfo.repo}-${tag}.zip`, source: 'release-web' };
        }
      } catch (err) { /** ignore */ }

      try {
        const list = await fetchText(`https://gitlab.com/${repoInfo.owner}/${repoInfo.repo}/-/releases`);
        if (list.status === 200 && list.text) {
          const m = list.text.match(/\/-\/releases\/(?:[^\/]+)\/(.+)$/) || list.text.match(/\/-\/releases\/(.+)$/);
          if (m && m[1]) {
            const tag = decodeURIComponent(m[1]);
            return { version: tag, downloadUrl: `https://gitlab.com/${repoInfo.owner}/${repoInfo.repo}/-/archive/${tag}/${repoInfo.repo}-${tag}.zip`, source: 'release-web' };
          }
        }
      } catch (err) { /** ignore */ }

      try {
        const tags = await fetchText(`https://gitlab.com/${repoInfo.owner}/${repoInfo.repo}/-/tags`);
        if (tags.status === 200 && tags.text) {
          const m = tags.text.match(/\/-\/tags\/(.+)/) || tags.text.match(/\/-\/tree\/(.+)/);
          if (m && m[1]) {
            const tag = decodeURIComponent(m[1]);
            return { version: tag, downloadUrl: `https://gitlab.com/${repoInfo.owner}/${repoInfo.repo}/-/archive/${tag}/${repoInfo.repo}-${tag}.zip`, source: 'tag-web' };
          }
        }
      } catch (err) { /** ignore */ }
    }

    return null;
  } catch (error) {
    console.error('fetch-release-web error:', error);
    throw error;
  }
});

// Fetch GitHub repository info via API in main process to avoid CSP restrictions
ipcMain.handle('fetch-github-repo', async (event, owner, repo) => {
  try {
    if (!owner || !repo || typeof owner !== 'string' || typeof repo !== 'string') {
      throw new Error('Invalid owner or repo');
    }

    const https = require('https');
    const url = `https://api.github.com/repos/${owner}/${repo}`;

    return await new Promise((resolve, reject) => {
      const req = https.get(url, {
        headers: {
          'User-Agent': 'Wow-Addon-Manager/1.0',
          'Accept': 'application/vnd.github.v3+json'
        }
      }, (res) => {
        let data = '';
        res.on('data', (chunk) => data += chunk.toString());
        res.on('end', () => {
          if (res.statusCode === 200) {
            try {
              const repoData = JSON.parse(data);
              resolve({
                default_branch: repoData.default_branch,
                full_name: repoData.full_name
              });
            } catch (err) {
              reject(new Error('Invalid JSON response from GitHub API'));
            }
          } else {
            reject(new Error(`GitHub API returned status ${res.statusCode}`));
          }
        });
      });
      req.on('error', (err) => reject(err));
      req.setTimeout(10000, () => {
        req.destroy();
        reject(new Error('GitHub API request timeout'));
      });
    });
  } catch (error) {
    console.error('fetch-github-repo error:', error);
    throw error;
  }
});

// Fetch curated JSON blob in main process to avoid renderer CORS restrictions
ipcMain.handle('fetch-curated-list', async (event, url) => {
  try {
    if (!url || typeof url !== 'string') throw new Error('Invalid URL');
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new Error('Only http(s) URLs allowed');

    const https = require('https');
    const http = require('http');

    const client = parsed.protocol === 'https:' ? https : http;

    return await new Promise((resolve, reject) => {
      const req = client.get(parsed, { headers: { 'User-Agent': 'Wow-Addon-Manager/1.0', 'Accept': 'application/json' } }, (res) => {
        let data = '';
        res.on('data', (chunk) => data += chunk.toString());
        res.on('end', () => {
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            try {
              const json = JSON.parse(data);
              resolve({ ok: true, json });
            } catch (err) {
              reject(new Error('Invalid JSON from curated list'));
            }
          } else {
            reject(new Error(`Failed to fetch curated list: ${res.statusCode || 'unknown'}`));
          }
        });
      });
      req.on('error', (err) => reject(err));
      req.setTimeout(20000, () => { req.destroy(); reject(new Error('Curated list fetch timeout')); });
    });
  } catch (error) {
    console.error('fetch-curated-list error:', error);
    throw error;
  }
});

// Fetch webpage content in main process to avoid CSP restrictions
ipcMain.handle('fetch-webpage', async (event, url) => {
  try {
    if (!url || typeof url !== 'string') throw new Error('Invalid URL');
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new Error('Only http(s) URLs allowed');

    const https = require('https');
    const http = require('http');

    const client = parsed.protocol === 'https:' ? https : http;

    return await new Promise((resolve, reject) => {
      const req = client.get(parsed, { 
        headers: { 
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.5',
          'Cache-Control': 'no-cache'
        } 
      }, (res) => {
        let data = '';
        res.setEncoding('utf8');
        
        res.on('data', (chunk) => data += chunk);
        res.on('end', () => {
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            resolve(data);
          } else if (res.statusCode === 301 || res.statusCode === 302) {
            // Handle redirects
            const location = res.headers.location;
            if (location) {
              console.log(`Following redirect from ${url} to ${location}`);
              // Recursive call to handle redirect
              resolve(ipcMain.emit('fetch-webpage', event, location));
            } else {
              reject(new Error(`Redirect without location header: ${res.statusCode}`));
            }
          } else {
            reject(new Error(`Failed to fetch webpage: ${res.statusCode || 'unknown'}`));
          }
        });
      });
      
      req.on('error', (err) => reject(err));
      req.setTimeout(30000, () => { 
        req.destroy(); 
        reject(new Error('Webpage fetch timeout')); 
      });
    });
  } catch (error) {
    console.error('fetch-webpage error:', error);
    throw error;
  }
});
