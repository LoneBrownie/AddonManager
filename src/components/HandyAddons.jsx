import React, { useState } from 'react';
import './HandyAddons.css';

const HANDY_ADDONS = [
  {
    id: 'classicapi',
    name: 'Classic API',
    description: 'Essential API functions for Classic WoW addons compatibility.',
    repoUrl: 'https://gitlab.com/Tsoukie/classicapi',
    category: 'Core',
    epochAddon: false
  },
  {
    id: 'compactraidframe',
    name: 'Compact Raid Frames',
    description: 'Compact and customizable raid frame addon for improved raid visibility.',
    repoUrl: 'https://gitlab.com/Tsoukie/compactraidframe-3.3.5',
    category: 'Raid Frames',
  epochAddon: false,
  dependencies: ['classicapi']
  },
  {
    id: 'enhancedraidframes',
    name: 'Enhanced Raid Frames',
    description: 'Enhanced raid frames with additional features and customization options.',
    repoUrl: 'https://gitlab.com/Tsoukie/enhancedraidframes-3.3.5',
    category: 'Raid Frames',
  epochAddon: false,
  dependencies: ['classicapi', 'compactraidframe']
  },
  {
    id: 'addonlist',
    name: 'Addon List',
    description: 'Manage and organize your addons with an in-game interface.',
    repoUrl: 'https://gitlab.com/Tsoukie/addonlist-3.3.5',
    category: 'Management',
  epochAddon: false,
  dependencies: ['classicapi']
  },
  {
    id: 'clique',
    name: 'Clique',
    description: 'Click-casting addon for healers and support classes.',
    repoUrl: 'https://gitlab.com/Tsoukie/clique-3.3.5',
    category: 'Healing',
  epochAddon: false,
  dependencies: ['classicapi']
  },
  {
    id: 'compactraidframe-healex',
    name: 'Compact Raid Frame - HealEx',
    description: 'Extended healing features for Compact Raid Frames.',
    repoUrl: 'https://gitlab.com/Tsoukie/compactraidframe_healex',
    category: 'Healing',
  epochAddon: false,
  dependencies: ['classicapi', 'compactraidframe']
  },
  {
    id: 'raidframesorter',
    name: 'Raid Frame Sorter',
    description: 'Sort and organize raid frames for better group management.',
    repoUrl: 'https://gitlab.com/Tsoukie/raidframesorter-3.3.5',
    category: 'Raid Frames',
  epochAddon: false,
  dependencies: ['classicapi', 'compactraidframe']
  },
  {
    id: 'framesort',
    name: 'FrameSort',
    description: 'Sort and organize unit frames and raid frames for better group management.',
    repoUrl: 'https://gitlab.com/Tsoukie/framesort-3.3.5',
    category: 'Raid Frames',
  epochAddon: false,
  dependencies: ['classicapi', 'compactraidframe']
  },
  {
    id: 'questie-epoch',
    name: 'Questie',
    description: 'Enhanced version of Questie with improved quest tracking and database for WotLK.',
    repoUrl: 'https://github.com/esurm/Questie',
    category: 'Questing',
    customFolderName: 'Questie',
    epochAddon: true
  },
  {
    id: 'dragonui',
    name: 'DragonUI',
    description: 'Modern Dragonflight-style user interface for Classic WoW with updated visuals and functionality.',
    repoUrl: 'https://github.com/NeticSoul/DragonUI',
    category: 'Interface',
    epochAddon: false
  },
  {
    id: 'atlasloot-epoch',
    name: 'AtlasLoot Epoch',
    description: 'Complete loot browser for Classic WoW showing items, locations, and drop rates.',
    repoUrl: 'https://github.com/Raynbock/AtlaslootProjectEpoch',
    category: 'Interface',
    epochAddon: true
  },
  {
    id: 'bagnon',
    name: 'Bagnon',
    description: 'All-in-one bag replacement addon that merges all your bags into one frame.',
    repoUrl: 'https://github.com/RichSteini/Bagnon-3.3.5',
    category: 'Interface',
    epochAddon: false
  },
  {
    id: 'notplater',
    name: 'NotPlater',
    description: 'Advanced nameplate addon with extensive customization options.',
    repoUrl: 'https://github.com/RichSteini/NotPlater',
    category: 'Interface',
    customFolderName: 'NotPlater-3.3.5',
    epochAddon: false
  },
  {
    id: 'pfquest-full',
    name: 'pfQuest',
    description: 'Complete quest helper addon with database and map integration.',
    repoUrl: 'https://github.com/shagu/pfQuest/releases/latest/download/pfQuest-full-wotlk.zip',
    category: 'Questing',
    isDirectDownload: true,
    customFolderName: 'pfQuest-wotlk',
    preferredAssetName: 'pfQuest-enUS-wotlk.zip',
    epochAddon: false
  },
  {
    id: 'pfquest-epoch',
    name: 'pfQuest Epoch (Archived)',
    description: 'Enhanced version of pfQuest with additional features for modern gameplay.',
    repoUrl: 'https://github.com/Bennylavaa/pfQuest-epoch',
    category: 'Questing',
    customFolderName: 'pfQuest-epoch',
    epochAddon: true,
    dependencies: ['pfquest-full']
  },
  {
    id: 'EpochDeltaFix',
    name: 'Epoch Delta Fix',
    description: 'Replaces Epochs stat-compare with correct deltas.',
    repoUrl: 'https://github.com/dellmas/WoW-Epoch-Delta-Fix/',
    category: 'Interface',
    epochAddon: true
  },
  {
    id: 'LFG',
    name: 'Looking for Group',
    description: 'Find groups for dungeons and raids easily.',
    repoUrl: 'https://github.com/Bennylavaa/LFG',
    category: 'Interface',
    epochAddon: true
  }
];

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

  // Partition the curated list into Project Epoch addons and other 3.3.5a addons
  // Use explicit epochAddon boolean when provided, otherwise fall back to heuristics.
  const isProjectEpoch = (addon) => {
    if (typeof addon.epochAddon === 'boolean') return addon.epochAddon === true;
    return /epoch/i.test(addon.name || '') || /epoch/i.test(addon.id || '') || /epoch/i.test(addon.repoUrl || '');
  };

  const projectEpochAddons = HANDY_ADDONS.filter(isProjectEpoch);
  // Any addon not marked as Project Epoch goes into the "Other Addons" section
  const otherAddons = HANDY_ADDONS.filter(a => !isProjectEpoch(a));

  const applyCategory = (list) => selectedCategory === 'All' ? list : list.filter(addon => addon.category === selectedCategory);

  const filteredProjectEpochAddons = applyCategory(projectEpochAddons);
  const filteredOtherAddons = applyCategory(otherAddons);

  const handleInstall = async (addon) => {
    // Install dependencies first (recursively), then the addon itself.
    const visited = new Set();

    const installById = async (addonId) => {
      if (visited.has(addonId)) return; // avoid cycles / duplicate work
      visited.add(addonId);

      const depAddon = HANDY_ADDONS.find(a => a.id === addonId);
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
      const found = HANDY_ADDONS.find(a => a.id === id);
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
          <a
            href={addon.repoUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="repo-link"
          >
            View Repository
          </a>

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
        {addButton && (
          <div className="add-addon-button-wrapper">
            {addButton}
          </div>
        )}
      </div>

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

  {/* Note: category-specific empty states are shown per-section above */}
    </div>
  );
}

export default HandyAddons;
