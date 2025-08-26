import React, { useState, useEffect } from 'react';
import AddAddonModal from './components/AddAddonModal';
import AdminRestartModal from './components/AdminRestartModal';
import AddonList from './components/AddonList';
import HandyAddons from './components/HandyAddons';
import Settings from './components/Settings';
import ExistingAddonManager from './components/ExistingAddonManager';
import { useAddons } from './hooks/useAddons';
import { getSettings } from './services/addon-manager';
import logo from './img/Logo.png';
import './App.css';

// ✅ Security: Use secure Electron API access
const electronAPI = window.electronAPI;

function App() {
  const {
    addons,
    addAddon,
    updateAddon,
    updateAllAddons,
    checkForUpdates,
    removeAddon,
    scanForExistingAddons,
    existingAddons,
    wowPath,
    loading,
    error
  } = useAddons();

  const [showExistingManager, setShowExistingManager] = useState(false);
  const [showAddAddonModal, setShowAddAddonModal] = useState(false);
  const [showAdminModal, setShowAdminModal] = useState(false);
  const [adminRestartMessage, setAdminRestartMessage] = useState('');
  const [activeTab, setActiveTab] = useState('addons'); // 'addons', 'get-addons', 'settings'

  // Check for admin requirements on startup
  useEffect(() => {
    const checkAdminRequirements = async () => {
      try {
        const settings = await getSettings();
        if (settings.wowPath) {
          const lowerPath = settings.wowPath.toLowerCase();
          if (lowerPath.includes('program files')) {
            // Check if we're already running as admin
            if (electronAPI && electronAPI.isElevated) {
              const isElevated = await electronAPI.isElevated();
              if (!isElevated) {
                const msg = 'Your WoW installation is in Program Files. Administrator privileges are required to install addons.';
                setAdminRestartMessage(msg);
                setShowAdminModal(true);
              }
            } else {
              // If we can't check elevation status, assume we need admin
              const msg = 'Your WoW installation is in Program Files. Administrator privileges may be required to install addons.';
              setAdminRestartMessage(msg);
              setShowAdminModal(true);
            }
          }
        }
      } catch (error) {
        console.error('Failed to check admin requirements:', error);
      }
    };

    checkAdminRequirements();
  }, []);

  const handleAdminConfirm = async () => {
    setShowAdminModal(false);
    // Call into the secure electron API to restart elevated
    if (electronAPI && electronAPI.restartAsAdmin) {
      try {
        await electronAPI.restartAsAdmin();
      } catch (e) {
        console.error('Failed to restart as admin:', e);
        // Show error but don't block the app
      }
    } else {
      console.warn('Restart-as-admin is not available in this environment.');
    }
  };

  const handleAdminCancel = () => {
    setShowAdminModal(false);
  };

  const handleManageExistingAddons = async () => {
    try {
      // Trigger a fresh scan before showing the manager
      await scanForExistingAddons();
      setShowExistingManager(true);
    } catch (error) {
      console.error('Failed to scan for existing addons:', error);
      // Still show the manager even if scan fails
      setShowExistingManager(true);
    }
  };

  const renderTabContent = () => {
    switch (activeTab) {
      case 'addons':
        return (
          <div className="page-content">
            <div className="page-header">
              <div className="page-header-content">
                <div className="page-header-text">
                  <h2>My Addons</h2>
                  <p>View and manage your installed World of Warcraft addons. Check for updates, remove unwanted addons, or manage existing addon folders.</p>
                </div>
              </div>
            </div>
            
            <div className="addon-list-divider"></div>
            
            <div className="addon-list-toolbar">
              <div className="addon-counter">
                <span className="addon-count">{addons.length}</span>
                <span className="addon-count-label">addons installed</span>
              </div>
              <div className="addon-list-actions">
                <button
                  className="button secondary"
                  onClick={handleManageExistingAddons}
                  disabled={loading}
                >
                  Manage Existing Addons
                </button>
                <button
                  className="button primary"
                  onClick={checkForUpdates}
                  disabled={loading}
                >
                  {loading ? 'Checking...' : 'Check for Updates'}
                </button>
              </div>
            </div>
            
            <AddonList 
              addons={addons}
              onUpdateAddon={updateAddon}
              onUpdateAll={updateAllAddons}
              onCheckUpdates={checkForUpdates}
              onRemoveAddon={removeAddon}
              loading={loading}
              hideHeader={true}
              hideCheckUpdates={true}
            />
          </div>
        );
      case 'get-addons':
        return (
          <div className="page-content">
            <div className="page-header">
              <div className="page-header-content">
                <div className="page-header-text">
                  <h2>Get Addons</h2>
                  <p>Add new addons to your collection. Enter a GitHub or GitLab repository URL, or choose from our curated 3.3.5a Addons</p>
                </div>
              </div>
            </div>
            
            <div className="addon-list-divider"></div>
            
            <div className="handy-addons-section">
              <HandyAddons 
                onAddAddon={addAddon}
                installedAddons={addons}
                loading={loading}
                addButton={
                  <button
                    className="button primary"
                    onClick={() => setShowAddAddonModal(true)}
                    disabled={loading}
                  >
                    Add New Addon
                  </button>
                }
              />
            </div>
          </div>
        );
      case 'settings':
        return (
          <div className="page-content">
            <div className="page-header">
              <div className="page-header-content">
                <div className="page-header-text">
                  <h2>Settings</h2>
                  <p>Configure your World of Warcraft installation path and other application preferences.</p>
                </div>
              </div>
            </div>
            
            <div className="addon-list-divider"></div>
            
            <Settings alwaysExpanded={true} hideTitle={true} />
          </div>
        );
      default:
        return null;
    }
  };

  return (
    <div className="app">
      <div className="app-sidebar">
        <div className="app-title">
          <img src={logo} alt="Brownie's Addon Manager" className="app-logo" />
          <p>Manage your World of Warcraft addons</p>
        </div>
        
        <nav className="sidebar-navigation">
          <button
            className={`nav-button ${activeTab === 'addons' ? 'active' : ''}`}
            onClick={() => setActiveTab('addons')}
          >
            <span className="nav-text">My Addons</span>
          </button>
          <button
            className={`nav-button ${activeTab === 'get-addons' ? 'active' : ''}`}
            onClick={() => setActiveTab('get-addons')}
          >
            <span className="nav-text">Get Addons</span>
          </button>
          <button
            className={`nav-button ${activeTab === 'settings' ? 'active' : ''}`}
            onClick={() => setActiveTab('settings')}
          >
            <span className="nav-text">Settings</span>
          </button>
        </nav>
      </div>
      
      <main className="app-main">
        {error && (
          <div className="error-banner">
            <p>{error}</p>
          </div>
        )}
        
        <div className="main-content">
          {renderTabContent()}
        </div>
      </main>

      {showExistingManager && (
        <ExistingAddonManager
          wowPath={wowPath}
          existingAddons={existingAddons}
          onClose={() => setShowExistingManager(false)}
        />
      )}

      {showAddAddonModal && (
        <AddAddonModal
          onClose={() => setShowAddAddonModal(false)}
          onAddAddon={addAddon}
          loading={loading}
        />
      )}

      {showAdminModal && (
        <AdminRestartModal
          message={adminRestartMessage}
          onCancel={handleAdminCancel}
          onConfirm={handleAdminConfirm}
        />
      )}
    </div>
  );
}

export default App;
