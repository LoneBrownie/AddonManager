import React, { useState, useRef, useEffect } from 'react';
import './ImportAddonListModal.css';

const ImportAddonListModal = ({ onImport, onClose, loading }) => {
  const [importText, setImportText] = useState('');
  const [parsedAddons, setParsedAddons] = useState([]);
  const [selectedAddons, setSelectedAddons] = useState(new Set());
  const [validationErrors, setValidationErrors] = useState([]);
  const textAreaRef = useRef(null);

  // Parse the addon list text
  useEffect(() => {
    const parseAddonList = () => {
      if (!importText.trim()) {
        setParsedAddons([]);
        setValidationErrors([]);
        setSelectedAddons(new Set());
        return;
      }

      const lines = importText.split('\n').filter(line => line.trim());
      const addons = [];
      const errors = [];

      lines.forEach((line, index) => {
        const trimmedLine = line.trim();
        if (!trimmedLine) return;

        // Expected format: "AddonName: https://github.com/user/repo"
        // Handle addon names that contain colons by looking for the last ": http" pattern
        let colonIndex = -1;
        const httpPattern = /:\s*https?:\/\//;
        const match = trimmedLine.match(httpPattern);
        
        if (match) {
          colonIndex = match.index;
        } else {
          // Fallback to finding the last colon if no http pattern found
          colonIndex = trimmedLine.lastIndexOf(':');
        }
        
        if (colonIndex === -1) {
          errors.push(`Line ${index + 1}: Missing colon separator`);
          return;
        }

        let name = trimmedLine.substring(0, colonIndex).trim();
        const url = trimmedLine.substring(colonIndex + 1).trim();

        if (!name) {
          errors.push(`Line ${index + 1}: Missing addon name`);
          return;
        }

        if (!url) {
          errors.push(`Line ${index + 1}: Missing repository URL`);
          return;
        }

        // Basic URL validation
        try {
          const urlObj = new URL(url);
          if (!['github.com', 'gitlab.com'].some(domain => urlObj.hostname.includes(domain))) {
            errors.push(`Line ${index + 1}: URL must be from GitHub or GitLab`);
            return;
          }
        } catch (e) {
          errors.push(`Line ${index + 1}: Invalid URL format`);
          return;
        }

        addons.push({
          name: name,
          repoUrl: url,
          lineNumber: index + 1
        });
      });

      setParsedAddons(addons);
      setValidationErrors(errors);
      // Auto-select all valid addons
      setSelectedAddons(new Set(addons.map((_, index) => index)));
    };

    parseAddonList();
  }, [importText]);

  const handlePaste = async () => {
    try {
      if (navigator.clipboard && window.isSecureContext) {
        const text = await navigator.clipboard.readText();
        setImportText(text);
      }
    } catch (error) {
      console.error('Failed to read clipboard:', error);
    }
  };

  const handleImport = async () => {
    const addonsToImport = parsedAddons.filter((_, index) => selectedAddons.has(index));
    if (addonsToImport.length === 0) return;

    await onImport(addonsToImport);
  };

  const toggleAddonSelection = (index) => {
    const newSelected = new Set(selectedAddons);
    if (newSelected.has(index)) {
      newSelected.delete(index);
    } else {
      newSelected.add(index);
    }
    setSelectedAddons(newSelected);
  };

  const toggleSelectAll = () => {
    if (selectedAddons.size === parsedAddons.length) {
      setSelectedAddons(new Set());
    } else {
      setSelectedAddons(new Set(parsedAddons.map((_, index) => index)));
    }
  };

  const handleBackdropClick = (e) => {
    if (e.target === e.currentTarget) {
      onClose();
    }
  };

  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  const canImport = parsedAddons.length > 0 && selectedAddons.size > 0 && !loading;

  return (
    <div className="import-modal-backdrop" onClick={handleBackdropClick}>
      <div className="import-modal">
        <div className="import-modal-header">
          <h3>Import Addon List</h3>
          <button
            className="import-modal-close"
            onClick={onClose}
            title="Close"
          >
            ×
          </button>
        </div>
        
        <div className="import-modal-content">
          <div className="import-section">
            <div className="import-section-header">
              <label htmlFor="import-textarea">Paste Addon List:</label>
              <button
                className="button secondary small"
                onClick={handlePaste}
                title="Paste from clipboard"
              >
                Paste
              </button>
            </div>
            <textarea
              id="import-textarea"
              ref={textAreaRef}
              className="import-modal-textarea"
              value={importText}
              onChange={(e) => setImportText(e.target.value)}
              placeholder="Paste your addon list here...&#10;Expected format:&#10;AddonName: https://github.com/user/repo&#10;AnotherAddon: https://gitlab.com/user/repo"
              rows={8}
            />
          </div>

          {validationErrors.length > 0 && (
            <div className="import-errors">
              <h4>Validation Errors:</h4>
              <ul>
                {validationErrors.map((error, index) => (
                  <li key={index} className="error-item">{error}</li>
                ))}
              </ul>
            </div>
          )}

          {parsedAddons.length > 0 && (
            <div className="import-preview">
              <div className="import-preview-header">
                <h4>Found {parsedAddons.length} addon{parsedAddons.length !== 1 ? 's' : ''}:</h4>
                <button
                  className="button secondary small"
                  onClick={toggleSelectAll}
                >
                  {selectedAddons.size === parsedAddons.length ? 'Deselect All' : 'Select All'}
                </button>
              </div>
              <div className="import-preview-list">
                {parsedAddons.map((addon, index) => (
                  <div
                    key={index}
                    className={`import-addon-item ${selectedAddons.has(index) ? 'selected' : ''}`}
                    onClick={() => toggleAddonSelection(index)}
                  >
                    <input
                      type="checkbox"
                      checked={selectedAddons.has(index)}
                      onChange={() => toggleAddonSelection(index)}
                    />
                    <div className="import-addon-info">
                      <div className="import-addon-name">{addon.name}</div>
                      <div className="import-addon-url">{addon.repoUrl}</div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
        
        <div className="import-modal-footer">
          <button
            className="button secondary"
            onClick={onClose}
            disabled={loading}
          >
            Cancel
          </button>
          <button
            className="button primary"
            onClick={handleImport}
            disabled={!canImport}
          >
            {loading ? 'Importing...' : `Import ${selectedAddons.size} Addon${selectedAddons.size !== 1 ? 's' : ''}`}
          </button>
        </div>
      </div>
    </div>
  );
};

export default ImportAddonListModal;
