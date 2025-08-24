import React from 'react';
import './AddonListItem.css';

function AddonListItem({ addon, onUpdate, onRemove, loading }) {
  const formatDate = (dateString) => {
    if (!dateString) return 'Unknown';
    try {
      return new Date(dateString).toLocaleDateString();
    } catch {
      return 'Unknown';
    }
  };

  const getRepoDisplayName = (url) => {
    try {
      const urlObj = new URL(url);
      const pathParts = urlObj.pathname.split('/').filter(part => part);
      if (pathParts.length >= 2) {
        return `${pathParts[0]}/${pathParts[1]}`;
      }
    } catch {
      // fallback
    }
    return url;
  };

  const openRepoUrl = () => {
    // ✅ Security: Use secure Electron API for opening external links
    if (window.electronAPI) {
      window.electronAPI.openExternal(addon.repoUrl);
    } else {
      // Fallback for web environment
      window.open(addon.repoUrl, '_blank', 'noopener,noreferrer');
    }
  };

  return (
    <div className={`addon-list-item ${addon.needsUpdate ? 'needs-update' : ''}`}>
      <div className="addon-main-info">
        <div className="addon-name-section">
          <h3 className="addon-name" title={addon.name}>
            {addon.name}
          </h3>
          {addon.needsUpdate && (
            <span className="update-badge">Update Available</span>
          )}
        </div>
        
        <button 
          className="repo-link"
          onClick={openRepoUrl}
          title="Open repository in browser"
        >
          {getRepoDisplayName(addon.repoUrl)}
        </button>
      </div>

      <div className="addon-version-info">
        <div className="version-section">
          <span className="version-label">Current:</span>
          <span className="version current">
            {addon.currentVersion}
            {addon.source && (
              <span className={`source-badge ${addon.source}`}>
                {addon.source === 'release' ? '📦' : '🔧'}
              </span>
            )}
          </span>
        </div>
        
        {addon.needsUpdate && (
          <div className="version-section">
            <span className="version-label">Latest:</span>
            <span className="version latest">
              {addon.latestVersion}
              {addon.latestSource && (
                <span className={`source-badge ${addon.latestSource}`}>
                  {addon.latestSource === 'release' ? '📦' : '🔧'}
                </span>
              )}
            </span>
          </div>
        )}
      </div>

      <div className="addon-meta-info">
        <span className="last-updated">Updated: {formatDate(addon.lastUpdated)}</span>
        {addon.source === 'branch' && (
          <span className="branch-info">Branch: {addon.branch || 'main'}</span>
        )}
        {addon.installedFolders && addon.installedFolders.length > 0 && (
          <span className="folder-count" title={`Managed folders: ${addon.installedFolders.join(', ')}`}>
            {addon.installedFolders.length > 3 
              ? `${addon.installedFolders.length} folders (${addon.installedFolders.slice(0, 2).join(', ')}, ...)`
              : `${addon.installedFolders.length} folder${addon.installedFolders.length !== 1 ? 's' : ''}`
            }
          </span>
        )}
      </div>

      <div className="addon-actions">
        {addon.needsUpdate && (
          <button
            className="button success small"
            onClick={onUpdate}
            disabled={loading}
          >
            {loading ? 'Updating...' : 'Update'}
          </button>
        )}
        
        <button
          className="button danger small"
          onClick={onRemove}
          disabled={loading}
          title="Remove addon and delete all files"
        >
          Remove
        </button>
      </div>
    </div>
  );
}

export default AddonListItem;
