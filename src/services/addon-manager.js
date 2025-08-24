/**
 * Addon management service for installing and updating WoW addons
 */

import { downloadFile, getLatestRelease, parseRepoFromUrl } from './api-client';

// Generate unique IDs for addons
const generateId = () => {
  return Date.now().toString(36) + Math.random().toString(36).substr(2);
};

// ✅ Security: Use secure Electron API access through preload script
const electronAPI = window.electronAPI;

// Helper functions to work with electronAPI safely
const fileSystem = {
  readFile: electronAPI?.readFile || (() => { throw new Error('Electron API not available'); }),
  writeFile: electronAPI?.writeFile || (() => { throw new Error('Electron API not available'); }),
  readdir: electronAPI?.readDirectory || (() => { throw new Error('Electron API not available'); }),
  mkdir: electronAPI?.createDirectory || (() => { throw new Error('Electron API not available'); }),
  stat: electronAPI?.getFileStats || (() => { throw new Error('Electron API not available'); }),
  unlink: electronAPI?.deleteFile || (() => { throw new Error('Electron API not available'); }),
  checkDirectory: electronAPI?.checkDirectory || (() => { throw new Error('Electron API not available'); }),
  extractZip: electronAPI?.extractZip || (() => { throw new Error('Electron API not available'); }),
  copyFolderRecursive: electronAPI?.copyFolderRecursive || (() => { throw new Error('Electron API not available'); }),
  removeDirectory: electronAPI?.removeDirectory || (() => { throw new Error('Electron API not available'); }),
  downloadFile: electronAPI?.downloadFile || (() => { throw new Error('Electron API not available'); })
};

const pathUtils = {
  join: (...args) => {
    // Windows-compatible path joining
    return args.join('\\').replace(/\/+/g, '\\').replace(/\\+/g, '\\');
  },
  dirname: (p) => p.substring(0, Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'))),
  basename: (p, ext) => {
    const base = p.substring(Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\')) + 1);
    return ext && base.endsWith(ext) ? base.slice(0, -ext.length) : base;
  },
  extname: (p) => {
    const base = pathUtils.basename(p);
    const lastDot = base.lastIndexOf('.');
    return lastDot > 0 ? base.substring(lastDot) : '';
  }
};

const SETTINGS_KEY = 'wow-addon-manager-settings';

/**
 * Extract ZIP file and find addon folders containing .toc files
 * @param {string} zipPath - Path to ZIP file
 * @param {string} extractPath - Directory to extract to
 * @returns {Promise<string[]>} List of paths to addon folders (relative to extractPath)
 */
async function extractZipAndGetAddonFolders(zipPath, extractPath) {
  try {
    // Extract the ZIP file
    await fileSystem.extractZip(zipPath, extractPath);
    
    // Recursively find folders containing .toc files
    return await findAddonFoldersRecursive(extractPath, extractPath);
  } catch (error) {
    console.error('Failed to extract ZIP and find addon folders:', error);
    throw error;
  }
}

/**
 * Recursively search for folders containing .toc files
 * @param {string} searchPath - Current directory to search
 * @param {string} basePath - Base extraction path for relative paths
 * @returns {Promise<string[]>} Array of relative paths to addon folders
 */
async function findAddonFoldersRecursive(searchPath, basePath) {
  const addonFolders = [];
  
  try {
    const items = await fileSystem.readdir(searchPath);
    
    // Check if current directory contains .toc files
    const hasTocFiles = items.some(item => 
      item.isFile && item.name.endsWith('.toc')
    );
    
    if (hasTocFiles) {
      // This is an addon folder, add relative path from base
      const relativePath = searchPath.replace(basePath, '').replace(/^[\\//]/, '');
      addonFolders.push(relativePath || '.');
    } else {
      // No .toc files here, search subdirectories
      for (const item of items) {
        if (item.isDirectory) {
          const subPath = pathUtils.join(searchPath, item.name);
          const subFolders = await findAddonFoldersRecursive(subPath, basePath);
          addonFolders.push(...subFolders);
        }
      }
    }
  } catch (error) {
    console.error(`Failed to search directory ${searchPath}:`, error);
    // Continue searching other directories
  }
  
  return addonFolders;
}

/**
 * Copy a folder recursively using Electron IPC
 * @param {string} sourcePath - Source folder path
 * @param {string} destPath - Destination folder path
 */
async function copyFolderRecursive(sourcePath, destPath) {
  try {
    await fileSystem.copyFolderRecursive(sourcePath, destPath);
  } catch (error) {
    console.error('Failed to copy folder:', error);
    throw error;
  }
}

/**
 * Get application settings from persistent storage
 * @returns {Promise<Object>} Settings object
 */
async function getSettings() {
  try {
    // Try to load from Electron userData first
    if (window.electronAPI) {
      const data = await window.electronAPI.loadUserData('settings');
      if (data) {
        return data;
      }
    }
    
    // Fallback to localStorage for migration
    const saved = localStorage.getItem(SETTINGS_KEY);
    if (saved) {
      const settings = JSON.parse(saved);
      // Migrate to persistent storage if available
      if (window.electronAPI) {
        await window.electronAPI.saveUserData('settings', settings);
        // Clear localStorage after successful migration
        localStorage.removeItem(SETTINGS_KEY);
      }
      return settings;
    }
  } catch (error) {
    console.error('Failed to load settings:', error);
  }
  
  const defaultSettings = {
    wowPath: '',
    tempPath: pathUtils.join(process.env.TEMP || 'C:\\temp', 'wow-addon-manager')
  };
  
  // Save default settings
  if (window.electronAPI) {
    try {
      await window.electronAPI.saveUserData('settings', defaultSettings);
    } catch (error) {
      console.error('Failed to save default settings:', error);
    }
  }
  
  return defaultSettings;
}

/**
 * Save application settings to persistent storage
 * @param {Object} settings - Settings to save
 */
async function saveSettings(settings) {
  try {
    if (window.electronAPI) {
      await window.electronAPI.saveUserData('settings', settings);
    } else {
      // Fallback to localStorage
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    }
  } catch (error) {
    console.error('Failed to save settings:', error);
  }
}

/**
 * Get the WoW addons directory path
 * @param {Object} settings - Settings object (optional)
 * @returns {Promise<string>} Path to WoW/Interface/AddOns
 */
async function getWoWAddonsPath(settings = null) {
  if (!electronAPI) {
    throw new Error('File system access not available. Please run in Electron environment.');
  }
  
  const appSettings = settings || await getSettings();
  if (!appSettings.wowPath) {
    throw new Error('WoW installation path not configured. Please set it in Settings.');
  }
  
  return pathUtils.join(appSettings.wowPath, 'Interface', 'AddOns');
}

/**
 * Ensure a directory exists, creating it if necessary
 * @param {string} dirPath - Directory path to create
 */
async function ensureDirectory(dirPath) {
  try {
    await fileSystem.mkdir(dirPath);
  } catch (error) {
    if (error.code !== 'EEXIST') {
      throw error;
    }
  }
}

/**
 * Parse addon .toc file to extract metadata
 * @param {string} tocPath - Path to .toc file
 * @returns {Object} Addon metadata
 */
async function parseAddonToc(tocPath) {
  try {
    const content = await fileSystem.readFile(tocPath);
    const lines = content.split('\n');
    
    const metadata = {};
    
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith('## ')) {
        const colonIndex = trimmed.indexOf(':');
        if (colonIndex > -1) {
          const key = trimmed.substring(3, colonIndex).trim();
          const value = trimmed.substring(colonIndex + 1).trim();
          metadata[key.toLowerCase()] = value;
        }
      }
    }
    
    return {
      title: metadata.title || pathUtils.basename(tocPath, '.toc'),
      version: metadata.version || 'Unknown',
      author: metadata.author || 'Unknown',
      interface: metadata.interface || 'Unknown',
      notes: metadata.notes || '',
      x_website: metadata['x-website'] || '',
      x_repository: metadata['x-repository'] || ''
    };
  } catch (error) {
    console.error('Failed to parse .toc file:', error);
    return {
      title: pathUtils.basename(tocPath, '.toc'),
      version: 'Unknown',
      author: 'Unknown',
      interface: 'Unknown'
    };
  }
}

/**
 * Parse .toc file content to extract metadata
 * @param {string} content - Content of .toc file
 * @returns {Object} Addon metadata
 */
function parseTocContent(content) {
  const lines = content.split('\n');
  const metadata = {};
  
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('## ')) {
      const colonIndex = trimmed.indexOf(':');
      if (colonIndex > -1) {
        const key = trimmed.substring(3, colonIndex).trim();
        const value = trimmed.substring(colonIndex + 1).trim();
        metadata[key.toLowerCase()] = value;
      }
    }
  }
  
  return {
    title: metadata.title || 'Unknown',
    version: metadata.version || 'Unknown',
    author: metadata.author || 'Unknown',
    interface: metadata.interface || 'Unknown',
    notes: metadata.notes || '',
    x_website: metadata['x-website'] || '',
    x_repository: metadata['x-repository'] || ''
  };
}

/**
 * Find .toc files in a directory
 * @param {string} addonDir - Directory to search
 * @returns {Array<string>} Array of .toc file paths
 */
async function findTocFiles(addonDir) {
  try {
    const items = await fileSystem.readdir(addonDir);
    return items
      .filter(item => item.isFile && item.name.endsWith('.toc'))
      .map(item => pathUtils.join(addonDir, item.name));
  } catch (error) {
    return [];
  }
}

/**
 * Generate unique addon ID
 * @param {string} repoUrl - Repository URL
 * @returns {string} Unique ID
 */
function generateAddonId(repoUrl) {
  const repoInfo = parseRepoFromUrl(repoUrl);
  return `${repoInfo.platform}-${repoInfo.owner}-${repoInfo.repo}`;
}

/**
 * Install an addon from a repository
 * @param {string} repoUrl - GitHub or GitLab repository URL
 * @param {Object} release - Release information from API
 * @returns {Promise<Object>} Installed addon object
 */
export async function installAddon(repoUrl, release, customOptions = {}) {
  if (!electronAPI) {
    throw new Error('File system modules not available. Please run in Electron environment.');
  }
  
  const settings = await getSettings();
  const wowAddonsPath = await getWoWAddonsPath(settings);
  const tempPath = settings.tempPath;
  
  await ensureDirectory(tempPath);
  await ensureDirectory(wowAddonsPath);
  
  const repoInfo = parseRepoFromUrl(repoUrl);
  const addonId = generateAddonId(repoUrl);
  const zipFileName = `${addonId}-${release.version}.zip`;
  const zipPath = pathUtils.join(tempPath, zipFileName);
  const extractPath = pathUtils.join(tempPath, `extract-${addonId}`);
  
  try {
    // Download the ZIP file
    await downloadFile(release.downloadUrl, zipPath);
    
    // Extract to temp directory and find addon folders
    await ensureDirectory(extractPath);
    const addonFolderPaths = await extractZipAndGetAddonFolders(zipPath, extractPath);
    
    if (addonFolderPaths.length === 0) {
      throw new Error('No addon folders with .toc files found in the ZIP file');
    }
    
    // Copy addon folders to WoW addons directory
    const installedFolders = [];
    for (const addonFolderPath of addonFolderPaths) {
      const sourcePath = pathUtils.join(extractPath, addonFolderPath);
      let addonFolderName = pathUtils.basename(addonFolderPath);
      
      // Apply custom folder name if specified
      if (customOptions.customFolderName && addonFolderPaths.length === 1) {
        addonFolderName = customOptions.customFolderName;
      }
      
      const destPath = pathUtils.join(wowAddonsPath, addonFolderName);
      
      // Remove existing folder if it exists
      try {
        await fileSystem.removeDirectory(destPath);
      } catch (error) {
        // Folder doesn't exist, that's fine
      }
      
      // Copy the folder content
      await copyFolderRecursive(sourcePath, destPath);
      installedFolders.push(addonFolderName);
    }
    
    // Find and parse the main .toc file
    let mainTocData = null;
    for (const folderName of installedFolders) {
      const folderPath = pathUtils.join(wowAddonsPath, folderName);
      const tocFiles = await findTocFiles(folderPath);
      
      if (tocFiles.length > 0) {
        mainTocData = await parseAddonToc(tocFiles[0]);
        break;
      }
    }
    
    // Clean up temp files
    try {
      await fileSystem.unlink(zipPath);
      await fileSystem.removeDirectory(extractPath);
    } catch (error) {
      console.error('Failed to clean up temp files:', error);
    }
    
    return {
      id: addonId,
      name: mainTocData?.title || repoInfo.repo,
      repoUrl,
      currentVersion: release.version,
      latestVersion: release.version,
      needsUpdate: false,
      installPath: pathUtils.join(wowAddonsPath, installedFolders[0]),
      installedFolders,
      lastUpdated: new Date().toISOString(),
      tocData: mainTocData,
      source: release.source,
      branch: release.branch,
      commit: release.commit,
      customFolderName: customOptions.customFolderName,
      isDirectDownload: customOptions.isDirectDownload,
      preferredAssetName: customOptions.preferredAssetName
    };
    
  } catch (error) {
    // Clean up on error
    try {
      await fileSystem.unlink(zipPath);
      await fileSystem.removeDirectory(extractPath);
    } catch (cleanupError) {
      console.error('Failed to clean up after error:', cleanupError);
    }
    
    throw error;
  }
}

/**
 * Update an existing addon
 * @param {Object} addon - Addon object to update
 * @returns {Promise<Object>} Updated addon object
 */
export async function updateAddon(addon) {
  const release = await getLatestRelease(addon.repoUrl, addon.preferredAssetName);
  
  if (release.version === addon.currentVersion) {
    return {
      ...addon,
      needsUpdate: false
    };
  }
  
  // Preserve custom options from the original addon
  const customOptions = {
    customFolderName: addon.customFolderName,
    isDirectDownload: addon.isDirectDownload,
    preferredAssetName: addon.preferredAssetName
  };
  
  // Install the new version (this will overwrite the old one)
  const updatedAddon = await installAddon(addon.repoUrl, release, customOptions);
  
  // Preserve the original addon ID and some metadata
  return {
    ...updatedAddon,
    id: addon.id,
    installPath: addon.installPath,
    customFolderName: addon.customFolderName,
    isDirectDownload: addon.isDirectDownload
  };
}

/**
 * Check for updates for all addons
 * @param {Array<Object>} addons - Array of addon objects
 * @returns {Promise<Array<Object>>} Updated addon array with update flags
 */
export async function checkForUpdates(addons) {
  const updatedAddons = [];
  
  for (const addon of addons) {
    try {
      const release = await getLatestRelease(addon.repoUrl, addon.preferredAssetName);
      const needsUpdate = release.version !== addon.currentVersion;
      
      updatedAddons.push({
        ...addon,
        latestVersion: release.version,
        latestSource: release.source,
        needsUpdate
      });
    } catch (error) {
      console.error(`Failed to check updates for ${addon.name}:`, error);
      updatedAddons.push(addon);
    }
  }
  
  return updatedAddons;
}

/**
 * Compare two version strings (basic semver comparison)
 * @param {string} version1 - First version
 * @param {string} version2 - Second version
 * @returns {number} -1 if version1 < version2, 0 if equal, 1 if version1 > version2
 */
export function compareVersions(version1, version2) {
  // Remove 'v' prefix if present
  const v1 = version1.replace(/^v/, '');
  const v2 = version2.replace(/^v/, '');
  
  const parts1 = v1.split('.').map(Number);
  const parts2 = v2.split('.').map(Number);
  
  const maxLength = Math.max(parts1.length, parts2.length);
  
  for (let i = 0; i < maxLength; i++) {
    const part1 = parts1[i] || 0;
    const part2 = parts2[i] || 0;
    
    if (part1 < part2) return -1;
    if (part1 > part2) return 1;
  }
  
  return 0;
}

/**
 * Remove an addon completely - delete files and folders
 * @param {Object} addon - Addon object with installation information
 * @param {Object} settings - Settings object containing wowPath
 * @returns {Promise<void>}
 */
export async function removeAddon(addon, settings = null) {
  const appSettings = settings || await getSettings();
  
  if (!appSettings.wowPath) {
    throw new Error('WoW directory not configured');
  }

  const addonsPath = pathUtils.join(appSettings.wowPath, 'Interface', 'AddOns');
  
  // Delete all installed folders for this addon
  if (addon.installedFolders && addon.installedFolders.length > 0) {
    for (const folderName of addon.installedFolders) {
      const folderPath = pathUtils.join(addonsPath, folderName);
      
      try {
        // Check if directory exists before trying to delete
        const exists = await fileSystem.checkDirectory(folderPath);
        if (exists) {
          await fileSystem.removeDirectory(folderPath);
          console.log(`Deleted addon folder: ${folderPath}`);
        }
      } catch (error) {
        console.error(`Failed to delete addon folder ${folderPath}:`, error);
        // Continue with other folders even if one fails
      }
    }
  }
}

/**
 * Scan existing addon folders and extract metadata
 * @param {Object} settings - Settings object containing wowDirectory
 * @returns {Promise<Array>} Array of existing addon information
 */
export async function scanExistingAddons(settings = null) {
  // If no settings provided, try to get from persistent storage
  const appSettings = settings || await getSettings();
  
  if (!appSettings.wowPath) {
    throw new Error('WoW directory not configured');
  }

  const addonsPath = pathUtils.join(appSettings.wowPath, 'Interface', 'AddOns');
  
  try {
    // Check if AddOns directory exists
    const exists = await fileSystem.checkDirectory(addonsPath);
    if (!exists) {
      return [];
    }

    // Get all directories in AddOns folder
    const items = await fileSystem.readdir(addonsPath);
    const existingAddons = [];

    for (const item of items) {
      // Skip if it's not a directory
      if (!item.isDirectory) continue;
      
      const folderName = item.name;
      const folderPath = pathUtils.join(addonsPath, folderName);
      
      try {
        // Skip Blizzard addons and common system folders
        if (folderName.startsWith('Blizzard_') || 
            folderName === '.DS_Store' || 
            folderName === 'Thumbs.db') {
          continue;
        }

        // Look for .toc files
        const folderContents = await fileSystem.readdir(folderPath);
        const tocFiles = folderContents.filter(file => file.name.endsWith('.toc'));
        
        if (tocFiles.length > 0) {
          // Parse the main .toc file (usually matches folder name)
          const mainTocFile = tocFiles.find(file => 
            pathUtils.basename(file.name, '.toc').toLowerCase() === folderName.toLowerCase()
          ) || tocFiles[0];

          const tocPath = pathUtils.join(folderPath, mainTocFile.name);
          const tocContent = await fileSystem.readFile(tocPath);
          const tocData = parseTocContent(tocContent);

          // Get folder stats for last modified time
          const stats = await fileSystem.stat(folderPath);

          // Create existing addon object
          const existingAddon = {
            folderName,
            folderPath,
            tocData,
            title: tocData.title || folderName,
            version: tocData.version || 'Unknown',
            author: tocData.author || 'Unknown',
            notes: tocData.notes || '',
            interface: tocData.interface || 'Unknown',
            lastModified: stats ? stats.mtime : new Date(),
            suggestedRepos: await suggestRepositories(tocData, folderName)
          };

          existingAddons.push(existingAddon);
        }
      } catch (error) {
        console.error(`Error scanning addon folder ${folderName}:`, error);
        // Continue with other folders
      }
    }

    return existingAddons;
  } catch (error) {
    console.error('Error scanning AddOns directory:', error);
    throw new Error('Failed to scan existing addons');
  }
}

/**
 * Suggest possible GitHub/GitLab repositories for an addon
 * @param {Object} tocData - Parsed .toc file data
 * @param {string} folderName - Addon folder name
 * @returns {Promise<Array>} Array of suggested repository URLs
 */
async function suggestRepositories(tocData, folderName) {
  const suggestions = [];

  // Look for URLs in notes or other fields
  const urlPattern = /https?:\/\/(github\.com|gitlab\.com)\/[^\s)]+/gi;
  const allText = [
    tocData.notes,
    tocData.title,
    tocData.author,
    tocData.x_website,
    tocData.x_repository
  ].filter(Boolean).join(' ');

  const foundUrls = allText.match(urlPattern) || [];
  
  // Clean up and validate URLs
  for (const url of foundUrls) {
    try {
      const cleanUrl = url.replace(/[.,;)]*$/, ''); // Remove trailing punctuation
      const urlObj = new URL(cleanUrl);
      
      if ((urlObj.hostname === 'github.com' || urlObj.hostname === 'gitlab.com') &&
          urlObj.pathname.split('/').filter(p => p).length >= 2) {
        suggestions.push(cleanUrl);
      }
    } catch (error) {
      // Invalid URL, skip
    }
  }

  return [...new Set(suggestions)]; // Remove duplicates
}

/**
 * Add an existing addon to management with manual repository approval
 * @param {Object} existingAddon - Existing addon information
 * @param {string} approvedRepoUrl - User-approved repository URL
 * @returns {Promise<Object>} Managed addon object
 */
export async function addExistingAddon(existingAddon, approvedRepoUrl) {
  try {
    // Validate repository URL
    if (!approvedRepoUrl) {
      throw new Error('Repository URL is required');
    }

    // Get release info from API
    const release = await getLatestRelease(approvedRepoUrl);
    
    // Create managed addon object
    const managedAddon = {
      id: generateId(),
      name: existingAddon.title,
      repoUrl: approvedRepoUrl,
      currentVersion: existingAddon.version,
      latestVersion: release.version,
      needsUpdate: compareVersions(existingAddon.version, release.version) < 0,
      lastUpdated: new Date().toISOString(),
      installedFolders: [existingAddon.folderName],
      tocData: existingAddon.tocData,
      source: release.source || 'release',
      branch: release.branch,
      commit: release.commit,
      latestSource: release.source,
      latestBranch: release.branch,
      latestCommit: release.commit
    };

    return managedAddon;
  } catch (error) {
    console.error('Failed to add existing addon:', error);
    throw new Error(`Failed to add existing addon: ${error.message}`);
  }
}

// Export settings functions
export { getSettings, saveSettings };
