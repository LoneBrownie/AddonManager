import { useState, useEffect, useCallback } from 'react';
import { getLatestRelease } from '../services/api-client';
import { 
  installAddon, 
  updateAddon as updateAddonService, 
  checkForUpdates as checkUpdatesService, 
  removeAddon as removeAddonService,
  scanExistingAddons,
  getSettings
} from '../services/addon-manager';

const STORAGE_KEY = 'addons';

// Helper function to get display name from repository URL
const getRepoDisplayName = (url) => {
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
      return pathParts[1]; // Just the repo name
    }
  } catch {
    // fallback
  }
  return url;
};

// Function to normalize addon names based on repository URL
const normalizeAddonName = (addon) => {
  const repoDisplayName = getRepoDisplayName(addon.repoUrl);
  
  // Check if this is a special case that should override any existing name
  const isSpecialCase = addon.repoUrl.toLowerCase().includes('atlaslootprojectepoch') || 
                       addon.repoUrl.toLowerCase().includes('raynbock/atlasloot') ||
                       addon.repoUrl.toLowerCase().includes('questie-epoch') || 
                       addon.repoUrl.toLowerCase().includes('esurm/questie');
  
  let correctName;
  if (isSpecialCase) {
    // Use special naming for these addons
    correctName = repoDisplayName;
  } else {
    // For other addons, prefer the name from .toc data if available
    const tocTitle = addon.tocData && addon.tocData.title ? addon.tocData.title : null;
    correctName = tocTitle || addon.name || repoDisplayName;
  }
  
  return {
    ...addon,
    name: correctName
  };
};

export function useAddons() {
  const [addons, setAddons] = useState([]);
  const [existingAddons, setExistingAddons] = useState([]);
  const [wowPath, setWowPath] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  // Load addons from persistent storage on mount
  useEffect(() => {
    const loadAddons = async () => {
      try {
        // Try to load from Electron userData first
        if (window.electronAPI) {
          const data = await window.electronAPI.loadUserData(STORAGE_KEY);
          if (data && data.addons) {
            // Normalize addon names when loading
            const normalizedAddons = data.addons.map(normalizeAddonName);
            setAddons(normalizedAddons);
            
            // Save normalized names back to storage if any names changed
            const hasChanges = data.addons.some((addon, index) => 
              addon.name !== normalizedAddons[index].name
            );
            if (hasChanges) {
              await window.electronAPI.saveUserData(STORAGE_KEY, { addons: normalizedAddons });
            }
            return;
          }
        }
        
        // Fallback to localStorage for migration
        const saved = localStorage.getItem('wow-addon-manager-data');
        if (saved) {
          const data = JSON.parse(saved);
          if (data.addons) {
            // Normalize addon names when loading from localStorage
            const normalizedAddons = (data.addons || []).map(normalizeAddonName);
            setAddons(normalizedAddons);
            // Migrate to persistent storage if available
            if (window.electronAPI) {
              await window.electronAPI.saveUserData(STORAGE_KEY, { addons: normalizedAddons });
              // Clear localStorage after successful migration
              localStorage.removeItem('wow-addon-manager-data');
            }
          }
        }
      } catch (err) {
        console.error('Failed to load saved data:', err);
        setError('Failed to load saved addon data');
      }
    };
    
    loadAddons();
  }, []);

  // Load settings including wowPath
  useEffect(() => {
    const loadSettings = async () => {
      try {
        const settings = await getSettings();
        setWowPath(settings.wowPath || null);
      } catch (err) {
        console.error('Failed to load settings:', err);
      }
    };
    
    loadSettings();
  }, []);

  // Save addons to persistent storage whenever addons change
  useEffect(() => {
    const saveAddons = async () => {
      if (addons.length === 0) return; // Don't save empty state on initial load
      
      try {
        if (window.electronAPI) {
          await window.electronAPI.saveUserData(STORAGE_KEY, { addons });
        } else {
          // Fallback to localStorage
          localStorage.setItem('wow-addon-manager-data', JSON.stringify({ addons }));
        }
      } catch (err) {
        console.error('Failed to save data:', err);
      }
    };
    
    saveAddons();
  }, [addons]);

  // Function to normalize all existing addon names
  const normalizeAllAddonNames = useCallback(() => {
    setAddons(prev => prev.map(normalizeAddonName));
  }, []);

  const addAddon = useCallback(async (repoUrl, customOptions = {}) => {
    setLoading(true);
    setError(null);
    
    try {
      // Check if addon already exists
      const existing = addons.find(addon => addon.repoUrl === repoUrl);
      if (existing) {
        throw new Error('Addon already exists in the list');
      }

      // Handle direct download case
      if (customOptions.isDirectDownload) {
        // For direct downloads, we need to handle them differently
        const installedAddon = await installAddon(repoUrl, {
          downloadUrl: repoUrl,
          version: 'latest',
          name: customOptions.customFolderName || 'unknown'
        }, customOptions);
        
        setAddons(prev => [...prev, installedAddon]);
      } else {
        // Get release info from API, passing preferred asset name if specified
        const release = await getLatestRelease(repoUrl, customOptions.preferredAssetName);
        
        // Install the addon
        const installedAddon = await installAddon(repoUrl, release, customOptions);
        
        setAddons(prev => [...prev, installedAddon]);
      }
    } catch (err) {
      console.error('Failed to add addon:', err);
      setError(err.message || 'Failed to add addon');
    } finally {
      setLoading(false);
    }
  }, [addons]);

  const updateAddon = useCallback(async (addonId) => {
    setLoading(true);
    setError(null);
    
    try {
      const addon = addons.find(a => a.id === addonId);
      if (!addon) {
        throw new Error('Addon not found');
      }

      const updatedAddon = await updateAddonService(addon);
      
      setAddons(prev => prev.map(a => 
        a.id === addonId ? updatedAddon : a
      ));
    } catch (err) {
      console.error('Failed to update addon:', err);
      setError(err.message || 'Failed to update addon');
    } finally {
      setLoading(false);
    }
  }, [addons]);

  const updateAllAddons = useCallback(async () => {
    setLoading(true);
    setError(null);
    
    try {
      const updatableAddons = addons.filter(addon => addon.needsUpdate);
      
      for (const addon of updatableAddons) {
        try {
          const updatedAddon = await updateAddonService(addon);
          setAddons(prev => prev.map(a => 
            a.id === addon.id ? updatedAddon : a
          ));
        } catch (err) {
          console.error(`Failed to update ${addon.name}:`, err);
        }
      }
    } catch (err) {
      console.error('Failed to update addons:', err);
      setError(err.message || 'Failed to update addons');
    } finally {
      setLoading(false);
    }
  }, [addons]);

  const checkForUpdates = useCallback(async () => {
    setLoading(true);
    setError(null);
    
    try {
      const updatedAddons = await checkUpdatesService(addons);
      setAddons(updatedAddons);
    } catch (err) {
      console.error('Failed to check for updates:', err);
      setError(err.message || 'Failed to check for updates');
    } finally {
      setLoading(false);
    }
  }, [addons]);

  const removeAddon = useCallback(async (addonId) => {
    setLoading(true);
    setError(null);
    
    try {
      // Find the addon to get file paths
      const addon = addons.find(a => a.id === addonId);
      if (!addon) {
        throw new Error('Addon not found');
      }

      // Get current settings
      const settings = await getSettings();

      // Delete files from filesystem
      await removeAddonService(addon, settings);
      
      // Remove from state
      setAddons(prev => prev.filter(a => a.id !== addonId));
    } catch (err) {
      console.error('Failed to remove addon:', err);
      setError(err.message || 'Failed to remove addon');
    } finally {
      setLoading(false);
    }
  }, [addons]);

  // Scan for existing addons and update state
  const scanForExistingAddons = useCallback(async (wowPath) => {
    setLoading(true);
    setError(null);
    
    try {
      let settings;
      if (wowPath) {
        settings = { wowPath };
      } else {
        settings = await getSettings();
      }
      
      const scannedAddons = await scanExistingAddons(settings);
      
      // Filter out addons that are already managed
      const managedFolders = new Set();
      addons.forEach(addon => {
        addon.installedFolders?.forEach(folder => managedFolders.add(folder));
      });
      
      const unmanaged = scannedAddons.filter(existing => 
        !managedFolders.has(existing.folderName)
      );
      
      setExistingAddons(unmanaged);
      return unmanaged; // Return the results
    } catch (err) {
      console.error('Failed to scan for existing addons:', err);
      setError(err.message || 'Failed to scan for existing addons');
      return []; // Return empty array on error
    } finally {
      setLoading(false);
    }
  }, [addons]);

  const scanExisting = useCallback(async () => {
    setLoading(true);
    setError(null);
    
    try {
      // Get current settings
      const settings = await getSettings();
      
      const existingAddons = await scanExistingAddons(settings);
      
      // Filter out addons that are already managed
      const managedFolders = new Set();
      addons.forEach(addon => {
        addon.installedFolders?.forEach(folder => managedFolders.add(folder));
      });
      
      const unmanaged = existingAddons.filter(existing => 
        !managedFolders.has(existing.folderName)
      );
      
      return unmanaged;
    } catch (err) {
      console.error('Failed to scan existing addons:', err);
      setError(err.message || 'Failed to scan existing addons');
      return [];
    } finally {
      setLoading(false);
    }
  }, [addons]);

  const addExistingAddonToManagement = useCallback(async (existingAddon, repoUrl) => {
    setLoading(true);
    setError(null);
    
    try {
      // Check if an addon with this repository already exists
      const existingManagedAddon = addons.find(addon => addon.repoUrl === repoUrl);
      
      if (existingManagedAddon) {
        // Check if this specific folder is already managed
        if (existingManagedAddon.installedFolders && existingManagedAddon.installedFolders.includes(existingAddon.folderName)) {
          throw new Error(`Addon folder "${existingAddon.folderName}" is already managed under "${existingManagedAddon.name}"`);
        }
        
        // Add this folder to the existing addon
        const newFolders = [...(existingManagedAddon.installedFolders || []), existingAddon.folderName];
        
        // Generate a more generic name if this is becoming a multi-folder addon
        let addonName = existingManagedAddon.name;
        if (newFolders.length === 2) {
          // First time adding a second folder - check if we should use a more generic name
          const isSpecialCase = repoUrl.toLowerCase().includes('atlaslootprojectepoch') || 
                               repoUrl.toLowerCase().includes('raynbock/atlasloot') ||
                               repoUrl.toLowerCase().includes('questie-epoch') || 
                               repoUrl.toLowerCase().includes('esurm/questie');
          
          if (isSpecialCase) {
            // For special cases, always use the repository-based name
            addonName = getRepoDisplayName(repoUrl);
          }
          // For other addons, keep the existing name (likely from .toc)
        }
        
        const updatedAddon = {
          ...existingManagedAddon,
          name: addonName,
          installedFolders: newFolders,
          lastUpdated: new Date().toISOString()
        };
        
        // Update the addon in the list
        setAddons(prev => prev.map(addon => 
          addon.id === existingManagedAddon.id ? updatedAddon : addon
        ));
        
        return updatedAddon;
      } else {
        // Create new addon entry for existing addon
        const { getLatestRelease } = await import('../services/api-client.js');
        const release = await getLatestRelease(repoUrl);
        
        const managedAddon = {
          id: `existing-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
          name: existingAddon.folderName,
          repoUrl: repoUrl,
          currentVersion: 'unknown',
          latestVersion: release.version,
          needsUpdate: false, // We don't know the current version
          installPath: existingAddon.folderPath || `Interface/AddOns/${existingAddon.folderName}`,
          installedFolders: [existingAddon.folderName],
          addedAt: new Date().toISOString(),
          lastUpdated: new Date().toISOString()
        };
        
        setAddons(prev => [...prev, managedAddon]);
        
        return managedAddon;
      }
    } catch (err) {
      console.error('Failed to add existing addon:', err);
      setError(err.message || 'Failed to add existing addon');
      throw err;
    } finally {
      setLoading(false);
    }
  }, [addons]);

  const addExistingAddon = useCallback(async (addonOrPath, repoUrl) => {
    setLoading(true);
    setError(null);
    
    try {
      let existingAddon;
      let folderName;
      
      // Handle both addon object and string path
      if (typeof addonOrPath === 'object' && addonOrPath.folderName) {
        // It's an addon object
        existingAddon = addonOrPath;
        folderName = addonOrPath.folderName;
      } else {
        // It's a string path
        folderName = addonOrPath.split(/[/\\]/).pop();
        existingAddon = { folderName, folderPath: addonOrPath };
      }
      
      const managedAddon = await addExistingAddonToManagement(existingAddon, repoUrl);
      
      // Remove from existing addons list
      setExistingAddons(prev => prev.filter(addon => {
        const addonFolderName = typeof addon === 'object' ? addon.folderName : addon.split(/[/\\]/).pop();
        return addonFolderName !== folderName;
      }));
      
      return managedAddon;
    } catch (err) {
      console.error('Failed to add existing addon:', err);
      setError(err.message || 'Failed to add existing addon');
      throw err;
    } finally {
      setLoading(false);
    }
  }, [addExistingAddonToManagement]);

  return {
    addons,
    addAddon,
    updateAddon,
    updateAllAddons,
    checkForUpdates,
    removeAddon,
    scanExisting,
    addExistingAddonToManagement,
    scanForExistingAddons,
    existingAddons,
    addExistingAddon,
    wowPath,
    normalizeAllAddonNames,
    loading,
    error
  };
}
