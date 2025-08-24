import React, { useState } from 'react';
import './HandyAddons.css';

const HANDY_ADDONS = [
  {
    id: 'classicapi',
    name: '!!!ClassicAPI',
    description: 'Essential API functions for Classic WoW addons compatibility.',
    repoUrl: 'https://gitlab.com/Tsoukie/classicapi',
    category: 'Core',
    icon: '⚙️'
  },
  {
    id: 'compactraidframe',
    name: 'Compact Raid Frames',
    description: 'Compact and customizable raid frame addon for improved raid visibility.',
    repoUrl: 'https://gitlab.com/Tsoukie/compactraidframe-3.3.5',
    category: 'Raid Frames',
    icon: '🖼️'
  },
  {
    id: 'enhancedraidframes',
    name: 'Enhanced Raid Frames',
    description: 'Enhanced raid frames with additional features and customization options.',
    repoUrl: 'https://gitlab.com/Tsoukie/enhancedraidframes-3.3.5',
    category: 'Raid Frames',
    icon: '�'
  },
  {
    id: 'addonlist',
    name: 'Addon List',
    description: 'Manage and organize your addons with an in-game interface.',
    repoUrl: 'https://gitlab.com/Tsoukie/addonlist-3.3.5',
    category: 'Management',
    icon: '�'
  },
  {
    id: 'clique',
    name: 'Clique',
    description: 'Click-casting addon for healers and support classes.',
    repoUrl: 'https://gitlab.com/Tsoukie/clique-3.3.5',
    category: 'Healing',
    icon: '�️'
  },
  {
    id: 'compactraidframe-healex',
    name: 'Compact Raid Frame HealEx',
    description: 'Extended healing features for Compact Raid Frames.',
    repoUrl: 'https://gitlab.com/Tsoukie/compactraidframe_healex',
    category: 'Healing',
    icon: '�'
  },
  {
    id: 'raidframesorter',
    name: 'Raid Frame Sorter',
    description: 'Sort and organize raid frames for better group management.',
    repoUrl: 'https://gitlab.com/Tsoukie/raidframesorter-3.3.5',
    category: 'Raid Frames',
    icon: '🔄'
  },
  {
    id: 'pfquest-full',
    name: 'pfQuest (Full)',
    description: 'Complete quest helper addon with database and map integration.',
    repoUrl: 'https://github.com/shagu/pfQuest/releases/latest/download/pfQuest-full-wotlk.zip',
    category: 'Questing',
    icon: '🗺️',
    isDirectDownload: true,
    customFolderName: 'pfQuest-wotlk'
  },
  {
    id: 'pfquest-epoch',
    name: 'pfQuest Epoch (deprecated)',
    description: 'Enhanced version of pfQuest with additional features for modern gameplay.',
    repoUrl: 'https://github.com/Bennylavaa/pfQuest-epoch',
    category: 'Questing',
    icon: '⏰',
    customFolderName: 'pfQuest-epoch',
    preferredAssetName: 'pfQuest-enUS-wotlk.zip'
  },
  {
    id: 'questie-epoch',
    name: 'Questie Epoch',
    description: 'Enhanced version of Questie with improved quest tracking and database for WotLK.',
    repoUrl: 'https://github.com/esurm/Questie-Epoch',
    category: 'Questing',
    icon: '❓',
    customFolderName: 'Questie-335'
  },
  {
    id: 'dragonflightui',
    name: 'DragonflightUI',
    description: 'Modern Dragonflight-style user interface for Classic WoW with updated visuals and functionality.',
    repoUrl: 'https://github.com/TheLinuxITGuy/Chromie-Dragonflight',
    category: 'Interface',
    icon: '🐉'
  },
  {
    id: 'atlasloot-epoch',
    name: 'AtlasLoot Epoch',
    description: 'Complete loot browser for Classic WoW showing items, locations, and drop rates.',
    repoUrl: 'https://github.com/Raynbock/AtlaslootProjectEpoch',
    category: 'Interface',
    icon: '💰'
  },
  {
    id: 'bagnon',
    name: 'Bagnon',
    description: 'All-in-one bag replacement addon that merges all your bags into one frame.',
    repoUrl: 'https://github.com/RichSteini/Bagnon-3.3.5',
    category: 'Interface',
    icon: '🎒'
  },
  {
    id: 'notplater',
    name: 'NotPlater',
    description: 'Advanced nameplate addon with extensive customization options.',
    repoUrl: 'https://github.com/RichSteini/NotPlater',
    category: 'Interface',
    icon: '📋',
    customFolderName: 'NotPlater-3.3.5'
  },
  {
    id: 'framesort',
    name: 'FrameSort',
    description: 'Sort and organize unit frames and raid frames for better group management.',
    repoUrl: 'https://gitlab.com/Tsoukie/framesort-3.3.5',
    category: 'Raid Frames',
    icon: '📋'
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

  const filteredAddons = selectedCategory === 'All' 
    ? HANDY_ADDONS 
    : HANDY_ADDONS.filter(addon => addon.category === selectedCategory);

  const handleInstall = async (addon) => {
    setInstalling(prev => new Set(prev).add(addon.id));
    
    try {
      // Handle special addon installation cases
      if (addon.customFolderName || addon.isDirectDownload || addon.preferredAssetName) {
        await onAddAddon(addon.repoUrl, {
          customFolderName: addon.customFolderName,
          isDirectDownload: addon.isDirectDownload,
          preferredAssetName: addon.preferredAssetName
        });
      } else {
        await onAddAddon(addon.repoUrl);
      }
    } catch (error) {
      console.error('Failed to install addon:', error);
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

      <div className="handy-addons-grid">
        {filteredAddons.map(addon => {
          const installed = isAddonInstalled(addon.repoUrl);
          const isInstalling = isAddonInstalling(addon.id);
          
          return (
            <div key={addon.id} className="handy-addon-card">
              <div className="addon-header">
                <div className="addon-title-info">
                  <h3 className="addon-title">{addon.name}</h3>
                  <span className="addon-category">{addon.category}</span>
                </div>
              </div>
              
              <p className="addon-description">{addon.description}</p>
              
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
        })}
      </div>

      {filteredAddons.length === 0 && (
        <div className="no-addons">
          <p>No addons found in the "{selectedCategory}" category.</p>
        </div>
      )}
    </div>
  );
}

export default HandyAddons;
