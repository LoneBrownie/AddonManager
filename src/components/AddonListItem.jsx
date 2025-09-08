import React, { useState } from 'react';
import './AddonListItem.css';
import { sanitizeTocTitle } from '../services/addon-manager';
import ConfirmModal from './ConfirmModal';

function AddonListItem({ addon, onUpdate, onRemove, onToggleUpdatePermission, onSetDownloadPriority, isUpdating, loading }) {
  const [showConfirmDelete, setShowConfirmDelete] = useState(false);
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

  // Context menu for per-addon download priority
  const handleContextMenu = (e) => {
    e.preventDefault();
    // Build a simple custom menu using browser prompt as fallback
    // Prefer building a native menu in Electron; here we use a simple confirm prompt sequence
    if (window.electronAPI && window.electronAPI.showContextMenu) {
      // If the preload exposes a native menu helper, use it and pass checked state
      const items = [
        { label: 'Prefer Releases', id: 'releases', checked: (addon.downloadPriority || 'releases') === 'releases' },
        { label: 'Prefer Latest Code', id: 'code', checked: (addon.downloadPriority || 'releases') === 'code' }
      ];

      window.electronAPI.showContextMenu(items).then(choice => {
        if (choice && onSetDownloadPriority) onSetDownloadPriority(addon.id, choice);
      }).catch(() => {});
    } else {
      // Web fallback: prompt user
      const choice = window.prompt('Download preference for this addon (releases|code):', addon.downloadPriority || 'releases');
      if (choice && onSetDownloadPriority) {
        const normalized = choice.trim() === 'code' ? 'code' : 'releases';
        onSetDownloadPriority(addon.id, normalized);
      }
    }
  };

  const displayName = addon.tocData && addon.tocData.title ? addon.tocData.title : addon.name;

  return (
  <div className={`addon-list-item ${addon.needsUpdate ? 'needs-update' : ''}`} onContextMenu={handleContextMenu}>
      <div className="addon-main-info">
        <div className="addon-name-section">
          <h3 className="addon-name" title={sanitizeTocTitle(displayName) || addon.name}>
            {sanitizeTocTitle(displayName) || addon.name}
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
          </span>
        </div>
        
        {addon.needsUpdate && (
          <div className="version-section">
            <span className="version-label">Latest:</span>
            <span className="version latest">
              {addon.latestVersion}
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
        {addon.needsUpdate && addon.allowUpdates && (
          <button
            className="button success small"
            onClick={onUpdate}
            disabled={isUpdating || loading}
          >
            {isUpdating ? 'Updating...' : 'Update'}
          </button>
        )}
        
        <div className="update-toggle-container">
          <span className="toggle-label">Allow Updates</span>
          <label className="toggle-switch">
            <input
              type="checkbox"
              checked={addon.allowUpdates}
              onChange={() => onToggleUpdatePermission(addon.id)}
              disabled={loading}
            />
            <span className="slider"></span>
          </label>
        </div>
        
        <button
          className="button danger small"
          onClick={() => setShowConfirmDelete(true)}
          disabled={loading}
          title="Remove addon and delete all files"
        >
          Delete
        </button>
        {showConfirmDelete && (
          <ConfirmModal
            title={`Delete ${addon.name}?`}
            message={`This will permanently delete ${addon.name} from disk and remove it from the manager. Are you sure?`}
            onCancel={() => setShowConfirmDelete(false)}
            onConfirm={() => { setShowConfirmDelete(false); onRemove(); }}
          />
        )}
      </div>
    </div>
  );
}

export default AddonListItem;
