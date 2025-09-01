import React, { useState, useEffect } from 'react';
import './HandyAddons.css';

// Curated list blob URL
const HANDY_ADDONS_URL = 'https://stbrowniesmanagerprod36f.blob.core.windows.net/blob/handy-addons.json';

const CATEGORIES = [
  'All',
  'Core',
  'Raid Frames',
  'Healing',
  'Management',
  'Questing',
  'Interface'
];

function HandyAddons({ onAddAddon, installedAddons, loading, addButton }) {
  const [selectedCategory, setSelectedCategory] = useState('All');
  const [installing, setInstalling] = useState(new Set());
  const [handyAddons, setHandyAddons] = useState([]);
  const [loadingList, setLoadingList] = useState(false);
  const [listError, setListError] = useState(null);

  const fetchHandyAddons = async () => {
    setLoadingList(true);
    setListError(null);
    try {
      // Prefer main-process fetch to avoid CORS issues; fallback to window.fetch
      let json;
      if (window && window.electronAPI && typeof window.electronAPI.fetchCuratedList === 'function') {
        const result = await window.electronAPI.fetchCuratedList(HANDY_ADDONS_URL);
        if (!result || !result.ok) throw new Error(result && result.message ? result.message : 'Failed to fetch curated list from main process');
        json = result.json;
      } else {
        const resp = await fetch(HANDY_ADDONS_URL);
        if (!resp.ok) throw new Error(`Failed to fetch curated list: ${resp.status}`);
        json = await resp.json();
      }
      if (!Array.isArray(json)) throw new Error('Invalid curated list format');
      setHandyAddons(json);
    } catch (err) {
      console.error('Failed to load handy-addons.json:', err);
      setListError(err.message || String(err));
      setHandyAddons([]);
    } finally {
      setLoadingList(false);
    }
  };

  useEffect(() => {
    fetchHandyAddons();
  }, []);

  // Partition the curated list into Project Epoch addons and other 3.3.5a addons
  // Use explicit epochAddon boolean when provided, otherwise fall back to heuristics.
  const isProjectEpoch = (addon) => {
    if (typeof addon.epochAddon === 'boolean') return addon.epochAddon === true;
    return /epoch/i.test(addon.name || '') || /epoch/i.test(addon.id || '') || /epoch/i.test(addon.repoUrl || '');
  };

  const projectEpochAddons = handyAddons.filter(isProjectEpoch);
  // Any addon not marked as Project Epoch goes into the "Other Addons" section
  const otherAddons = handyAddons.filter(a => !isProjectEpoch(a));

  const applyCategory = (list) => selectedCategory === 'All' ? list : list.filter(addon => addon.category === selectedCategory);

  const filteredProjectEpochAddons = applyCategory(projectEpochAddons);
  const filteredOtherAddons = applyCategory(otherAddons);

  const handleInstall = async (addon) => {
    // Install dependencies first (recursively), then the addon itself.
    const visited = new Set();

    const installById = async (addonId) => {
      if (visited.has(addonId)) return; // avoid cycles / duplicate work
      visited.add(addonId);

  const depAddon = handyAddons.find(a => a.id === addonId);
      if (!depAddon) return; // unknown dependency id

      // If already installed, skip
      if (isAddonInstalled(depAddon.repoUrl)) return;

      // Mark as installing
      setInstalling(prev => new Set(prev).add(depAddon.id));

      try {
        // install dependencies of this dependency first
        const childDeps = Array.isArray(depAddon.dependencies) ? depAddon.dependencies : [];
        for (const childId of childDeps) {
          await installById(childId);
        }

        // perform this dependency install
        if (depAddon.customFolderName || depAddon.isDirectDownload || depAddon.preferredAssetName) {
          await onAddAddon(depAddon.repoUrl, {
            customFolderName: depAddon.customFolderName,
            isDirectDownload: depAddon.isDirectDownload,
            preferredAssetName: depAddon.preferredAssetName
          });
        } else {
          await onAddAddon(depAddon.repoUrl);
        }
      } catch (err) {
        console.error(`Failed to install dependency ${depAddon.id}:`, err);
        // continue; main install may still try
      } finally {
        setInstalling(prev => {
          const newSet = new Set(prev);
          newSet.delete(depAddon.id);
          return newSet;
        });
      }
    };

    // Start: mark main addon as installing so UI disables button immediately
    setInstalling(prev => new Set(prev).add(addon.id));

    try {
  // Resolve declared dependencies (only explicit dependencies are used)
  const depIds = Array.isArray(addon.dependencies) ? addon.dependencies : [];

      // Install each dependency (recursively)
      for (const depId of depIds) {
        await installById(depId);
      }

      // Finally install the requested addon (unless already installed)
      if (!isAddonInstalled(addon.repoUrl)) {
        if (addon.customFolderName || addon.isDirectDownload || addon.preferredAssetName) {
          await onAddAddon(addon.repoUrl, {
            customFolderName: addon.customFolderName,
            isDirectDownload: addon.isDirectDownload,
            preferredAssetName: addon.preferredAssetName
          });
        } else {
          await onAddAddon(addon.repoUrl);
        }
      }
    } catch (error) {
      console.error('Failed to install addon or dependencies:', error);
    } finally {
      setInstalling(prev => {
        const newSet = new Set(prev);
        newSet.delete(addon.id);
        return newSet;
      });
    }
  };

  const isAddonInstalled = (repoUrl) => {
    return installedAddons.some(addon => addon.repoUrl === repoUrl);
  };

  const isAddonInstalling = (addonId) => {
    return installing.has(addonId);
  };

  const renderAddonCard = (addon) => {
    const installed = isAddonInstalled(addon.repoUrl);
    const isInstalling = isAddonInstalling(addon.id);
  // Resolve dependencies: use explicit addon.dependencies (array of ids) only.
  const depIds = Array.isArray(addon.dependencies) ? addon.dependencies : [];
    const depNames = depIds.map(id => {
      const found = handyAddons.find(a => a.id === id);
      return found ? found.name : id;
    }).filter(Boolean);

    return (
      <div key={addon.id} className="handy-addon-card">
        <div className="addon-header">
          <div className="addon-title-info">
            <h3 className="addon-title">{addon.name}</h3>
            <span className="addon-category">{addon.category}</span>
          </div>
        </div>

        <p className="addon-description">{addon.description}</p>

        {depNames.length > 0 && (
          <div className="addon-dependency">Dependencies: {depNames.join(', ')}</div>
        )}

        <div className="addon-actions">
          <button
            onClick={() => {
              if (window.electronAPI) {
                window.electronAPI.openExternal(addon.repoUrl);
              } else {
                // Fallback for web environment
                window.open(addon.repoUrl, '_blank', 'noopener,noreferrer');
              }
            }}
            className="repo-link"
            title="Open repository in browser"
          >
            View Repository
          </button>

          <button
            className={`install-btn ${installed ? 'installed' : ''}`}
            onClick={() => handleInstall(addon)}
            disabled={installed || isInstalling || loading}
          >
            {isInstalling ? 'Installing...' : (installed ? 'Installed' : 'Install')}
          </button>
        </div>
      </div>
    );
  };

  return (
    <div className="handy-addons">
    {/* refresh control moved into the filters row */}
      <div className="category-filters">
        {CATEGORIES.map(category => (
          <button
            key={category}
            className={`category-filter ${selectedCategory === category ? 'active' : ''}`}
            onClick={() => setSelectedCategory(category)}
          >
            {category}
          </button>
        ))}
        <div className="add-addon-button-wrapper">
          <button className="refresh-list-btn" onClick={fetchHandyAddons} disabled={loadingList}>
            {loadingList ? 'Refreshing…' : 'Refresh Addons'}
          </button>
          {addButton}
        </div>
      </div>

      {/* If the curated list failed to load, show a single refresh block instead of headers/empty states */}
      {listError ? (
        <div className="handy-addons-error-block">
          <h2 className="section-title">Curated Addon List Unavailable</h2>
          <div className="handy-addons-error-content">
            <p>Failed to load curated addons: {listError}</p>
            <button className="refresh-list-btn large" onClick={fetchHandyAddons} disabled={loadingList}>
              {loadingList ? 'Refreshing…' : 'Retry loading curated list'}
            </button>
          </div>
        </div>
      ) : (
        <>
          {/* Project Epoch curated section */}
          <div className="epoch-section">
            <h2 className="section-title">Project Epoch Addons</h2>
            <div className="handy-addons-grid">
              {filteredProjectEpochAddons.length > 0 ? (
                filteredProjectEpochAddons.map(addon => renderAddonCard(addon))
              ) : (
                <div className="no-addons"><p>No Project Epoch addons found for "{selectedCategory}".</p></div>
              )}
            </div>
          </div>

          {/* Other Addons section */}
          <div className="other-335-section">
            <h2 className="section-title">General Addons</h2>
            <div className="handy-addons-grid">
              {filteredOtherAddons.length > 0 ? (
                filteredOtherAddons.map(addon => renderAddonCard(addon))
              ) : (
                <div className="no-addons"><p>No General addons found for "{selectedCategory}".</p></div>
              )}
            </div>
          </div>
        </>
      )}

  {/* Note: category-specific empty states are shown per-section above */}
    </div>
  );
}

export default HandyAddons;
