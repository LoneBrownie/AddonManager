import { useState, useEffect, useCallback } from 'react';
import { getLatestRelease } from '../services/api-client';
import { 
  installAddon, 
  updateAddon as updateAddonService, 
  checkForUpdates as checkUpdatesService, 
  removeAddon as removeAddonService,
  scanExistingAddons,
  getSettings,
  checkAddonExistence
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
    name: correctName,
    // Ensure allowUpdates is always a boolean to prevent React controlled/uncontrolled warnings
    // For imported addons (importedExisting: true), default to false
    // For regular addons, default to true
    // But always respect existing values if they're explicitly set
    allowUpdates: addon.allowUpdates !== undefined 
      ? addon.allowUpdates 
      : addon.importedExisting 
        ? false 
        : true
  };
};

// Helper function to sort addons alphabetically by name
const sortAddonsAlphabetically = (addons) => {
  return [...addons].sort((a, b) => {
    const nameA = (a.name || '').toLowerCase();
    const nameB = (b.name || '').toLowerCase();
    return nameA.localeCompare(nameB);
  });
};

export function useAddons() {
  const [addons, setAddons] = useState([]);
  const [existingAddons, setExistingAddons] = useState([]);
  const [wowPath, setWowPath] = useState(null);
  const [loading, setLoading] = useState(false);
  const [updatingAddons, setUpdatingAddons] = useState(new Set());
  const [error, setError] = useState(null);

  // Load addons from persistent storage on mount
  useEffect(() => {
    const loadAddons = async () => {
      try {
        // Try to load from Electron userData first
        if (window.electronAPI) {
          const data = await window.electronAPI.loadUserData(STORAGE_KEY);
          if (data && data.addons) {
            // Normalize addon names when loading and sort alphabetically
            const normalizedAddons = sortAddonsAlphabetically(data.addons.map(normalizeAddonName));
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
            // Normalize addon names when loading from localStorage and sort alphabetically
            const normalizedAddons = sortAddonsAlphabetically((data.addons || []).map(normalizeAddonName));
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

  // Load settings including wowPath and check addon existence
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

  // Background check for addon existence when addons or wowPath changes
  useEffect(() => {
    const checkExistence = async () => {
      if (!wowPath || addons.length === 0) return;
      
      try {
        const updatedAddons = await checkAddonExistence(addons);
        
        // Remove addons that don't exist on disk
        const existingAddons = updatedAddons.filter(addon => addon.exists !== false);
        
        // Check if any addons were removed
        const removedCount = addons.length - existingAddons.length;
        
        if (removedCount > 0) {
          console.log(`Removed ${removedCount} missing addon(s) from managed list`);
          setAddons(sortAddonsAlphabetically(existingAddons));
        } else {
          // Check for other changes (like missingFolders)
          const hasChanges = updatedAddons.some((addon, index) => {
            const originalAddon = addons[index];
            return addon.exists !== originalAddon.exists || 
                   JSON.stringify(addon.missingFolders) !== JSON.stringify(originalAddon.missingFolders);
          });
          
          if (hasChanges) {
            setAddons(sortAddonsAlphabetically(existingAddons));
          }
        }
      } catch (err) {
        console.error('Failed to check addon existence:', err);
        // Don't show error to user for background checks
      }
    };
    
    // Check immediately, then set up periodic checks
    checkExistence();
    
    // Check every 30 seconds in the background
    const interval = setInterval(checkExistence, 30000);
    
    return () => clearInterval(interval);
  }, [wowPath, addons]); // Include addons to satisfy dependency array

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
    setAddons(prev => sortAddonsAlphabetically(prev.map(normalizeAddonName)));
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
  // Ensure per-addon download priority is preserved (default to 'releases')
  customOptions.downloadPriority = customOptions.downloadPriority || 'releases';
        const installedAddon = await installAddon(repoUrl, {
          downloadUrl: repoUrl,
          version: 'latest',
          name: customOptions.customFolderName || 'unknown'
        }, customOptions);
        
        setAddons(prev => sortAddonsAlphabetically([...prev, installedAddon]));
      } else {
  // Detect whether caller explicitly provided a downloadPriority property
  const hasExplicitPriority = Object.prototype.hasOwnProperty.call(customOptions, 'downloadPriority');

  // Fetch release info. If caller provided an explicit preference, pass it; otherwise let the API client use its default.
  const release = await getLatestRelease(repoUrl, customOptions.preferredAssetName, hasExplicitPriority ? customOptions.downloadPriority : undefined);

  // Decide final per-addon download priority:
  // - If explicit, keep it (even if it's falsy).
  // - Otherwise default to 'releases'.
  if (hasExplicitPriority) {
    // leave customOptions.downloadPriority as provided
  } else {
    customOptions.downloadPriority = 'releases';
  }

  // Install the addon (customOptions includes downloadPriority)
  const installedAddon = await installAddon(repoUrl, release, customOptions);
        
        setAddons(prev => sortAddonsAlphabetically([...prev, installedAddon]));
      }
    } catch (err) {
      console.error('Failed to add addon:', err);
      setError(err.message || 'Failed to add addon');
    } finally {
      setLoading(false);
    }
  }, [addons]);

  const updateAddon = useCallback(async (addonId) => {
    setUpdatingAddons(prev => new Set(prev).add(addonId));
    setError(null);
    
    try {
      const addon = addons.find(a => a.id === addonId);
      if (!addon) {
        throw new Error('Addon not found');
      }

      const updatedAddon = await updateAddonService(addon);
      
      setAddons(prev => sortAddonsAlphabetically(prev.map(a => 
        a.id === addonId ? updatedAddon : a
      )));
    } catch (err) {
      console.error('Failed to update addon:', err);
      setError(err.message || 'Failed to update addon');
    } finally {
      setUpdatingAddons(prev => {
        const newSet = new Set(prev);
        newSet.delete(addonId);
        return newSet;
      });
    }
  }, [addons]);

  const updateAllAddons = useCallback(async () => {
    setLoading(true);
    setError(null);
    
    try {
      const updatableAddons = addons.filter(addon => addon.needsUpdate);
      
      // Mark all addons as updating
      setUpdatingAddons(prev => {
        const newSet = new Set(prev);
        updatableAddons.forEach(addon => newSet.add(addon.id));
        return newSet;
      });
      
      for (const addon of updatableAddons) {
        try {
          const updatedAddon = await updateAddonService(addon);
          setAddons(prev => sortAddonsAlphabetically(prev.map(a => 
            a.id === addon.id ? updatedAddon : a
          )));
        } catch (err) {
          console.error(`Failed to update ${addon.name}:`, err);
        } finally {
          // Remove this addon from updating set
          setUpdatingAddons(prev => {
            const newSet = new Set(prev);
            newSet.delete(addon.id);
            return newSet;
          });
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
    console.log('Check for updates button clicked');
    setLoading(true);
    setError(null);
    
    try {
      // Only check updates for addons that allow updates
      const addonsToCheck = addons.filter(addon => addon.allowUpdates !== false);
      const addonsWithoutUpdates = addons.filter(addon => addon.allowUpdates === false);
      
      console.log(`Total addons: ${addons.length}, Checking: ${addonsToCheck.length}, Skipping: ${addonsWithoutUpdates.length}`);
      
      if (addonsToCheck.length === 0) {
        console.warn('No addons found that allow updates');
        setError('No addons are configured to allow updates');
        return;
      }
      
      // Check updates for allowed addons
      const updatedAddons = await checkUpdatesService(addonsToCheck);
      
      console.log('Update check completed, processing results...');
      
      // Combine checked addons with non-updateable addons (preserving their current state and lastChecked)
      const allAddons = [
        ...updatedAddons,
        ...addonsWithoutUpdates.map(addon => ({
          ...addon,
          needsUpdate: false // Force no updates for these addons; preserve lastChecked
        }))
      ];
      
      // Sort alphabetically by name to maintain consistent order
      setAddons(sortAddonsAlphabetically(allAddons));
      
      // Count updates found
      const updatesFound = updatedAddons.filter(addon => addon.needsUpdate).length;
      console.log(`Check for updates completed. Found ${updatesFound} updates available.`);
      
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
      
      const unmanaged = scannedAddons.filter(existing => {
        // For grouped addons, check if any of the related folders are managed
        if (existing.isGrouped && existing.relatedFolders) {
          return !existing.relatedFolders.some(folder => managedFolders.has(folder));
        }
        // For single folder addons, check the folder name
        return !managedFolders.has(existing.folderName);
      });
      
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

  const addExistingAddonToManagement = useCallback(async (existingAddon, repoUrl, options = {}) => {
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
        
        // For multi-folder addons that are imported, we need to handle customFolderName carefully
        // If this is the first folder being added to an existing single-folder addon,
        // preserve the original folder name as customFolderName
        let customFolderName = existingManagedAddon.customFolderName;
        if (!customFolderName && existingManagedAddon.installedFolders && existingManagedAddon.installedFolders.length === 1) {
          // If the existing addon doesn't have a customFolderName but has one folder, preserve it
          customFolderName = existingManagedAddon.installedFolders[0];
        }
        
        const updatedAddon = {
          ...existingManagedAddon,
          name: addonName,
          installedFolders: newFolders,
          customFolderName: customFolderName, // Preserve or set the custom folder name
          lastUpdated: new Date().toISOString()
        };
        
        // Update the addon in the list
        setAddons(prev => sortAddonsAlphabetically(prev.map(addon => 
          addon.id === existingManagedAddon.id ? updatedAddon : addon
        )));
        
        return updatedAddon;
      } else {
        // Create new addon entry for existing addon
        const { getLatestRelease } = await import('../services/api-client.js');
        
        let release;
        try {
          release = await getLatestRelease(repoUrl);
        } catch (apiError) {
          console.warn('Failed to fetch release info from API, using fallback values:', apiError.message);
          // Create fallback release info when API fails
          release = {
            version: 'Unknown',
            source: 'unknown',
            branch: 'main',
            commit: null
          };
        }
        
        // For imported addons, preserve existing folder names by setting customFolderName
        const customFolderName = existingAddon.isGrouped ? 
          existingAddon.relatedFolders[0] : // For grouped addons, use the first folder name
          existingAddon.folderName;
        
        // Use existing addon data to preserve current state
        const managedAddon = {
          id: `existing-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
          name: existingAddon.title || existingAddon.folderName,
          repoUrl: repoUrl,
          currentVersion: 'Imported', // Always set to Imported for imported addons
          latestVersion: release.version,
          needsUpdate: options.allowUpdates === true ? true : false, // Only set needsUpdate if updates are allowed
          installPath: existingAddon.folderPath || `Interface/AddOns/${existingAddon.folderName}`,
          installedFolders: existingAddon.isGrouped ? existingAddon.relatedFolders : [existingAddon.folderName],
          addedAt: new Date().toISOString(),
          lastUpdated: new Date().toISOString(),
          // Mark as imported so we know not to auto-update
          importedExisting: true,
          // Set update permission based on user choice
          allowUpdates: options.allowUpdates === true, // Default to false unless explicitly set to true
          // Preserve existing folder name for future updates
          customFolderName: customFolderName,
          // Preserve any existing addon metadata
          tocData: existingAddon.tocData,
          author: existingAddon.author,
          notes: existingAddon.notes,
          // Add release metadata (will be fallback values if API failed)
          source: release.source || 'unknown',
          branch: release.branch || 'main',
          commit: release.commit || null,
          latestSource: release.source || 'unknown',
          latestBranch: release.branch || 'main',
          latestCommit: release.commit || null
          ,
          // Use user's global download priority preference unless explicitly specified
          downloadPriority: options.downloadPriority || undefined
        };
        
        setAddons(prev => sortAddonsAlphabetically([...prev, managedAddon]));
        
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

  const addExistingAddon = useCallback(async (addonOrPath, repoUrl, options = {}) => {
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
      
      const managedAddon = await addExistingAddonToManagement(existingAddon, repoUrl, options);
      
      // Update the addons state to include the new managed addon
      setAddons(prev => {
        const filtered = prev.filter(a => a.id !== managedAddon.id);
        const updatedAddons = sortAddonsAlphabetically([...filtered, managedAddon]);
        
        // Trigger rescan after state update with the updated addons list
        setTimeout(async () => {
          try {
            let settings;
            try {
              settings = await getSettings();
            } catch (err) {
              console.warn('Could not get settings for rescan:', err);
              return;
            }
            
            const scannedAddons = await scanExistingAddons(settings);
            
            // Filter using the current managed addons
            const managedFolders = new Set();
            updatedAddons.forEach(addon => {
              addon.installedFolders?.forEach(folder => managedFolders.add(folder));
            });
            
            const unmanaged = scannedAddons.filter(existing => {
              if (existing.isGrouped && existing.relatedFolders) {
                return !existing.relatedFolders.some(folder => managedFolders.has(folder));
              }
              return !managedFolders.has(existing.folderName);
            });
            
            setExistingAddons(unmanaged);
          } catch (scanError) {
            console.warn('Failed to refresh existing addons list after import:', scanError);
          }
        }, 50);
        
        return updatedAddons;
      });
      
      return managedAddon;
    } catch (err) {
      console.error('Failed to add existing addon:', err);
      setError(err.message || 'Failed to add existing addon');
      throw err;
    } finally {
      setLoading(false);
    }
  }, [addExistingAddonToManagement]);

  // Manual check for addon existence
  const checkAddonExistenceManually = useCallback(async () => {
    if (!wowPath || addons.length === 0) {
      setError('No WoW path set or no addons to check');
      return;
    }
    
    setLoading(true);
    setError(null);
    
    try {
      const updatedAddons = await checkAddonExistence(addons);
      
      // Remove addons that don't exist on disk
      const existingAddons = updatedAddons.filter(addon => addon.exists !== false);
      const removedCount = addons.length - existingAddons.length;
      
      setAddons(sortAddonsAlphabetically(existingAddons));
      
      if (removedCount === 0) {
        console.log('All addons exist on disk');
      } else {
        console.log(`Removed ${removedCount} missing addon(s) from managed list`);
      }
    } catch (err) {
      console.error('Failed to check addon existence:', err);
      setError(err.message || 'Failed to check addon existence');
    } finally {
      setLoading(false);
    }
  }, [wowPath, addons]);

  // Helper function to check if specific addon is updating
  const isAddonUpdating = useCallback((addonId) => {
    return updatingAddons.has(addonId);
  }, [updatingAddons]);

  // Toggle update permission for an addon
  const toggleUpdatePermission = useCallback((addonId) => {
    setAddons(prev => sortAddonsAlphabetically(prev.map(addon => {
      if (addon.id === addonId) {
        const newAllowUpdates = !addon.allowUpdates;
        return {
          ...addon,
          allowUpdates: newAllowUpdates,
          // If disabling updates, clear needsUpdate flag
          needsUpdate: newAllowUpdates ? addon.needsUpdate : false
        };
      }
      return addon;
    })));
  }, []);

  // Set per-addon download priority ('releases' or 'code')
  const setAddonDownloadPriority = useCallback((addonId, priority) => {
    if (!['releases', 'code'].includes(priority)) return;
    setAddons(prev => sortAddonsAlphabetically(prev.map(addon => {
      if (addon.id === addonId) {
        return {
          ...addon,
          downloadPriority: priority
        };
      }
      return addon;
    })));
  }, []);

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
    checkAddonExistenceManually,
    isAddonUpdating,
    toggleUpdatePermission,
  setAddonDownloadPriority,
    loading,
    error
  };
}
