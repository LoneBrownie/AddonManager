import React, { useState } from 'react';
import AddAddon from './components/AddAddon';
import AddonList from './components/AddonList';
import HandyAddons from './components/HandyAddons';
import Settings from './components/Settings';
import ExistingAddonManager from './components/ExistingAddonManager';
import { useAddons } from './hooks/useAddons';
import './App.css';

function App() {
  const {
    addons,
    addAddon,
    updateAddon,
    updateAllAddons,
    checkForUpdates,
    removeAddon,
    scanExisting,
    addExistingAddonToManagement,
    loading,
    error
  } = useAddons();

  const [showExistingManager, setShowExistingManager] = useState(false);
  const [activeTab, setActiveTab] = useState('addons'); // 'addons', 'handy', 'settings'

  const renderTabContent = () => {
    switch (activeTab) {
      case 'addons':
        return (
          <>
            <div className="sidebar-content">
              <AddAddon onAddAddon={addAddon} loading={loading} />
              
              <div className="existing-addons-section">
                <button
                  className="button secondary full-width"
                  onClick={() => setShowExistingManager(true)}
                  disabled={loading}
                >
                  Manage Existing Addons
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
            />
          </>
        );
      case 'handy':
        return (
          <HandyAddons 
            onAddAddon={addAddon}
            installedAddons={addons}
            loading={loading}
          />
        );
      case 'settings':
        return <Settings alwaysExpanded={true} />;
      default:
        return null;
    }
  };

  return (
    <div className="app">
      <header className="app-header">
        <h1>WoW Addon Manager</h1>
        <p>Manage your World of Warcraft addons from GitHub and GitLab</p>
        
        <nav className="tab-navigation">
          <button
            className={`tab-button ${activeTab === 'addons' ? 'active' : ''}`}
            onClick={() => setActiveTab('addons')}
          >
            My Addons ({addons.length})
          </button>
          <button
            className={`tab-button ${activeTab === 'handy' ? 'active' : ''}`}
            onClick={() => setActiveTab('handy')}
          >
            Handy Addons
          </button>
          <button
            className={`tab-button ${activeTab === 'settings' ? 'active' : ''}`}
            onClick={() => setActiveTab('settings')}
          >
            Settings
          </button>
        </nav>
      </header>
      
      <main className="main-content">
        {error && (
          <div className="error-banner">
            <p>{error}</p>
          </div>
        )}
        
        <div className="tab-content">
          {renderTabContent()}
        </div>
      </main>

      {showExistingManager && (
        <ExistingAddonManager
          scanExisting={scanExisting}
          onAddExisting={addExistingAddonToManagement}
          onClose={() => setShowExistingManager(false)}
          loading={loading}
        />
      )}
    </div>
  );
}

export default App;
