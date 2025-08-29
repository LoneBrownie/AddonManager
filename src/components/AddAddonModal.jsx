import React, { useState } from 'react';
import { isValidRepoUrl } from '../services/api-client';
import './AddAddonModal.css';

function AddAddonModal({ onClose, onAddAddon, loading }) {
  const [url, setUrl] = useState('');
  const [folderName, setFolderName] = useState('');
  const [error, setError] = useState('');

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');

    if (!url.trim()) {
      setError('Please enter a repository URL');
      return;
    }

    if (!isValidRepoUrl(url.trim())) {
      setError('Please enter a valid GitHub or GitLab repository URL');
      return;
    }

    try {
      const options = {};
      if (folderName && folderName.trim()) {
        options.customFolderName = folderName.trim();
      }

      await onAddAddon(url.trim(), options);
      setUrl(''); // Clear input on success
      setFolderName('');
      onClose(); // Close modal on success
    } catch (err) {
      setError(err.message || 'Failed to add addon');
    }
  };

  const handleOverlayClick = (e) => {
    if (e.target === e.currentTarget) {
      onClose();
    }
  };

  return (
    <div className="modal-overlay" onClick={handleOverlayClick}>
      <div className="modal-content add-addon-modal">
        <div className="modal-header">
          <h2>Add New Addon</h2>
          <button className="close-button" onClick={onClose}>
            ×
          </button>
        </div>
        
        <form onSubmit={handleSubmit} className="modal-body">
          <div className="form-group">
            <label htmlFor="repo-url">Repository URL</label>
            <input
              id="repo-url"
              type="url"
              className="input"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://github.com/user/addon-name"
              disabled={loading}
              autoFocus
            />
            {error && <div className="error">{error}</div>}
          </div>

          <div className="form-group">
            <label htmlFor="folder-name">Folder name (optional)</label>
            <input
              id="folder-name"
              type="text"
              className="input"
              value={folderName}
              onChange={(e) => setFolderName(e.target.value)}
              placeholder="Addon folder name to use when installing (optional)"
              disabled={loading}
            />
            <div className="help-text-small">If provided, this name will be used for the installed addon folder. Leave empty to use the addon's default name.</div>
          </div>
          
          <div className="help-text">
            <p><strong>Supported platforms:</strong></p>
            <ul>
              <li>GitHub (github.com)</li>
              <li>GitLab (gitlab.com)</li>
            </ul>
            <p>Make sure the repository has releases with ZIP files containing the addon.</p>
          </div>
          
          <div className="modal-footer">
            <button 
              type="button" 
              className="button secondary" 
              onClick={onClose}
              disabled={loading}
            >
              Cancel
            </button>
            <button 
              type="submit" 
              className="button primary"
              disabled={loading || !url.trim()}
            >
              {loading ? 'Adding...' : 'Add Addon'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

export default AddAddonModal;
