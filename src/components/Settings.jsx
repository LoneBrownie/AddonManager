import React, { useState, useEffect } from 'react';
import { getSettings, saveSettings } from '../services/addon-manager';
import { useAppUpdater } from '../hooks/useAppUpdater';
import './Settings.css';
import AdminRestartModal from './AdminRestartModal';

// ✅ Security: Use secure Electron API access
const electronAPI = window.electronAPI;

function Settings({ alwaysExpanded = false, hideTitle = false }) {
  const [settings, setSettings] = useState({ wowPath: '', tempPath: '' });
  const [isOpen, setIsOpen] = useState(alwaysExpanded);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [showAdminModal, setShowAdminModal] = useState(false);
  const [pendingRestartMessage, setPendingRestartMessage] = useState('');

  // App updater hook
  const {
    currentVersion,
    updateStatus,
    checkForUpdates,
    installUpdate,
    getStatusMessage,
    isUpdateAvailable,
    isDownloading,
    isUpdateReady,
    hasError
  } = useAppUpdater();

  useEffect(() => {
    const loadSettings = async () => {
      try {
        const loadedSettings = await getSettings();
        setSettings(loadedSettings);
      } catch (err) {
        console.error('Failed to load settings:', err);
        setError('Failed to load settings');
      }
    };
    
    loadSettings();
  }, []);

  useEffect(() => {
    if (alwaysExpanded) {
      setIsOpen(true);
    }
  }, [alwaysExpanded]);

  const handleWowPathSelect = async () => {
    if (!electronAPI) {
      setError('File selection not available in this environment');
      return;
    }

    try {
      const selectedPath = await electronAPI.selectDirectory();
      if (selectedPath) {
        // Verify this looks like a WoW directory
        const addonsPath = `${selectedPath}\\Interface\\AddOns`;
        const isValidWowDir = await electronAPI.checkDirectory(addonsPath);
        
        if (!isValidWowDir) {
          // Try to create the AddOns directory if Interface exists
          const interfacePath = `${selectedPath}\\Interface`;
          const hasInterface = await electronAPI.checkDirectory(interfacePath);
          
          if (!hasInterface) {
            setError('Selected directory does not appear to be a valid WoW installation. Please select the main WoW folder.');
            return;
          }
        }

  const newSettings = { ...settings, wowPath: selectedPath };
  setSettings(newSettings);
  await saveSettings(newSettings);
  setSuccess('WoW path updated successfully!');
        setError('');
        
        // Clear success message after 3 seconds
        setTimeout(() => setSuccess(''), 3000);
      }
    } catch (err) {
      setError('Failed to select directory: ' + err.message);
    }
  };

  const handlePathChange = (e) => {
    const newPath = e.target.value;
    const newSettings = { ...settings, wowPath: newPath };
    setSettings(newSettings);
    setError('');
    setSuccess('');
  };

  const handleSave = async () => {
    if (!settings.wowPath.trim()) {
      setError('Please select a WoW installation directory');
      return;
    }

    try {
      await saveSettings(settings);

      // If path is inside Program Files, prompt for admin restart
      const lowerPath = settings.wowPath.toLowerCase();
      if (lowerPath.includes('program files')) {
        const msg = 'The selected WoW directory is under Program Files. Installing addons may require administrator rights.';
        setPendingRestartMessage(msg);
        setShowAdminModal(true);
      }

      setSuccess('Settings saved successfully!');
      setError('');
      
      // Clear success message after 3 seconds
      setTimeout(() => setSuccess(''), 3000);
    } catch (err) {
      setError('Failed to save settings: ' + err.message);
    }
  };

  const handleAdminConfirm = async () => {
    setShowAdminModal(false);
    // Call into the secure electron API to restart elevated
    if (electronAPI && electronAPI.restartAsAdmin) {
      try {
        await electronAPI.restartAsAdmin();
      } catch (e) {
        setError('Failed to restart as admin: ' + (e && e.message ? e.message : String(e)));
      }
    } else {
      // Fallback: inform user
      setError('Restart-as-admin is not available in this environment. Please restart the app as Administrator manually.');
    }
  };

  const handleAdminCancel = () => {
    setShowAdminModal(false);
  };

  const getAddonsPath = () => {
    if (!settings.wowPath) return '';
    return `${settings.wowPath}\\Interface\\AddOns`;
  };

  return (
    <div className="settings">
      {!alwaysExpanded && (
        <div className="settings-header">
          <button 
            className="settings-toggle"
            onClick={() => setIsOpen(!isOpen)}
          >
            ⚙️ Settings {isOpen ? '▼' : '▶'}
          </button>
        </div>
      )}

      {isOpen && (
        <div className="settings-content">
          <div className="settings-section">
            <div className="form-group">
              <label htmlFor="wow-path">WoW Installation Directory</label>
            <div className="path-input-group">
              <input
                id="wow-path"
                type="text"
                className="input"
                value={settings.wowPath}
                onChange={handlePathChange}
                placeholder="C:\Program Files (x86)\World of Warcraft"
              />
              {electronAPI && (
                <button 
                  className="button secondary"
                  onClick={handleWowPathSelect}
                >
                  Browse
                </button>
              )}
            </div>
            
            {settings.wowPath && (
              <div className="path-info">
                <p><strong>Addons will be installed to:</strong></p>
                <code>{getAddonsPath()}</code>
              </div>
            )}
          </div>

          {error && <div className="error">{error}</div>}
          {success && <div className="success">{success}</div>}

            <div className="settings-actions">
              <button 
                className="button"
                onClick={handleSave}
              >
                Save Settings
              </button>
            </div>
          </div>

          <div className="settings-help">
            <h4>Help</h4>
            <ul>
              <li>Select your main World of Warcraft installation folder</li>
              <li>This should be the folder containing "WoW.exe" or "World of Warcraft.exe"</li>
              <li>Common locations:
                <ul>
                  <li><code>C:\Program Files (x86)\World of Warcraft</code></li>
                  <li><code>C:\Games\World of Warcraft</code></li>
                </ul>
              </li>
              <li>Addons will be installed to the "Interface\AddOns" subfolder</li>
              <li style={{ color: 'red' }}>Warning: If your World of Warcraft installation is in Program Files you will need to run this application as Admin.</li>
            </ul>
          </div>
          <div className="app-update-section">
            <h4>Application Updates</h4>
            <div className="version-info">
              <div className="current-version">
                <span className="version-label">Current Version:</span>
                <span className="version-number">{currentVersion || 'Loading...'}</span>
              </div>
              
              <div className="update-status">
                {getStatusMessage() && (
                  <div className={`update-message ${hasError ? 'error' : ''} ${isUpdateAvailable ? 'available' : ''}`}>
                    {getStatusMessage()}
                  </div>
                )}
              </div>
              
              <div className="update-actions">
                <button
                  className="button secondary"
                  onClick={checkForUpdates}
                  disabled={isDownloading || updateStatus === 'checking'}
                >
                  {updateStatus === 'checking' ? 'Checking...' : 'Check for Updates'}
                </button>
                
                {isUpdateAvailable && (
                  <button
                    className="button success"
                    onClick={installUpdate}
                    disabled={isDownloading}
                  >
                    Download & Install Update
                  </button>
                )}
                
                {isUpdateReady && (
                  <div className="restart-notice">
                    ⚠️ Application will restart automatically to complete the update
                  </div>
                )}
              </div>
            </div>
            
            <div className="update-info">
              <p><strong>Note:</strong> The application automatically checks for updates every 6 hours.</p>
              <p>When an update is available, it will download automatically in the background.</p>
              <p>The application will restart automatically to install updates.</p>
            </div>
          </div>
          {showAdminModal && (
            <AdminRestartModal
              message={pendingRestartMessage}
              onCancel={handleAdminCancel}
              onConfirm={handleAdminConfirm}
            />
          )}
        </div>
      )}
    </div>
  );
}

export default Settings;
