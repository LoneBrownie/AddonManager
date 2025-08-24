import React from 'react';
import './AddonCard.css';

function AddonCard({ addon, onUpdate, onRemove, loading }) {
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
    <div className={`addon-card ${addon.needsUpdate ? 'needs-update' : ''}`}>
      <div className="addon-card-header">
        <h3 className="addon-name" title={addon.name}>
          {addon.name}
        </h3>
        {addon.needsUpdate && (
          <span className="update-badge">Update Available</span>
        )}
      </div>

      <div className="addon-info">
        <div className="info-row">
          <span className="label">Repository:</span>
          <button 
            className="repo-link"
            onClick={openRepoUrl}
            title="Open repository in browser"
          >
            {getRepoDisplayName(addon.repoUrl)}
          </button>
        </div>
        
        <div className="info-row">
          <span className="label">Current Version:</span>
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
          <div className="info-row">
            <span className="label">Latest Version:</span>
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
        
        {addon.source === 'branch' && (
          <div className="info-row">
            <span className="label">Branch:</span>
            <span className="branch">{addon.branch || 'main'}</span>
          </div>
        )}
        
        <div className="info-row">
          <span className="label">Last Updated:</span>
          <span className="date">{formatDate(addon.lastUpdated)}</span>
        </div>

        {addon.tocData && (
          <>
            {addon.tocData.author && addon.tocData.author !== 'Unknown' && (
              <div className="info-row">
                <span className="label">Author:</span>
                <span className="author">{addon.tocData.author}</span>
              </div>
            )}
            
            {addon.tocData.interface && addon.tocData.interface !== 'Unknown' && (
              <div className="info-row">
                <span className="label">Interface:</span>
                <span className="interface">{addon.tocData.interface}</span>
              </div>
            )}
          </>
        )}

        {addon.installedFolders && addon.installedFolders.length > 0 && (
          <div className="info-row">
            <span className="label">Folders:</span>
            <span className="folders">{addon.installedFolders.join(', ')}</span>
          </div>
        )}
      </div>

      <div className="addon-actions">
        {addon.needsUpdate && (
          <button
            className="button success"
            onClick={onUpdate}
            disabled={loading}
          >
            {loading ? 'Updating...' : 'Update'}
          </button>
        )}
        
        <button
          className="button danger"
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

export default AddonCard;
