const { contextBridge, ipcRenderer } = require('electron');

// ✅ Security: Expose only specific, safe APIs to the renderer process
contextBridge.exposeInMainWorld('electronAPI', {
  // File system operations
  selectDirectory: () => ipcRenderer.invoke('select-directory'),
  readFile: (filePath) => ipcRenderer.invoke('read-file', filePath),
  writeFile: (filePath, content, encoding) => ipcRenderer.invoke('write-file', filePath, content, encoding),
  checkDirectory: (dirPath) => ipcRenderer.invoke('check-directory', dirPath),
  createDirectory: (dirPath) => ipcRenderer.invoke('create-directory', dirPath),
  readDirectory: (dirPath) => ipcRenderer.invoke('read-directory', dirPath),
  extractZip: (zipPath, extractPath) => ipcRenderer.invoke('extract-zip', zipPath, extractPath),
  deleteFile: (filePath) => ipcRenderer.invoke('delete-file', filePath),
  getFileStats: (filePath) => ipcRenderer.invoke('get-file-stats', filePath),
  copyFolderRecursive: (sourcePath, destPath) => ipcRenderer.invoke('copy-folder-recursive', sourcePath, destPath),
  removeDirectory: (dirPath) => ipcRenderer.invoke('remove-directory', dirPath),
  downloadFile: (url, destinationPath) => ipcRenderer.invoke('download-file', url, destinationPath),
  
  // User data storage (persistent across app updates)
  saveUserData: (key, data) => ipcRenderer.invoke('save-user-data', key, data),
  loadUserData: (key) => ipcRenderer.invoke('load-user-data', key),
  
  // Version information (safe to expose)
  versions: {
    node: () => process.versions.node,
    chrome: () => process.versions.chrome,
    electron: () => process.versions.electron
  },
  
  // Platform information
  platform: process.platform,
  
  // Open external links safely
  openExternal: (url) => {
    // ✅ Security: Validate URL before passing to main process
    try {
      const urlObj = new URL(url);
      if (urlObj.protocol === 'https:' || urlObj.protocol === 'http:') {
        ipcRenderer.invoke('open-external', url);
      } else {
        console.warn('Only HTTP and HTTPS URLs are allowed');
      }
    } catch (error) {
      console.warn('Invalid URL:', url);
    }
  }
});

// ✅ Security: Remove any window.require access
delete window.require;
delete window.exports;
delete window.module;
