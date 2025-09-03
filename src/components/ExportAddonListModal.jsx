import React, { useState, useRef, useEffect } from 'react';
import './ExportAddonListModal.css';

const ExportAddonListModal = ({ addons, onClose }) => {
  const [copySuccess, setCopySuccess] = useState(false);
  const textAreaRef = useRef(null);

  // Generate the addon list text
  const addonListText = addons.length > 0 
    ? addons.map(addon => `${addon.name}: ${addon.repoUrl}`).join('\n')
    : 'No addons installed to export';

  // Select all text when modal opens
  useEffect(() => {
    if (textAreaRef.current) {
      textAreaRef.current.select();
    }
  }, []);

  const handleCopy = async () => {
    try {
      if (navigator.clipboard && window.isSecureContext) {
        // Use modern clipboard API
        await navigator.clipboard.writeText(addonListText);
      } else {
        // Fallback for older browsers or non-HTTPS contexts
        textAreaRef.current.select();
        document.execCommand('copy');
      }
      setCopySuccess(true);
      setTimeout(() => setCopySuccess(false), 2000);
    } catch (error) {
      console.error('Failed to copy text:', error);
      // Try fallback method
      try {
        textAreaRef.current.select();
        document.execCommand('copy');
        setCopySuccess(true);
        setTimeout(() => setCopySuccess(false), 2000);
      } catch (fallbackError) {
        console.error('Fallback copy also failed:', fallbackError);
      }
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

  return (
    <div className="export-modal-backdrop" onClick={handleBackdropClick}>
      <div className="export-modal">
        <div className="export-modal-header">
          <h3>Export Addon List</h3>
          <button
            className="export-modal-close"
            onClick={onClose}
            title="Close"
          >
            ×
          </button>
        </div>
        
        <div className="export-modal-content">
          <p className="export-modal-description">
            {addons.length > 0 
              ? `Your addon list (${addons.length} addons):`
              : 'No addons are currently installed.'
            }
          </p>
          
          <textarea
            ref={textAreaRef}
            className="export-modal-textarea"
            value={addonListText}
            readOnly
            rows={Math.min(addons.length + 2, 15)}
          />
        </div>
        
        <div className="export-modal-footer">
          <button
            className="button secondary"
            onClick={handleCopy}
            disabled={addons.length === 0}
          >
            {copySuccess ? 'Copied!' : 'Copy'}
          </button>
          <button
            className="button primary"
            onClick={onClose}
          >
            OK
          </button>
        </div>
      </div>
    </div>
  );
};

export default ExportAddonListModal;
