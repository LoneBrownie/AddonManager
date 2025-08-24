import React, { useState } from 'react';
import './ExistingAddonManager.css';

function ExistingAddonManager({ scanExisting, onAddExisting, onClose, loading }) {
  const [existingAddons, setExistingAddons] = useState([]);
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState(null);
  const [selectedAddon, setSelectedAddon] = useState(null);
  const [customRepoUrl, setCustomRepoUrl] = useState('');

  const handleScan = async () => {
    setScanning(true);
    setError(null);
    
    try {
      const unmanaged = await scanExisting();
      setExistingAddons(unmanaged);
      
      if (unmanaged.length === 0) {
        setError('No unmanaged addons found or all existing addons are already managed.');
      }
    } catch (err) {
      setError(err.message || 'Failed to scan existing addons');
    } finally {
      setScanning(false);
    }
  };

  const handleSelectAddon = (addon) => {
    setSelectedAddon(addon);
    setCustomRepoUrl('');
    setError(null);
  };

  const handleAddWithRepo = async (repoUrl) => {
    if (!selectedAddon || !repoUrl.trim()) {
      setError('Please select an addon and provide a repository URL');
      return;
    }

    try {
      await onAddExisting(selectedAddon, repoUrl.trim());
      // Remove the added addon from the list
      setExistingAddons(prev => prev.filter(a => a !== selectedAddon));
      setSelectedAddon(null);
      setCustomRepoUrl('');
    } catch (err) {
      setError(err.message || 'Failed to add addon');
    }
  };

  const formatDate = (date) => {
    if (!date) return 'Unknown';
    try {
      return new Date(date).toLocaleDateString();
    } catch {
      return 'Unknown';
    }
  };

  return (
    <div className="existing-addon-manager-overlay">
      <div className="existing-addon-manager">
        <div className="manager-header">
          <h2>Manage Existing Addons</h2>
          <button className="close-button" onClick={onClose} disabled={loading}>
            ×
          </button>
        </div>

        <div className="manager-content">
          {existingAddons.length === 0 && !scanning && (
            <div className="scan-section">
              <p>Scan your WoW AddOns directory to find existing addons that can be managed by this application.</p>
              <button 
                className="button primary"
                onClick={handleScan}
                disabled={scanning}
              >
                {scanning ? 'Scanning...' : 'Scan for Existing Addons'}
              </button>
            </div>
          )}

          {error && (
            <div className="error-message">
              {error}
            </div>
          )}

          {existingAddons.length > 0 && (
            <div className="existing-addons-list">
              <h3>Found {existingAddons.length} unmanaged addon{existingAddons.length !== 1 ? 's' : ''}</h3>
              
              <div className="addons-grid">
                {existingAddons.map((addon, index) => (
                  <div 
                    key={index} 
                    className={`existing-addon-item ${selectedAddon === addon ? 'selected' : ''}`}
                    onClick={() => handleSelectAddon(addon)}
                  >
                    <div className="addon-info">
                      <h4 className="addon-title">{addon.title}</h4>
                      <div className="addon-details">
                        <span className="version">v{addon.version}</span>
                        {addon.author && addon.author !== 'Unknown' && (
                          <span className="author">by {addon.author}</span>
                        )}
                      </div>
                      <div className="addon-meta">
                        <span className="folder-name">Folder: {addon.folderName}</span>
                        <span className="last-modified">Modified: {formatDate(addon.lastModified)}</span>
                      </div>
                      
                      {addon.suggestedRepos && addon.suggestedRepos.length > 0 && (
                        <div className="suggested-repos">
                          <strong>Suggested repositories:</strong>
                          {addon.suggestedRepos.map((url, urlIndex) => (
                            <div
                              key={urlIndex}
                              className="repo-suggestion"
                              onClick={(e) => {
                                e.stopPropagation();
                                setSelectedAddon(addon);
                                setCustomRepoUrl(url);
                              }}
                            >
                              <span className="repo-url">{url}</span>
                              <button className="use-suggestion-btn">Use This</button>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                ))}
              </div>

              {selectedAddon && (
                <div className="addon-approval-section">
                  <h3>Add "{selectedAddon.title}" to management</h3>
                  <p>Please provide or confirm the GitHub/GitLab repository URL for this addon:</p>
                  
                  <div className="repo-input-section">
                    <input
                      type="url"
                      placeholder="https://github.com/username/repository"
                      value={customRepoUrl}
                      onChange={(e) => setCustomRepoUrl(e.target.value)}
                      className="repo-url-input"
                    />
                    <button
                      className="button success"
                      onClick={() => handleAddWithRepo(customRepoUrl)}
                      disabled={loading || !customRepoUrl.trim()}
                    >
                      {loading ? 'Adding...' : 'Add to Management'}
                    </button>
                  </div>

                  <div className="approval-actions">
                    <button
                      className="button secondary"
                      onClick={() => setSelectedAddon(null)}
                      disabled={loading}
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}

              <div className="rescan-section">
                <button 
                  className="button secondary"
                  onClick={handleScan}
                  disabled={scanning}
                >
                  {scanning ? 'Rescanning...' : 'Rescan Directory'}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default ExistingAddonManager;
