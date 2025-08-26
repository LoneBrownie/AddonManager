import React from 'react';
import './AdminRestartModal.css';

function AdminRestartModal({ onCancel, onConfirm, message }) {
  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div className="modal-content admin-restart-modal" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <h3>Requires Administrator</h3>
        </div>
        <div className="modal-body">
          <div className="info-box">
            <p>{message}</p>
            <p>Press Confirm to restart the application with elevated privileges.</p>
          </div>
        </div>
        <div className="modal-divider" />
        <div className="modal-footer">
          <button className="button secondary" onClick={onCancel}>Cancel</button>
          <button className="button primary" onClick={onConfirm}>Confirm</button>
        </div>
      </div>
    </div>
  );
}

export default AdminRestartModal;
