import React, { useState } from 'react';
import { isValidRepoUrl } from '../services/api-client';
import './AddAddon.css';

function AddAddon({ onAddAddon, loading }) {
  const [url, setUrl] = useState('');
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
      await onAddAddon(url.trim());
      setUrl(''); // Clear input on success
    } catch (err) {
      setError(err.message || 'Failed to add addon');
    }
  };

  return (
    <div className="add-addon">
      <h2>Add New Addon</h2>
      <form onSubmit={handleSubmit}>
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
          />
          {error && <div className="error">{error}</div>}
        </div>
        
        <button 
          type="submit" 
          className="button"
          disabled={loading || !url.trim()}
        >
          {loading ? 'Adding...' : 'Add Addon'}
        </button>
      </form>
      
      <div className="help-text">
        <p><strong>Supported platforms:</strong></p>
        <ul>
          <li>GitHub (github.com)</li>
          <li>GitLab (gitlab.com)</li>
        </ul>
        <p>Make sure the repository has releases with ZIP files containing the addon.</p>
      </div>
    </div>
  );
}

export default AddAddon;
