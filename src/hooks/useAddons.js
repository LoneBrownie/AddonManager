import { useState, useEffect, useCallback } from 'react';
import { getLatestRelease } from '../services/api-client';
import { 
  installAddon, 
  updateAddon as updateAddonService, 
  checkForUpdates as checkUpdatesService, 
  removeAddon as removeAddonService,
  scanExistingAddons,
  addExistingAddon,
  getSettings
} from '../services/addon-manager';

const STORAGE_KEY = 'addons';

export function useAddons() {
  const [addons, setAddons] = useState([]);
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
            setAddons(data.addons);
            return;
          }
        }
        
        // Fallback to localStorage for migration
        const saved = localStorage.getItem('wow-addon-manager-data');
        if (saved) {
          const data = JSON.parse(saved);
          if (data.addons) {
            setAddons(data.addons || []);
            // Migrate to persistent storage if available
            if (window.electronAPI) {
              await window.electronAPI.saveUserData(STORAGE_KEY, data);
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
      // Check if addon already exists
      const existing = addons.find(addon => addon.repoUrl === repoUrl);
      if (existing) {
        throw new Error('Addon with this repository already exists in the list');
      }

      const managedAddon = await addExistingAddon(existingAddon, repoUrl);
      setAddons(prev => [...prev, managedAddon]);
      
      return managedAddon;
    } catch (err) {
      console.error('Failed to add existing addon:', err);
      setError(err.message || 'Failed to add existing addon');
      throw err;
    } finally {
      setLoading(false);
    }
  }, [addons]);

  return {
    addons,
    addAddon,
    updateAddon,
    updateAllAddons,
    checkForUpdates,
    removeAddon,
    scanExisting,
    addExistingAddonToManagement,
    loading,
    error
  };
}
