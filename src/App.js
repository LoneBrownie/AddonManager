import React, { useState } from 'react';
import AddAddonModal from './components/AddAddonModal';
import AddonList from './components/AddonList';
import HandyAddons from './components/HandyAddons';
import Settings from './components/Settings';
import ExistingAddonManager from './components/ExistingAddonManager';
import { useAddons } from './hooks/useAddons';
import logo from './img/Logo.png';
import './App.css';

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
  const [activeTab, setActiveTab] = useState('addons'); // 'addons', 'get-addons', 'settings'

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
    </div>
  );
}

export default App;
