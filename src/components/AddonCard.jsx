import React from 'react';
import './AddonCard.css';
import { sanitizeTocTitle } from '../services/addon-manager';

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

  const displayName = addon.tocData && addon.tocData.title ? addon.tocData.title : addon.name;

  return (
    <div className={`addon-card ${addon.needsUpdate && addon.allowUpdates !== false ? 'needs-update' : ''} ${addon.exists === false ? 'missing' : ''}`}>
      {addon.exists === false && (
        <div className="missing-warning">
          <span className="warning-icon">⚠️</span>
          <span className="warning-text">
            {addon.missingFolders && addon.missingFolders.length > 0 
              ? `Missing folders: ${addon.missingFolders.join(', ')}`
              : 'Addon files not found in AddOns directory'
            }
          </span>
        </div>
      )}
      
      <div className="addon-card-header">
        <h3 className="addon-name" title={displayName}>
          {sanitizeTocTitle(displayName) || addon.name}
        </h3>
        {addon.needsUpdate && addon.allowUpdates !== false && (
          <span className="update-badge">Update Available</span>
        )}
        {addon.importedExisting && (
          <span className="imported-badge" title="Imported from existing WoW installation">Imported</span>
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
          </span>
        </div>
        
        {addon.needsUpdate && addon.allowUpdates !== false && (
          <div className="info-row">
            <span className="label">Latest Version:</span>
            <span className="version latest">
              {addon.latestVersion}
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
            <span className="folders" title={addon.installedFolders.join(', ')}>
              {addon.installedFolders.length > 3 
                ? `${addon.installedFolders.length} folders (${addon.installedFolders.slice(0, 2).join(', ')}, ...)`
                : addon.installedFolders.join(', ')
              }
            </span>
          </div>
        )}
      </div>

      <div className="addon-actions">
        {addon.exists === false && (
          <button
            className="button warning"
            onClick={onUpdate}
            disabled={loading}
            title="Reinstall missing addon"
          >
            {loading ? 'Reinstalling...' : 'Reinstall'}
          </button>
        )}
        
        {addon.needsUpdate && addon.exists !== false && addon.allowUpdates !== false && (
          <button
            className="button success"
            onClick={onUpdate}
            disabled={loading}
            title={addon.importedExisting ? "Force update (downloads new version)" : "Update to latest version"}
          >
            {loading ? 'Updating...' : (addon.importedExisting ? 'Force Update' : 'Update')}
          </button>
        )}
        
        {addon.needsUpdate && addon.exists !== false && addon.allowUpdates === false && (
          <div className="update-disabled-notice">
            Updates disabled for this addon
          </div>
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
