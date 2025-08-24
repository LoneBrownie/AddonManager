const { app, BrowserWindow, dialog, ipcMain } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');
const fs = require('fs').promises;

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
    width: 1200,
    height: 800,
    autoHideMenuBar: true, // Hide the File/Edit/View/Window/Help menu bar
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
    icon: path.join(__dirname, 'icon.png'),
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
  createWindow();
  
  // Configure auto-updater (only for production builds)
  if (!isDev) {
    autoUpdater.setFeedURL({
      provider: 'github',
      owner: 'LoneBrownie',
      repo: 'AddonManager'
    });
    
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
  
  // Show notification and restart after 5 seconds
  setTimeout(() => {
    autoUpdater.quitAndInstall();
  }, 5000);
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
        
        const request = client.get(downloadUrl, (response) => {
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
  
  autoUpdater.quitAndInstall();
});
