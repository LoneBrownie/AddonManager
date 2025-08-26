import React, { useState, useEffect } from 'react';

const ExistingAddonManager = ({ wowPath, existingAddons: propExistingAddons, onClose, addExistingAddon, scanForExistingAddons }) => {
  const [scanning, setScanning] = useState(false);
  const [adding, setAdding] = useState(new Set());
  const [selectedAddon, setSelectedAddon] = useState(null);
  const [repoUrl, setRepoUrl] = useState('');
  const [urlError, setUrlError] = useState('');
  const [localExistingAddons, setLocalExistingAddons] = useState(propExistingAddons || []);

  // No automatic scanning - rely entirely on the scan triggered by App.js
  // The existingAddons state is provided by the parent (App) so additions will update the main list

  // Update local state when props change
  useEffect(() => {
    setLocalExistingAddons(propExistingAddons || []);
  }, [propExistingAddons]);

  const handleScan = async () => {
    if (!wowPath) return;
    
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
      
      // Pass the entire addon object to addExistingAddon
      await addExistingAddon(selectedAddon, repoUrl);
      
      // Reset form
      setSelectedAddon(null);
      setRepoUrl('');
      
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

  if (!wowPath) {
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
        maxHeight: '80vh', 
        overflow: 'auto', 
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

        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px', marginTop: '10px', paddingRight: '40px' }}>
          <h3 style={{ margin: 0, color: '#fff' }}>Existing Addons</h3>
          <button
            onClick={handleScan}
            disabled={scanning}
            style={{
              padding: '8px 16px',
              background: '#007acc',
              color: 'white',
              border: 'none',
              borderRadius: '4px',
              cursor: scanning ? 'not-allowed' : 'pointer',
              opacity: scanning ? 0.6 : 1
            }}
          >
            {scanning ? 'Scanning...' : 'Scan Addons'}
          </button>
        </div>

        {localExistingAddons.length === 0 ? (
          <p style={{ color: '#888', textAlign: 'center', padding: '20px' }}>
            {scanning ? 'Scanning for addons...' : 'No unmanaged addons found. Click "Scan Addons" to refresh.'}
          </p>
        ) : (
          <div>
            <p style={{ color: '#ccc', marginBottom: '15px' }}>
              Found {localExistingAddons.length} addon{localExistingAddons.length !== 1 ? 's' : ''} that aren't being managed:
            </p>
            
            <div style={{ display: 'grid', gap: '10px' }}>
              {localExistingAddons.map((addon) => {
                const addonKey = typeof addon === 'object' ? addon.folderPath : addon;
                return (
                  <div 
                    key={addonKey}
                    style={{
                      padding: '12px',
                      background: (selectedAddon?.folderName || selectedAddon) === (addon.folderName || addon) ? '#404040' : '#333',
                      borderRadius: '6px',
                      border: (selectedAddon?.folderName || selectedAddon) === (addon.folderName || addon) ? '2px solid #007acc' : '2px solid transparent',
                      cursor: 'pointer',
                      transition: 'all 0.2s ease'
                    }}
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
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <div style={{ flex: 1 }}>
                      <span style={{ color: '#fff', fontWeight: '500', display: 'block' }}>
                        {getDisplayName(addon)}
                      </span>
                      <span style={{ color: '#888', fontSize: '12px', display: 'block', marginTop: '2px' }}>
                        {getAddonDescription(addon)}
                      </span>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                      {adding.has(addon) && (
                        <span style={{ color: '#007acc', fontSize: '14px' }}>Adding...</span>
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
                        style={{
                          padding: '4px 8px',
                          background: (selectedAddon?.folderName || selectedAddon) === (addon.folderName || addon) ? '#dc3545' : '#007acc',
                          color: 'white',
                          border: 'none',
                          borderRadius: '3px',
                          cursor: 'pointer',
                          fontSize: '12px'
                        }}
                      >
                        {(selectedAddon?.folderName || selectedAddon) === (addon.folderName || addon) ? 'Cancel' : 'Add'}
                      </button>
                    </div>
                  </div>

                  {(selectedAddon?.folderName || selectedAddon) === (addon.folderName || addon) && (
                    <div style={{ marginTop: '12px', paddingTop: '12px', borderTop: '1px solid #555' }}>
                      <div style={{ marginBottom: '10px' }}>
                        <label style={{ display: 'block', color: '#ccc', marginBottom: '5px', fontSize: '14px' }}>
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
                          style={{
                            width: '100%',
                            padding: '8px',
                            border: urlError ? '1px solid #dc3545' : '1px solid #555',
                            borderRadius: '4px',
                            background: '#1a1a1a',
                            color: '#fff',
                            fontSize: '14px',
                            boxSizing: 'border-box'
                          }}
                          onKeyPress={(e) => {
                            if (e.key === 'Enter') {
                              handleAddRepo();
                            }
                          }}
                        />
                        {urlError && (
                          <div style={{ color: '#dc3545', fontSize: '12px', marginTop: '5px' }}>
                            {urlError}
                          </div>
                        )}
                      </div>
                      
                      <div style={{ display: 'flex', gap: '8px' }}>
                        <button
                          onClick={handleAddRepo}
                          disabled={adding.has(addon) || !repoUrl.trim()}
                          style={{
                            padding: '6px 12px',
                            background: adding.has(addon) || !repoUrl.trim() ? '#555' : '#28a745',
                            color: 'white',
                            border: 'none',
                            borderRadius: '4px',
                            cursor: adding.has(addon) || !repoUrl.trim() ? 'not-allowed' : 'pointer',
                            fontSize: '14px'
                          }}
                        >
                          {adding.has(addon) ? 'Adding...' : 'Add Addon'}
                        </button>
                        <button
                          onClick={handleCancelAdd}
                          disabled={adding.has(addon)}
                          style={{
                            padding: '6px 12px',
                            background: '#6c757d',
                            color: 'white',
                            border: 'none',
                            borderRadius: '4px',
                            cursor: adding.has(addon) ? 'not-allowed' : 'pointer',
                            fontSize: '14px'
                          }}
                        >
                          Cancel
                        </button>
                      </div>
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
  );
};

export default ExistingAddonManager;
