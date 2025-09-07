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
    // Filter out common archive metadata folders (macOS) and system files
    const filteredItems = items.filter(i => {
      const lower = i.name.toLowerCase();
      if (lower === '__macosx' || lower === '_macosx' || lower === '.ds_store') return false;
      return true;
    });
    
    // Check if current directory contains .toc files
    const hasTocFiles = filteredItems.some(item => 
      item.isFile && item.name.endsWith('.toc')
    );
    
    if (hasTocFiles) {
      // This is an addon folder, add relative path from base
      const relativePath = searchPath.replace(basePath, '').replace(/^[\\//]/, '');
      const folderName = relativePath || '.';
      
      // Skip optional folders for specific addons
      const skipFolders = ['AnyIDTooltip']; // Optional AtlasLoot component
      const shouldSkip = skipFolders.some(skipFolder => 
        folderName.includes(skipFolder) || folderName.endsWith(skipFolder)
      );
      
      if (!shouldSkip) {
        addonFolders.push(folderName);
      }
    } else {
      // No .toc files here, search subdirectories
      for (const item of filteredItems) {
        if (item.isDirectory) {
          const lower = item.name.toLowerCase();
          if (lower === '__macosx' || lower === '_macosx' || lower === '.ds_store') continue;
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
    tempPath: pathUtils.join(process.env.TEMP || 'C:\\temp', 'wow-addon-manager'),
    downloadPriority: 'releases' // 'releases' or 'code'
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
      title: sanitizeTocTitle(metadata.title || pathUtils.basename(tocPath, '.toc')),
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
      title: sanitizeTocTitle(pathUtils.basename(tocPath, '.toc')),
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
    title: sanitizeTocTitle(metadata.title || 'Unknown'),
    version: metadata.version || 'Unknown',
    author: metadata.author || 'Unknown',
    interface: metadata.interface || 'Unknown',
    notes: metadata.notes || '',
    x_website: metadata['x-website'] || '',
    x_repository: metadata['x-repository'] || ''
  };
}

/**
 * Sanitize .toc title values to remove WoW color codes and other control/formatting sequences.
 * Examples removed: "|cff33ffcc", "|r", texture tags |T...|t, and hyperlink wrappers |H...|h
 * Also strips non-printable control characters and collapses excessive punctuation/whitespace.
 * @param {string} title
 * @returns {string}
 */
export function sanitizeTocTitle(title) {
  if (!title || typeof title !== 'string') return '';

  let t = title;

  // Remove WoW color codes like |cff33ffcc or |cffffffff
  t = t.replace(/\|c[0-9a-fA-F]{6,8}/g, '');
  // Remove color reset markers
  t = t.replace(/\|r/gi, '');

  // Remove texture tags |T...|t
  t = t.replace(/\|T.*?\|t/g, '');

  // Unwrap hyperlink text |H...|htext|h -> keep 'text'
  t = t.replace(/\|H.*?\|h(.*?)\|h/g, '$1');

  // Remove other simple |x sequences (e.g., |cff..., |1 etc.) but keep the following text
  t = t.replace(/\|[a-zA-Z0-9]{1,12}/g, '');

  // Strip control characters (avoid control-character escapes in regex for ESLint)
  t = t.split('').filter(ch => {
    const code = ch.charCodeAt(0);
    // Keep printable ASCII range (space..~) and everything above DEL (127). Remove C0 control chars and DEL.
    return code >= 32 && code !== 127;
  }).join('');

  // Replace multiple quotes or punctuation with a single instance
  t = t.replace(/['"`]{2,}/g, '');
  t = t.replace(/[-_]{2,}/g, '-');

  // Collapse multiple whitespace to single space
  t = t.replace(/\s{2,}/g, ' ');

  // Trim and return
  return t.trim();
}

/**
 * Find .toc files in a directory
 * @param {string} addonDir - Directory to search
 * @returns {Array<string>} Array of .toc file paths
 */
/**
 * Determine the best folder name for an addon based on .toc files and existing folder name
 * @param {string} sourcePath - Path to the extracted addon folder
 * @param {string} originalFolderName - Original folder name from ZIP
 * @param {string} repoName - Repository name for additional matching (optional)
 * @returns {Promise<string>} The best folder name to use
 */
async function determineBestFolderName(sourcePath, originalFolderName, repoName = null) {
  try {
    const tocFiles = await findTocFiles(sourcePath);
    
    if (tocFiles.length === 0) {
      return originalFolderName;
    }
    
    // If there's only one .toc file, use its basename (without .toc extension)
    if (tocFiles.length === 1) {
      const tocFileName = pathUtils.basename(tocFiles[0], '.toc');
      return tocFileName;
    }
    
    // If there are multiple .toc files, try to find the main one
    // Priority: exact match with folder name > repo name match > main addon .toc > first .toc
    const normalizedFolderName = originalFolderName.toLowerCase();
    const normalizedRepoName = repoName ? repoName.toLowerCase() : null;
    
    // Look for exact match with folder name
    const exactMatch = tocFiles.find(tocPath => {
      const tocName = pathUtils.basename(tocPath, '.toc').toLowerCase();
      return tocName === normalizedFolderName;
    });
    
    if (exactMatch) {
      return pathUtils.basename(exactMatch, '.toc');
    }
    
    // Look for match with repository name
    if (normalizedRepoName) {
      const repoMatch = tocFiles.find(tocPath => {
        const tocName = pathUtils.basename(tocPath, '.toc').toLowerCase();
        return tocName === normalizedRepoName || tocName.includes(normalizedRepoName);
      });
      
      if (repoMatch) {
        return pathUtils.basename(repoMatch, '.toc');
      }
    }
    
    // Look for .toc files that might be the main addon (not localization or options)
    const excludePatterns = ['_options', '_locale', '_localization', 'locale', 'localization'];
    const mainTocFile = tocFiles.find(tocPath => {
      const tocName = pathUtils.basename(tocPath, '.toc').toLowerCase();
      return !excludePatterns.some(pattern => tocName.includes(pattern));
    });
    
    if (mainTocFile) {
      return pathUtils.basename(mainTocFile, '.toc');
    }
    
    // Fallback to first .toc file
    return pathUtils.basename(tocFiles[0], '.toc');
    
  } catch (error) {
    console.error('Error determining best folder name:', error);
    return originalFolderName;
  }
}

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
 * Get display name from repository URL
 * @param {string} url - Repository URL
 * @returns {string} Display name (e.g., "owner/repo")
 */
function getRepoDisplayName(url) {
  try {
    // Special case for AtlasLoot Epoch
    if (url.toLowerCase().includes('atlaslootprojectepoch') || 
        url.toLowerCase().includes('raynbock/atlasloot')) {
      return 'AtlasLoot Epoch';
    }
    
    // Special case for Questie Epoch
    if (url.toLowerCase().includes('questie-epoch') || 
        url.toLowerCase().includes('esurm/questie')) {
      return 'Questie Epoch';
    }
    
    const urlObj = new URL(url);
    const pathParts = urlObj.pathname.split('/').filter(part => part);
    if (pathParts.length >= 2) {
      return pathParts[1]; // Just the repo name without owner for cleaner display
    }
  } catch {
    // fallback
  }
  return url;
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
    let addonFolderPaths = await extractZipAndGetAddonFolders(zipPath, extractPath);
    // Remove common archive metadata directories (macOS) from the results
    addonFolderPaths = addonFolderPaths.filter(p => {
      const lower = p.replace(/\\/g, '/').toLowerCase();
      // also filter out single-file markers like .ds_store
      if (lower === '__macosx' || lower === '_macosx' || lower === '.ds_store' || lower.endsWith('/.ds_store')) return false;
      // filter paths that begin with __macosx
      if (lower.startsWith('__macosx/') || lower.startsWith('_macosx/')) return false;
      return true;
    });

    if (addonFolderPaths.length === 0) {
      throw new Error('No addon folders with .toc files found in the ZIP file');
    }
    
    // Copy addon folders to WoW addons directory
    const installedFolders = [];
    for (const addonFolderPath of addonFolderPaths) {
      // Defensive skip for any extracted path that is just metadata
      const pLower = addonFolderPath.replace(/\\/g, '/').toLowerCase();
      if (pLower === '__macosx' || pLower === '_macosx' || pLower === '.ds_store') {
        continue;
      }
      const sourcePath = pathUtils.join(extractPath, addonFolderPath);
      let originalFolderName = pathUtils.basename(addonFolderPath);
      
      // Normalize folder names coming from GitHub/GitLab archive zips which
      // often append `-main` or `-master` (or case variants). Remove those
      // suffixes so installed addon folders match expected addon folder names.
      function normalizeExtractedFolderName(name) {
        if (!name) return name;
        // Remove repeated trailing -main or -master (case-insensitive)
        let newName = name;
        const pattern = /(-|_)?(?:main|master)$/i;
        // Keep stripping while matches (handles names like "Foo-main-main")
        while (pattern.test(newName)) {
          newName = newName.replace(pattern, '');
        }
        // Trim any trailing separators left behind
        newName = newName.replace(/[-_\s]+$/g, '');
        return newName || name; // fallback to original if empty
      }
      
      // Apply normalization to get a clean folder name
      const normalizedFolderName = normalizeExtractedFolderName(originalFolderName);
      
      let addonFolderName;
      
      // Determine the best folder name based on .toc files and other factors
      if (customOptions.customFolderName && addonFolderPaths.length === 1) {
        // Custom folder name takes highest priority for single-folder addons
        addonFolderName = customOptions.customFolderName;
      } else {
        // For new addon installations, prefer .toc filename over folder name
        addonFolderName = await determineBestFolderName(sourcePath, normalizedFolderName, repoInfo?.repo);
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
    
    // Heuristic: prefer a folder whose .toc metadata references the downloaded repo
    // or whose title closely matches the repo name. Fall back to name-based matching
    // and finally to the first folder with a .toc file.
    function normalizeNameForCompare(n) {
      return (n || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
    }

    let mainTocData = null;

    try {
      const repoCandidates = new Set();
      if (repoInfo && repoInfo.repo) {
        const repoRaw = repoInfo.repo;
        repoCandidates.add(normalizeNameForCompare(repoRaw));
        // Add the token before common separators (e.g., WeakAuras-WotLK -> WeakAuras)
        const token = String(repoRaw).split(/[-_\s.]+/)[0];
        repoCandidates.add(normalizeNameForCompare(token));
      }
      // Also consider owner/repo (ownerRepo) as a string to match x_repository fields
      const ownerRepo = repoInfo && repoInfo.owner && repoInfo.repo ? `${repoInfo.owner}/${repoInfo.repo}`.toLowerCase() : null;

      // First pass: scan each folder's .toc files and prefer matches based on metadata
      for (let i = 0; i < installedFolders.length; i++) {
        const folderName = installedFolders[i];
        const folderPath = pathUtils.join(wowAddonsPath, folderName);
        const tocFiles = await findTocFiles(folderPath);

        if (tocFiles.length === 0) continue;

        for (const tocPath of tocFiles) {
          try {
            const tocMeta = await parseAddonToc(tocPath);

            // Normalize and check x_repository or x_website fields for owner/repo
            const xRepo = (tocMeta.x_repository || '').toLowerCase();
            const xWebsite = (tocMeta.x_website || '').toLowerCase();

            const titleNorm = normalizeNameForCompare(tocMeta.title || '');

            // Priority 1: x_repository contains owner/repo or repo name
            if (ownerRepo && (xRepo.includes(ownerRepo) || xWebsite.includes(ownerRepo) || xRepo.includes(repoInfo.repo.toLowerCase()))) {
              // move this folder to front
              if (i > 0) {
                const [matchFolder] = installedFolders.splice(i, 1);
                installedFolders.unshift(matchFolder);
              }
              mainTocData = tocMeta;
              break;
            }

            // Priority 2: title matches repo candidates
            for (const cand of repoCandidates) {
              if (cand && titleNorm === cand) {
                if (i > 0) {
                  const [matchFolder] = installedFolders.splice(i, 1);
                  installedFolders.unshift(matchFolder);
                }
                mainTocData = tocMeta;
                break;
              }
            }

            if (mainTocData) break;
          } catch (e) {
            // ignore parse errors for individual toc files
          }
        }

        if (mainTocData) break;
      }

      // If no match found via metadata/title, fall back to name-based matching
      if (!mainTocData && repoInfo && repoInfo.repo && installedFolders.length > 1) {
        const repoBaseName = normalizeNameForCompare(repoInfo.repo);
        const matchIndex = installedFolders.findIndex(f => normalizeNameForCompare(f) === repoBaseName);
        if (matchIndex > 0) {
          const [matchFolder] = installedFolders.splice(matchIndex, 1);
          installedFolders.unshift(matchFolder);
        }
      }

      // Final fallback: pick the first folder that has a .toc file and parse it if we haven't already
      if (!mainTocData) {
        for (const folderName of installedFolders) {
          const folderPath = pathUtils.join(wowAddonsPath, folderName);
          const tocFiles = await findTocFiles(folderPath);
          if (tocFiles.length > 0) {
            try {
              mainTocData = await parseAddonToc(tocFiles[0]);
              break;
            } catch (e) {
              // ignore and continue
            }
          }
        }
      }
    } catch (e) {
      console.error('Error selecting main addon folder:', e);
      // On error, fallback to previous simple selection
      for (const folderName of installedFolders) {
        const folderPath = pathUtils.join(wowAddonsPath, folderName);
        const tocFiles = await findTocFiles(folderPath);
        if (tocFiles.length > 0) {
          try {
            mainTocData = await parseAddonToc(tocFiles[0]);
            break;
          } catch (err) {}
        }
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
      preferredAssetName: customOptions.preferredAssetName,
      // Default to allowing updates for newly installed addons (not imported)
      allowUpdates: customOptions.allowUpdates !== false // Default to true unless explicitly set to false
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
  // Check if updates are allowed for this addon
  if (addon.allowUpdates === false) {
    return {
      ...addon,
      needsUpdate: false,
      lastChecked: new Date().toISOString()
    };
  }
  
  const settings = await getSettings();
  const downloadPriority = settings.downloadPriority || 'releases';
  const release = await getLatestRelease(addon.repoUrl, addon.preferredAssetName, downloadPriority);
  
  if (release.version === addon.currentVersion) {
    return {
      ...addon,
      needsUpdate: false
    };
  }
  
  // For imported existing addons, check if update is available but allow full update
  if (addon.importedExisting) {
    const needsUpdate = isUpdateAvailable(addon.currentVersion || 'Imported', release.version);
    
    // If no update needed, just return metadata update
    if (!needsUpdate) {
      return {
        ...addon,
        latestVersion: release.version,
        needsUpdate: false,
        lastChecked: new Date().toISOString()
      };
    }
    
    // If update is available, proceed with full update process
    // This will download and install the new version
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
 * Force update an imported existing addon (downloads new version)
 * @param {Object} addon - Addon object
 * @returns {Promise<Object>} Updated addon object
 */
export async function forceUpdateImportedAddon(addon) {
  const settings = await getSettings();
  const downloadPriority = settings.downloadPriority || 'releases';
  const release = await getLatestRelease(addon.repoUrl, addon.preferredAssetName, downloadPriority);
  
  // Preserve custom options from the original addon
  const customOptions = {
    customFolderName: addon.customFolderName,
    isDirectDownload: addon.isDirectDownload,
    preferredAssetName: addon.preferredAssetName
  };
  
  // Install the new version (this will overwrite the old one)
  const updatedAddon = await installAddon(addon.repoUrl, release, customOptions);
  
  // Preserve the original addon ID and metadata, but remove imported flag
  return {
    ...updatedAddon,
    id: addon.id,
    installPath: addon.installPath,
    customFolderName: addon.customFolderName,
    isDirectDownload: addon.isDirectDownload,
    // Remove importedExisting flag since it's now a fresh install
    importedExisting: false
  };
}

/**
 * Check for updates for all addons
 * @param {Array<Object>} addons - Array of addon objects
 * @returns {Promise<Array<Object>>} Updated addon array with update flags
 */
export async function checkForUpdates(addons) {
  console.log(`Checking for updates for ${addons.length} addons...`);
  const settings = await getSettings();
  const downloadPriority = settings.downloadPriority || 'releases';
  const updatedAddons = [];
  
  for (const addon of addons) {
    try {
      console.log(`Checking updates for: ${addon.name} (${addon.repoUrl})`);
      const release = await getLatestRelease(addon.repoUrl, addon.preferredAssetName, downloadPriority);
      const needsUpdate = isUpdateAvailable(addon.currentVersion, release.version);
      
      console.log(`${addon.name}: Current=${addon.currentVersion}, Latest=${release.version}, NeedsUpdate=${needsUpdate}`);
      
      updatedAddons.push({
        ...addon,
        latestVersion: release.version,
        latestSource: release.source,
        needsUpdate,
        lastChecked: new Date().toISOString()
      });
    } catch (error) {
      console.error(`Failed to check updates for ${addon.name}:`, error);
      // Add the addon without update info but with error flag
      updatedAddons.push({
        ...addon,
        lastChecked: new Date().toISOString(),
        updateCheckError: error.message
      });
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
 * Determine if latestVersion is newer than currentVersion.
 * Uses semver-style numeric comparison when both versions look numeric (e.g. "v1.2.3" or "1.2.3").
 * Falls back to simple string equality for non-numeric versions (commit-sha, date-sha, etc.).
 * Special handling for branch names to avoid false updates between equivalent default branches.
 * Special handling for date-sha format from code fallback (e.g. "2025-09-03-abc1234").
 * @param {string} currentVersion
 * @param {string} latestVersion
 * @returns {boolean} true if an update is available
 */
function isUpdateAvailable(currentVersion, latestVersion) {
  if (!currentVersion && latestVersion) return true;
  if (!latestVersion) return false;

  console.log(`Comparing versions: "${currentVersion}" vs "${latestVersion}"`);

  // Check if versions are semantic versions
  const isSemanticVersion = v => typeof v === 'string' && /^v?\d+\.\d+(\.\d+)?/.test(v.trim());
  const isBranchName = v => {
    const commonBranches = ['main', 'master', 'develop', 'development', 'dev'];
    return commonBranches.includes(v) || 
           v.includes('branch') ||
           (!isSemanticVersion(v) && !isDateShaVersion(v) && v.length < 20);
  };
  const isDateShaVersion = v => {
    // Check for date-sha format like "2025-09-03-abc1234"
    return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}-[a-f0-9]{7}$/.test(v);
  };

  const currentIsSemver = isSemanticVersion(currentVersion);
  const latestIsSemver = isSemanticVersion(latestVersion);
  const currentIsBranch = isBranchName(currentVersion);
  const latestIsBranch = isBranchName(latestVersion);
  const currentIsDateSha = isDateShaVersion(currentVersion);
  const latestIsDateSha = isDateShaVersion(latestVersion);

  // Handle date-sha versions (from code fallback)
  if (currentIsDateSha || latestIsDateSha) {
    console.log(`  Handling date-sha versions`);
    
    // If both are date-sha versions, compare them
    if (currentIsDateSha && latestIsDateSha) {
      // Extract date and sha parts
      const currentParts = currentVersion.split('-');
      const latestParts = latestVersion.split('-');
      
      if (currentParts.length >= 4 && latestParts.length >= 4) {
        const currentDate = `${currentParts[0]}-${currentParts[1]}-${currentParts[2]}`;
        const latestDate = `${latestParts[0]}-${latestParts[1]}-${latestParts[2]}`;
        const currentSha = currentParts[3];
        const latestSha = latestParts[3];
        
        // First compare dates
        if (currentDate !== latestDate) {
          const hasUpdate = latestDate > currentDate;
          console.log(`  Date comparison: ${hasUpdate ? 'update available' : 'up to date'} (${currentDate} vs ${latestDate})`);
          return hasUpdate;
        }
        
        // If dates are the same, compare SHA (different commit on same day)
        const hasUpdate = currentSha !== latestSha;
        console.log(`  SHA comparison: ${hasUpdate ? 'different commit' : 'same commit'} (${currentSha} vs ${latestSha})`);
        return hasUpdate;
      }
    }
    
    // If current is date-sha and latest is semver, prefer semver
    if (currentIsDateSha && latestIsSemver) {
      console.log(`  ✓ Update available: Current is date-sha (${currentVersion}), latest is release (${latestVersion})`);
      return true;
    }
    
    // If current is semver and latest is date-sha, no update needed (prefer releases)
    if (currentIsSemver && latestIsDateSha) {
      console.log(`  ✓ No update: Current is release (${currentVersion}), latest is date-sha (${latestVersion})`);
      return false;
    }
    
    // If current is branch and latest is date-sha, update available
    if (currentIsBranch && latestIsDateSha) {
      console.log(`  ✓ Update available: Current is branch (${currentVersion}), latest is date-sha (${latestVersion})`);
      return true;
    }
    
    // If current is date-sha and latest is branch, keep date-sha (more specific)
    if (currentIsDateSha && latestIsBranch) {
      console.log(`  ✓ No update: Current is date-sha (${currentVersion}), latest is just branch (${latestVersion})`);
      return false;
    }
  }

  // If current version is a specific release and latest is a branch, no update needed
  if (currentIsSemver && latestIsBranch) {
    console.log(`  ✓ No update: Current is specific release (${currentVersion}), latest is branch (${latestVersion})`);
    return false;
  }

  // If both are branches, check if they're equivalent
  if (currentIsBranch && latestIsBranch) {
    const areEquivalent = (currentVersion === latestVersion) ||
                         ((currentVersion === 'main' && latestVersion === 'master') ||
                          (currentVersion === 'master' && latestVersion === 'main')) ||
                         (['develop', 'development', 'dev'].includes(currentVersion) && 
                          ['develop', 'development', 'dev'].includes(latestVersion));
    
    console.log(`  Branch comparison: ${currentVersion} vs ${latestVersion} = ${areEquivalent ? 'equivalent' : 'different'}`);
    return !areEquivalent;
  }

  // If both are semantic versions, use semver comparison
  if (currentIsSemver && latestIsSemver) {
    const hasUpdate = compareVersions(currentVersion, latestVersion) < 0;
    console.log(`  Semantic version comparison: ${hasUpdate ? 'update available' : 'up to date'}`);
    return hasUpdate;
  }

  // If current is branch and latest is semantic version, update available
  if (currentIsBranch && latestIsSemver) {
    console.log(`  ✓ Update available: Current is branch (${currentVersion}), latest is release (${latestVersion})`);
    return true;
  }

  // Default string comparison for other cases
  // Normalize simple v-prefix differences
  const normalize = s => (typeof s === 'string' ? s.replace(/^v/, '') : s);
  const hasUpdate = normalize(currentVersion) !== normalize(latestVersion);
  console.log(`  String comparison: ${hasUpdate ? 'different' : 'same'}`);
  return hasUpdate;
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
    const addonFolders = [];

    // First pass: collect all addon folders with their data
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

          addonFolders.push({
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
          });
        }
      } catch (error) {
        console.error(`Error scanning addon folder ${folderName}:`, error);
        // Continue with other folders
      }
    }

    // Second pass: group related addons
    const groupedAddons = groupRelatedAddons(addonFolders);
    
    return groupedAddons;
  } catch (error) {
    console.error('Error scanning AddOns directory:', error);
    throw new Error('Failed to scan existing addons');
  }
}

/**
 * Group related addon folders together (e.g., Scrap, Scrap_Merchant, Scrap_Options)
 * @param {Array} addonFolders - Array of individual addon folder data
 * @returns {Array} Array of grouped addon objects
 */
function groupRelatedAddons(addonFolders) {
  const grouped = [];
  const processed = new Set();

  // Sort by folder name length (shorter names first, likely to be main addons)
  const sortedAddons = [...addonFolders].sort((a, b) => a.folderName.length - b.folderName.length);

  for (const addon of sortedAddons) {
    if (processed.has(addon.folderName)) continue;

    // Find all potentially related addons
    const relatedAddons = findRelatedAddons(addon, addonFolders, processed);

    if (relatedAddons.length > 1) {
      // Multiple related folders - create a grouped addon
      const mainAddon = findMainAddon(relatedAddons);

      // Collect suggested repositories from all related addons
      const allSuggestedRepos = new Set();
      relatedAddons.forEach(addon => {
        if (addon.suggestedRepos && Array.isArray(addon.suggestedRepos)) {
          addon.suggestedRepos.forEach(repo => allSuggestedRepos.add(repo));
        }
      });

      const groupedAddon = {
        ...mainAddon,
        isGrouped: true,
        relatedFolders: relatedAddons.map(a => a.folderName),
        title: mainAddon.title,
        notes: `Multi-folder addon with ${relatedAddons.length} components: ${relatedAddons.map(a => a.folderName).join(', ')}`,
        suggestedRepos: Array.from(allSuggestedRepos)
      };

      grouped.push(groupedAddon);
      relatedAddons.forEach(a => processed.add(a.folderName));
    } else {
      // Single folder - add as-is
      grouped.push(addon);
      processed.add(addon.folderName);
    }
  }

  // Sort grouped addons alphabetically by title/name
  grouped.sort((a, b) => {
    const nameA = (a.title || a.folderName).toLowerCase();
    const nameB = (b.title || b.folderName).toLowerCase();
    return nameA.localeCompare(nameB);
  });
  
  return grouped;
}

/**
 * Find addons related to the given addon
 * @param {Object} addon - The addon to find relations for
 * @param {Array} allAddons - All available addons
 * @param {Set} processed - Already processed addon names
 * @returns {Array} Array of related addons including the original
 */
function findRelatedAddons(addon, allAddons, processed) {
  const related = [];
  const addonName = addon.folderName;

  for (const other of allAddons) {
    if (processed.has(other.folderName)) continue;
    
    if (areAddonsRelated(addonName, other.folderName)) {
      related.push(other);
    }
  }

  return related;
}

/**
 * Determine if two addon folder names are related
 * @param {string} name1 - First addon name
 * @param {string} name2 - Second addon name
 * @returns {boolean} True if the addons are related
 */
function areAddonsRelated(name1, name2) {
  const n1 = name1.toLowerCase();
  const n2 = name2.toLowerCase();

  // Exact match
  if (n1 === n2) return true;

  // Check for version/variant suffixes that indicate separate addons
  const versionSuffixes = [
    'classic', 'tbc', 'wotlk', 'cata', 'mop', 'wod', 'legion', 'bfa', 'sl', 'df',
    'epoch', 'vanilla', 'burning', 'crusade', 'lich', 'king', 'cataclysm',
    'pandaria', 'draenor', 'isles', 'azeroth', 'shadowlands', 'dragonflight',
    'v1', 'v2', 'v3', 'v4', 'v5', '335', '243', '434', '548'
  ];

  // If both names contain version indicators, they're likely separate addons
  const hasVersion1 = versionSuffixes.some(suffix => n1.includes(suffix));
  const hasVersion2 = versionSuffixes.some(suffix => n2.includes(suffix));
  
  if (hasVersion1 && hasVersion2) {
    // Both have version indicators - they're separate addon variants
    return false;
  }

  // Check if one is a prefix of the other with common separators
  const separators = ['_', '-', ' '];
  for (const sep of separators) {
    // name1 is prefix of name2 (e.g., "WeakAuras" and "WeakAuras_Options")
    if (n2.startsWith(n1 + sep)) {
      // Additional check: make sure the suffix isn't a version indicator
      const suffix = n2.substring((n1 + sep).length);
      if (versionSuffixes.includes(suffix)) {
        return false; // This is a version variant, not a component
      }
      return true;
    }
    // name2 is prefix of name1
    if (n1.startsWith(n2 + sep)) {
      // Additional check: make sure the suffix isn't a version indicator
      const suffix = n1.substring((n2 + sep).length);
      if (versionSuffixes.includes(suffix)) {
        return false; // This is a version variant, not a component
      }
      return true;
    }
  }

  // Check for common base names with different suffixes
  const commonBase = findCommonBase(n1, n2);
  if (commonBase && commonBase.length >= 4) { // Minimum 4 chars for meaningful base
    const suffix1 = n1.substring(commonBase.length);
    const suffix2 = n2.substring(commonBase.length);
    
    // Remove leading separators from suffixes
    const cleanSuffix1 = suffix1.replace(/^[-_\s]+/, '');
    const cleanSuffix2 = suffix2.replace(/^[-_\s]+/, '');
    
    // If either suffix is a version indicator, they're separate addons
    if (versionSuffixes.includes(cleanSuffix1) || versionSuffixes.includes(cleanSuffix2)) {
      return false;
    }
    
    // Check if both have addon-like suffixes
    const addonSuffixes = [
      '', '_core', '_main', '_options', '_config', '_configuration', '_locale', '_locales',
      '_merchant', '_vendor', '_auction', '_guild', '_broker', '_data', '_lib', '_library',
      '_frames', '_frame', '_unit', '_units', '_raid', '_party', '_solo', '_pvp', '_pve',
      '_archive', '_archives', '_templates', '_template', '_modelpaths', '_paths', '_models',
      '_sounds', '_sound', '_textures', '_texture', '_media', '_resources', '_resource',
      '-core', '-main', '-options', '-config', '-configuration', '-locale', '-locales',
      '-merchant', '-vendor', '-auction', '-guild', '-broker', '-data', '-lib', '-library',
      '-frames', '-frame', '-unit', '-units', '-raid', '-party', '-solo', '-pvp', '-pve',
      '-archive', '-archives', '-templates', '-template', '-modelpaths', '-paths', '-models',
      '-sounds', '-sound', '-textures', '-texture', '-media', '-resources', '-resource',
      'core', 'main', 'options', 'config', 'configuration', 'locale', 'locales',
      'merchant', 'vendor', 'auction', 'guild', 'broker', 'data', 'lib', 'library',
      'frames', 'frame', 'unit', 'units', 'raid', 'party', 'solo', 'pvp', 'pve',
      'archive', 'archives', 'templates', 'template', 'modelpaths', 'paths', 'models',
      'sounds', 'sound', 'textures', 'texture', 'media', 'resources', 'resource'
    ];
    
    if (addonSuffixes.includes(suffix1) && addonSuffixes.includes(suffix2)) {
      return true;
    }
  }

  // Check for space-separated words (e.g., "Shadowed Unit Frames" variants)
  const words1 = n1.split(/[\s_-]+/);
  const words2 = n2.split(/[\s_-]+/);
  
  if (words1.length > 1 && words2.length > 1) {
    // Check if any word is a version indicator
    const hasVersionWord1 = words1.some(word => versionSuffixes.includes(word));
    const hasVersionWord2 = words2.some(word => versionSuffixes.includes(word));
    
    if (hasVersionWord1 && hasVersionWord2) {
      return false; // Both have version words, they're separate addons
    }
    
    // Check if they share significant common words
    const commonWords = words1.filter(word => 
      word.length > 2 && words2.some(w => w === word)
    );
    
    // If they share 2+ meaningful words, they're likely related
    if (commonWords.length >= 2) return true;
    
    // Or if they share all but one word and that word is addon-like
    if (Math.abs(words1.length - words2.length) <= 1) {
      const allWords1 = new Set(words1);
      const allWords2 = new Set(words2);
      const intersection = new Set([...allWords1].filter(x => allWords2.has(x)));
      
      // If most words are shared, they're likely related
      if (intersection.size >= Math.min(allWords1.size, allWords2.size) - 1) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Find the common base between two strings
 * @param {string} str1 - First string
 * @param {string} str2 - Second string
 * @returns {string} Common base string
 */
function findCommonBase(str1, str2) {
  let i = 0;
  while (i < str1.length && i < str2.length && str1[i] === str2[i]) {
    i++;
  }
  return str1.substring(0, i);
}

/**
 * Find the main addon from a group of related addons
 * @param {Array} relatedAddons - Array of related addon objects
 * @returns {Object} The main addon object
 */
function findMainAddon(relatedAddons) {
  // Prefer addon with shortest name (likely the base name)
  let mainAddon = relatedAddons[0];
  
  for (const addon of relatedAddons) {
    // Prefer shorter names
    if (addon.folderName.length < mainAddon.folderName.length) {
      mainAddon = addon;
      continue;
    }
    
    // If same length, prefer names without common suffixes
    if (addon.folderName.length === mainAddon.folderName.length) {
      const hasNoSuffix = !hasCommonSuffix(addon.folderName.toLowerCase());
      const mainHasNoSuffix = !hasCommonSuffix(mainAddon.folderName.toLowerCase());
      
      if (hasNoSuffix && !mainHasNoSuffix) {
        mainAddon = addon;
      }
    }
  }
  
  return mainAddon;
}

/**
 * Check if a folder name has a common addon suffix
 * @param {string} name - Folder name (lowercase)
 * @returns {boolean} True if it has a common suffix
 */
function hasCommonSuffix(name) {
  const suffixes = [
    '_core', '_main', '_options', '_config', '_configuration', '_locale', '_locales',
    '_merchant', '_vendor', '_auction', '_guild', '_broker', '_data', '_lib', '_library',
    '_archive', '_archives', '_templates', '_template', '_modelpaths', '_paths', '_models',
    '_sounds', '_sound', '_textures', '_texture', '_media', '_resources', '_resource',
    '-core', '-main', '-options', '-config', '-configuration', '-locale', '-locales',
    '-merchant', '-vendor', '-auction', '-guild', '-broker', '-data', '-lib', '-library',
    '-archive', '-archives', '-templates', '-template', '-modelpaths', '-paths', '-models',
    '-sounds', '-sound', '-textures', '-texture', '-media', '-resources', '-resource',
    'core', 'main', 'options', 'config', 'locale', 'data', 'archive', 'templates', 'modelpaths'
  ];
  
  return suffixes.some(suffix => name.endsWith(suffix));
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
    const settings = await getSettings();
    const downloadPriority = settings.downloadPriority || 'releases';
    const release = await getLatestRelease(approvedRepoUrl, null, downloadPriority);
    
    // Determine addon name - prefer special cases, then .toc title, then repo name
    let addonName;
    const repoDisplayName = getRepoDisplayName(approvedRepoUrl);
    
    // Check if this is a special case that should override .toc title
    const isSpecialCase = approvedRepoUrl.toLowerCase().includes('atlaslootprojectepoch') || 
                         approvedRepoUrl.toLowerCase().includes('raynbock/atlasloot') ||
                         approvedRepoUrl.toLowerCase().includes('questie-epoch') || 
                         approvedRepoUrl.toLowerCase().includes('esurm/questie');
    
    if (isSpecialCase) {
      // Use special naming for these addons
      addonName = repoDisplayName;
    } else {
      // Use .toc title if available, otherwise use repo name
      addonName = existingAddon.title || repoDisplayName;
    }
    
    // For imported addons, preserve existing folder names by setting customFolderName
    const customFolderName = existingAddon.isGrouped ? 
      existingAddon.relatedFolders[0] : // For grouped addons, use the first folder name
      existingAddon.folderName;
    
    // Create managed addon object
    const managedAddon = {
      id: generateId(),
      name: addonName,
      repoUrl: approvedRepoUrl,
      currentVersion: 'Imported', // Always set to Imported for imported addons
      latestVersion: release.version,
      needsUpdate: true, // Allow updates for imported addons
      lastUpdated: new Date().toISOString(),
      installedFolders: existingAddon.isGrouped ? existingAddon.relatedFolders : [existingAddon.folderName],
      tocData: existingAddon.tocData,
      source: release.source || 'release',
      branch: release.branch,
      commit: release.commit,
      latestSource: release.source,
      latestBranch: release.branch,
      latestCommit: release.commit,
      // Preserve existing folder name for future updates
      customFolderName: customFolderName,
      // Mark as imported existing addon
      importedExisting: true
    };

    return managedAddon;
  } catch (error) {
    console.error('Failed to add existing addon:', error);
    throw new Error(`Failed to add existing addon: ${error.message}`);
  }
}

/**
 * Check if managed addons still exist in the addons folder
 * @param {Array<Object>} addons - Array of managed addon objects
 * @param {Object} settings - Settings object containing wowPath
 * @returns {Promise<Array<Object>>} Array of addons with existence status
 */
export async function checkAddonExistence(addons, settings = null) {
  if (!electronAPI) {
    console.warn('File system access not available for addon existence check');
    return addons; // Return unchanged if not in Electron environment
  }

  const appSettings = settings || await getSettings();
  if (!appSettings.wowPath) {
    console.warn('WoW path not configured for addon existence check');
    return addons; // Return unchanged if no WoW path
  }

  const addonsPath = pathUtils.join(appSettings.wowPath, 'Interface', 'AddOns');
  
  const updatedAddons = [];
  
  for (const addon of addons) {
    let allFoldersExist = true;
    const missingFolders = [];
    
    if (addon.installedFolders && addon.installedFolders.length > 0) {
      for (const folderName of addon.installedFolders) {
        const folderPath = pathUtils.join(addonsPath, folderName);
        
        try {
          const exists = await fileSystem.checkDirectory(folderPath);
          if (!exists) {
            allFoldersExist = false;
            missingFolders.push(folderName);
          }
        } catch (error) {
          console.error(`Error checking folder ${folderPath}:`, error);
          allFoldersExist = false;
          missingFolders.push(folderName);
        }
      }
    } else {
      // Fallback: check if installPath exists
      if (addon.installPath) {
        try {
          const exists = await fileSystem.checkDirectory(addon.installPath);
          if (!exists) {
            allFoldersExist = false;
            missingFolders.push(pathUtils.basename(addon.installPath));
          }
        } catch (error) {
          console.error(`Error checking install path ${addon.installPath}:`, error);
          allFoldersExist = false;
          missingFolders.push(pathUtils.basename(addon.installPath));
        }
      }
    }
    
    updatedAddons.push({
      ...addon,
      exists: allFoldersExist,
      missingFolders: missingFolders
    });
  }
  
  return updatedAddons;
}

// Export settings functions
export { getSettings, saveSettings };
