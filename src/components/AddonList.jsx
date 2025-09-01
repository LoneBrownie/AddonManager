import React from 'react';
import AddonListItem from './AddonListItem';
import './AddonList.css';

function AddonList({ 
  addons, 
  onUpdateAddon, 
  onUpdateAll, 
  onCheckUpdates, 
  onCheckExistence,
  onRemoveAddon, 
  isAddonUpdating,
  loading,
  hideHeader = false,
  hideCheckUpdates = false
}) {
  const updatableAddons = addons.filter(addon => addon.needsUpdate);
  const hasUpdates = updatableAddons.length > 0;

  if (addons.length === 0) {
    return (
      <div className="addon-list">
        <div className="empty-state">
          <h2>No Addons Added Yet</h2>
          <p>Add your first addon by pasting a GitHub or GitLab repository URL.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="addon-list">
      {!hideHeader && (
        <div className="addon-list-header">
          <h2>Your Addons ({addons.length})</h2>
          <div className="addon-list-actions">
            <button
              className="button secondary"
              onClick={onCheckUpdates}
              disabled={loading}
            >
              {loading ? 'Checking...' : 'Check for Updates'}
            </button>
            
            {onCheckExistence && (
              <button
                className="button secondary"
                onClick={onCheckExistence}
                disabled={loading}
                title="Check if addon folders still exist on disk"
              >
                {loading ? 'Scanning...' : 'Scan for Missing'}
              </button>
            )}
            
            {hasUpdates && (
              <button
                className="button success"
                onClick={onUpdateAll}
                disabled={loading}
              >
                {loading ? 'Updating...' : `Update All (${updatableAddons.length})`}
              </button>
            )}
          </div>
        </div>
      )}

      {hasUpdates && (
        <div className="update-banner">
          <p>
            {updatableAddons.length} addon{updatableAddons.length !== 1 ? 's' : ''} 
            {updatableAddons.length === 1 ? ' has' : ' have'} updates available!
          </p>
        </div>
      )}

      <div className="addon-list-container">
        {addons.map(addon => (
          <AddonListItem
            key={addon.id}
            addon={addon}
            onUpdate={() => onUpdateAddon(addon.id)}
            onRemove={() => onRemoveAddon(addon.id)}
            isUpdating={isAddonUpdating ? isAddonUpdating(addon.id) : false}
            loading={loading}
          />
        ))}
      </div>
    </div>
  );
}

export default AddonList;
