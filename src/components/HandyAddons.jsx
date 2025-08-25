import React, { useState } from 'react';
import './HandyAddons.css';

const HANDY_ADDONS = [
  {
    id: 'classicapi',
    name: 'Classic API',
    description: 'Essential API functions for Classic WoW addons compatibility.',
    repoUrl: 'https://gitlab.com/Tsoukie/classicapi',
    category: 'Core'
  },
  {
    id: 'compactraidframe',
    name: 'Compact Raid Frames',
    description: 'Compact and customizable raid frame addon for improved raid visibility.',
    repoUrl: 'https://gitlab.com/Tsoukie/compactraidframe-3.3.5',
    category: 'Raid Frames'
  },
  {
    id: 'enhancedraidframes',
    name: 'Enhanced Raid Frames',
    description: 'Enhanced raid frames with additional features and customization options.',
    repoUrl: 'https://gitlab.com/Tsoukie/enhancedraidframes-3.3.5',
    category: 'Raid Frames'
  },
  {
    id: 'addonlist',
    name: 'Addon List',
    description: 'Manage and organize your addons with an in-game interface.',
    repoUrl: 'https://gitlab.com/Tsoukie/addonlist-3.3.5',
    category: 'Management'
  },
  {
    id: 'clique',
    name: 'Clique',
    description: 'Click-casting addon for healers and support classes.',
    repoUrl: 'https://gitlab.com/Tsoukie/clique-3.3.5',
    category: 'Healing'
  },
  {
    id: 'compactraidframe-healex',
    name: 'Compact Raid Frame - HealEx',
    description: 'Extended healing features for Compact Raid Frames.',
    repoUrl: 'https://gitlab.com/Tsoukie/compactraidframe_healex',
    category: 'Healing'
  },
  {
    id: 'raidframesorter',
    name: 'Raid Frame Sorter',
    description: 'Sort and organize raid frames for better group management.',
    repoUrl: 'https://gitlab.com/Tsoukie/raidframesorter-3.3.5',
    category: 'Raid Frames'
  },
  {
    id: 'framesort',
    name: 'FrameSort',
    description: 'Sort and organize unit frames and raid frames for better group management.',
    repoUrl: 'https://gitlab.com/Tsoukie/framesort-3.3.5',
    category: 'Raid Frames'
  },
  {
    id: 'questie-epoch',
    name: 'Questie Epoch',
    description: 'Enhanced version of Questie with improved quest tracking and database for WotLK.',
    repoUrl: 'https://github.com/esurm/Questie',
    category: 'Questing',
    customFolderName: 'Questie'
  },
  {
    id: 'dragonui',
    name: 'DragonUI',
    description: 'Modern Dragonflight-style user interface for Classic WoW with updated visuals and functionality.',
    repoUrl: 'https://github.com/NeticSoul/DragonUI',
    category: 'Interface'
  },
  {
    id: 'atlasloot-epoch',
    name: 'AtlasLoot Epoch',
    description: 'Complete loot browser for Classic WoW showing items, locations, and drop rates.',
    repoUrl: 'https://github.com/Raynbock/AtlaslootProjectEpoch',
    category: 'Interface'
  },
  {
    id: 'bagnon',
    name: 'Bagnon',
    description: 'All-in-one bag replacement addon that merges all your bags into one frame.',
    repoUrl: 'https://github.com/RichSteini/Bagnon-3.3.5',
    category: 'Interface'
  },
  {
    id: 'notplater',
    name: 'NotPlater',
    description: 'Advanced nameplate addon with extensive customization options.',
    repoUrl: 'https://github.com/RichSteini/NotPlater',
    category: 'Interface',
    customFolderName: 'NotPlater-3.3.5'
  },
  {
    id: 'pfquest-full',
    name: 'pfQuest',
    description: 'Complete quest helper addon with database and map integration.',
    repoUrl: 'https://github.com/shagu/pfQuest',
    category: 'Questing',
    isDirectDownload: true,
    customFolderName: 'pfQuest-wotlk',
    preferredAssetName: 'pfQuest-enUS-wotlk.zip'
  },
  {
    id: 'pfquest-epoch',
    name: 'pfQuest Epoch (Archived)',
    description: 'Enhanced version of pfQuest with additional features for modern gameplay.',
    repoUrl: 'https://github.com/Bennylavaa/pfQuest-epoch',
    category: 'Questing',
    customFolderName: 'pfQuest-epoch'
  },
  {
    id: 'EpochDeltaFix',
    name: 'Epoch Delta Fix',
    description: 'Replaces Epochs stat-compare with correct deltas.',
    repoUrl: 'https://github.com/dellmas/WoW-Epoch-Delta-Fix/',
    category: 'Interface'
  },
  {
    id: 'LFG',
    name: 'Looking for Group',
    description: 'Find groups for dungeons and raids easily.',
    repoUrl: 'https://github.com/Bennylavaa/LFG',
    category: 'Interface'
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
      // Check if this is a Tsoukie addon (excluding ClassicAPI itself)
      const isTsoukieAddon = addon.repoUrl.includes('gitlab.com/Tsoukie/') && addon.id !== 'classicapi';
      const classicApiAddon = HANDY_ADDONS.find(a => a.id === 'classicapi');
      const classicApiInstalled = isAddonInstalled(classicApiAddon.repoUrl);
      
      // Auto-install ClassicAPI if installing a Tsoukie addon and ClassicAPI isn't already installed
      if (isTsoukieAddon && !classicApiInstalled) {
        console.log('Installing required dependency: ClassicAPI');
        setInstalling(prev => new Set(prev).add('classicapi'));
        
        try {
          await onAddAddon(classicApiAddon.repoUrl);
          console.log('ClassicAPI dependency installed successfully');
        } catch (error) {
          console.error('Failed to install ClassicAPI dependency:', error);
          // Continue with main addon installation even if dependency fails
        } finally {
          setInstalling(prev => {
            const newSet = new Set(prev);
            newSet.delete('classicapi');
            return newSet;
          });
        }
      }
      
      // Install the main addon
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
