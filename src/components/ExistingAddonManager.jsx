import React, { useState, useEffect } from 'react';
import { getSettings } from '../services/addon-manager';
import './ExistingAddonManager.css';

const ExistingAddonManager = ({ wowPath, existingAddons: propExistingAddons, onClose, addExistingAddon, scanForExistingAddons }) => {
  const [scanning, setScanning] = useState(false);
  const [adding, setAdding] = useState(new Set());
  const [selectedAddon, setSelectedAddon] = useState(null);
  const [repoUrl, setRepoUrl] = useState('');
  const [urlError, setUrlError] = useState('');
  const [localExistingAddons, setLocalExistingAddons] = useState(propExistingAddons || []);
  const [localWowPath, setLocalWowPath] = useState(wowPath);
  const [settingsLoading, setSettingsLoading] = useState(!wowPath);
  const [allowUpdates, setAllowUpdates] = useState(false); // New state for update permission - default to false

  // No automatic scanning - rely entirely on the scan triggered by App.js
  // The existingAddons state is provided by the parent (App) so additions will update the main list

  // Load settings if wowPath is not provided
  useEffect(() => {
    const loadWowPath = async () => {
      if (wowPath) {
        setLocalWowPath(wowPath);
        setSettingsLoading(false);
        return;
      }
      
      try {
        setSettingsLoading(true);
        const settings = await getSettings();
        setLocalWowPath(settings.wowPath || null);
      } catch (error) {
        console.error('Failed to load settings:', error);
        setLocalWowPath(null);
      } finally {
        setSettingsLoading(false);
      }
    };
    
    loadWowPath();
  }, [wowPath]);

  // Update local state when props change
  useEffect(() => {
    setLocalExistingAddons(propExistingAddons || []);
  }, [propExistingAddons]);

  const handleScan = async () => {
    if (!localWowPath) return;
    
    try {
      setScanning(true);
      const scannedResults = await scanForExistingAddons();
      setLocalExistingAddons(scannedResults);
    } catch (error) {
      console.error('Failed to scan for existing addons:', error);
    } finally {
      setScanning(false);
    }
  };

  const validateUrl = (url) => {
    const githubPattern = /^https:\/\/github\.com\/[^/]+\/[^/]+\/?$/;
    const gitlabPattern = /^https:\/\/gitlab\.com\/[^/]+\/[^/]+\/?$/;
    return githubPattern.test(url) || gitlabPattern.test(url);
  };

  const handleAddRepo = async () => {
    if (!selectedAddon) return;

    if (!repoUrl.trim()) {
      setUrlError('Repository URL is required');
      return;
    }

    if (!validateUrl(repoUrl)) {
      setUrlError('Please enter a valid GitHub or GitLab repository URL');
      return;
    }

    try {
      setAdding(prev => new Set(prev).add(selectedAddon));
      setUrlError('');
      
      // Pass the entire addon object to addExistingAddon along with update permission
      await addExistingAddon(selectedAddon, repoUrl, { allowUpdates });
      
      // Reset form
      setSelectedAddon(null);
      setRepoUrl('');
      setAllowUpdates(false); // Reset to default
      
      // Refresh the scan to update the list
      await handleScan();
    } catch (error) {
      setUrlError(error.message || 'Failed to add addon');
    } finally {
      setAdding(prev => {
        const newSet = new Set(prev);
        newSet.delete(selectedAddon);
        return newSet;
      });
    }
  };

  const handleCancelAdd = () => {
    setSelectedAddon(null);
    setRepoUrl('');
    setUrlError('');
    setAllowUpdates(false); // Reset to default
  };

  const getDisplayName = (addon) => {
    // Handle both object format (from scanExistingAddons) and string format
    if (typeof addon === 'object' && addon !== null) {
      if (addon.isGrouped) {
        return `${addon.title || addon.folderName} (${addon.relatedFolders.length} folders)`;
      }
      return addon.title || addon.folderName || 'Unknown Addon';
    }
    // Fallback for string paths
    return typeof addon === 'string' ? addon.split(/[/\\]/).pop() || addon : 'Unknown Addon';
  };

  const getAddonDescription = (addon) => {
    if (typeof addon === 'object' && addon !== null) {
      if (addon.isGrouped) {
        return `Multi-folder addon: ${addon.relatedFolders.join(', ')}`;
      }
      return addon.notes || `Version: ${addon.version} | Author: ${addon.author}`;
    }
    return '';
  };

  if (settingsLoading) {
    return (
      <div style={{ 
        position: 'fixed', 
        top: 0, 
        left: 0, 
        right: 0, 
        bottom: 0, 
        backgroundColor: 'rgba(0, 0, 0, 0.7)', 
        display: 'flex', 
        alignItems: 'center', 
        justifyContent: 'center', 
        zIndex: 1000 
      }}>
        <div style={{ 
          maxWidth: '800px', 
          width: '90%', 
          padding: '20px', 
          background: '#2a2a2a', 
          borderRadius: '8px',
          position: 'relative'
        }}>
          {onClose && (
            <button
              onClick={onClose}
              style={{
                position: 'absolute',
                top: '10px',
                right: '10px',
                background: '#dc3545',
                border: 'none',
                color: '#fff',
                fontSize: '16px',
                cursor: 'pointer',
                padding: '0',
                borderRadius: '6px',
                width: '30px',
                height: '30px',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                transition: 'background-color 0.2s ease'
              }}
              title="Close"
              onMouseEnter={(e) => e.target.style.backgroundColor = '#c82333'}
              onMouseLeave={(e) => e.target.style.backgroundColor = '#dc3545'}
            >
              ×
            </button>
          )}
          
          <div style={{ 
            padding: '20px', 
            textAlign: 'center', 
            color: '#888'
          }}>
            <p>Loading settings...</p>
          </div>
        </div>
      </div>
    );
  }

  if (!localWowPath) {
    return (
      <div style={{ 
        position: 'fixed', 
        top: 0, 
        left: 0, 
        right: 0, 
        bottom: 0, 
        backgroundColor: 'rgba(0, 0, 0, 0.7)', 
        display: 'flex', 
        alignItems: 'center', 
        justifyContent: 'center', 
        zIndex: 1000 
      }}>
        <div style={{ 
          maxWidth: '800px', 
          width: '90%', 
          padding: '20px', 
          background: '#2a2a2a', 
          borderRadius: '8px',
          position: 'relative'
        }}>
          {onClose && (
            <button
              onClick={onClose}
              style={{
                position: 'absolute',
                top: '10px',
                right: '10px',
                background: '#dc3545',
                border: 'none',
                color: '#fff',
                fontSize: '16px',
                cursor: 'pointer',
                padding: '0',
                borderRadius: '6px',
                width: '30px',
                height: '30px',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                transition: 'background-color 0.2s ease'
              }}
              title="Close"
              onMouseEnter={(e) => e.target.style.backgroundColor = '#c82333'}
              onMouseLeave={(e) => e.target.style.backgroundColor = '#dc3545'}
            >
              ×
            </button>
          )}
          
          <div style={{ 
            padding: '20px', 
            textAlign: 'center', 
            color: '#888'
          }}>
            <p>Please set your WoW path in Settings to manage existing addons.</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="existing-addon-manager-overlay">
      <div className="existing-addon-manager">
        <div className="manager-header">
          <h2>Existing Addons</h2>
          <div className="manager-header-right">
            <div className="manager-header-actions">
              <button
                onClick={handleScan}
                disabled={scanning}
                className="button primary header-scan-btn"
                style={{ opacity: scanning ? 0.6 : 1 }}
              >
                {scanning ? 'Scanning...' : 'Scan Addons'}
              </button>
            </div>
            {onClose && (
              <button
                onClick={onClose}
                className="close-button"
                title="Close"
              >
                ×
              </button>
            )}
          </div>
        </div>

        <div className="manager-content">
          {/* Move scan control into header actions for inline placement with Close */}
          {/* scan control moved into header for inline placement */}

          {localExistingAddons.length === 0 ? (
            <div className="no-addons-message">
              {scanning ? 'Scanning for addons...' : 'No unmanaged addons found. Click "Scan Addons" to refresh.'}
            </div>
          ) : (
            <div>
              <div className="addons-count">
                Found {localExistingAddons.length} addon{localExistingAddons.length !== 1 ? 's' : ''} that aren't being managed:
              </div>
              
              <div className="addons-grid">
                {localExistingAddons.map((addon) => {
                  const addonKey = typeof addon === 'object' ? addon.folderPath : addon;
                  const isSelected = (selectedAddon?.folderName || selectedAddon) === (addon.folderName || addon);
                  
                  return (
                    <div 
                      key={addonKey}
                      className={`existing-addon-item ${isSelected ? 'selected' : ''}`}
                      onClick={() => {
                        // Use folderName for comparison instead of object reference
                        const addonId = addon.folderName || addon;
                        const selectedId = selectedAddon?.folderName || selectedAddon;
                        const isCurrentlySelected = selectedId === addonId;
                        
                        if (isCurrentlySelected) {
                          setSelectedAddon(null);
                          setRepoUrl('');
                          setUrlError('');
                        } else {
                          setSelectedAddon(addon);
                          setUrlError('');
                          
                          // Auto-populate with suggested repository if available
                          if (typeof addon === 'object' && addon.suggestedRepos && addon.suggestedRepos.length > 0) {
                            setRepoUrl(addon.suggestedRepos[0]);
                          } else {
                            setRepoUrl('');
                          }
                        }
                      }}
                    >
                      <div className="addon-header">
                        <div className="addon-info">
                          <h3 className="addon-title">{getDisplayName(addon)}</h3>
                          <div className="addon-description">{getAddonDescription(addon)}</div>
                        </div>
                        <div className="addon-actions">
                          {adding.has(addon) && (
                            <span className="adding-status">Adding...</span>
                          )}
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              
                              // Use folderName for comparison instead of object reference
                              const addonId = addon.folderName || addon;
                              const selectedId = selectedAddon?.folderName || selectedAddon;
                              const isCurrentlySelected = selectedId === addonId;
                              
                              if (isCurrentlySelected) {
                                setSelectedAddon(null);
                                setRepoUrl('');
                                setUrlError('');
                              } else {
                                setSelectedAddon(addon);
                                setUrlError('');
                                
                                // Auto-populate with suggested repository if available
                                if (typeof addon === 'object' && addon.suggestedRepos && addon.suggestedRepos.length > 0) {
                                  setRepoUrl(addon.suggestedRepos[0]);
                                } else {
                                  setRepoUrl('');
                                }
                              }
                            }}
                            className={`addon-select-btn ${isSelected ? 'selected' : ''}`}
                          >
                            {isSelected ? 'Cancel' : 'Add'}
                          </button>
                        </div>
                      </div>

                      {isSelected && (
                        <div className="addon-approval-section">
                          <div className="repository-input-group">
                            <label className="repository-label">
                              Repository URL:
                            </label>
                            <input
                              type="text"
                              value={repoUrl}
                              onChange={(e) => {
                                setRepoUrl(e.target.value);
                                setUrlError('');
                              }}
                              onClick={(e) => e.stopPropagation()}
                              placeholder="https://github.com/username/addon-name"
                              className={`repository-input ${urlError ? 'error' : ''}`}
                              onKeyPress={(e) => {
                                if (e.key === 'Enter') {
                                  handleAddRepo();
                                }
                              }}
                            />
                            {urlError && (
                              <div className="error-message">
                                {urlError}
                              </div>
                            )}
                          </div>
                          
                          <div className="import-options">
                            <label className="checkbox-label" onClick={(e) => e.stopPropagation()}>
                              <input
                                type="checkbox"
                                checked={allowUpdates}
                                onChange={(e) => {
                                  e.stopPropagation();
                                  setAllowUpdates(e.target.checked);
                                }}
                                onClick={(e) => e.stopPropagation()}
                                className="checkbox-input"
                              />
                              <span className="checkbox-text">Allow automatic updates for this addon</span>
                            </label>
                          </div>
                          
                          <div className="approval-actions">
                            <button
                              onClick={handleAddRepo}
                              disabled={adding.has(addon) || !repoUrl.trim()}
                              className="button primary"
                              style={{ opacity: adding.has(addon) || !repoUrl.trim() ? 0.6 : 1 }}
                            >
                              {adding.has(addon) ? 'Adding...' : 'Add Addon'}
                            </button>
                            <button
                              onClick={handleCancelAdd}
                              disabled={adding.has(addon)}
                              className="button secondary"
                              style={{ opacity: adding.has(addon) ? 0.6 : 1 }}
                            >
                              Cancel
                            </button>
                          </div>

                          {/* Show suggested repositories if available */}
                          {typeof addon === 'object' && addon.suggestedRepos && addon.suggestedRepos.length > 0 && (
                            <div className="suggestions-section">
                              <div className="suggestions-label">Suggested repositories:</div>
                              <div className="suggestions-list">
                                {addon.suggestedRepos.slice(0, 3).map((suggestion, index) => (
                                  <button
                                    key={index}
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      setRepoUrl(suggestion);
                                      setUrlError('');
                                    }}
                                    className="use-suggestion-btn"
                                  >
                                    Use: {suggestion}
                                  </button>
                                ))}
                              </div>
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default ExistingAddonManager;
