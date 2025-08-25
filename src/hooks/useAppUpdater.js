import { useState, useEffect, useCallback } from 'react';

export function useAppUpdater() {
  const [currentVersion, setCurrentVersion] = useState('');
  const [updateStatus, setUpdateStatus] = useState('idle'); // idle, checking, available, not-available, downloading, downloaded, error
  const [updateInfo, setUpdateInfo] = useState(null);
  const [downloadProgress, setDownloadProgress] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    const getVersion = async () => {
      if (window.electronAPI) {
        try {
          const version = await window.electronAPI.getAppVersion();
          setCurrentVersion(version);
        } catch (err) {
          console.error('Failed to get app version:', err);
        }
      }
    };

    getVersion();

    // Set up update event listeners
    if (window.electronAPI) {
      const handleUpdateStatus = (event, status, info) => {
        console.log('Update status:', status, info);
        setUpdateStatus(status);
        setUpdateInfo(info || null);
        setError(null);

        if (status === 'error') {
          setError(info || 'Unknown update error');
        }
      };

      const handleUpdateProgress = (event, progress) => {
        console.log('Update progress:', progress);
        setDownloadProgress(progress);
        setUpdateStatus('downloading');
      };

      window.electronAPI.onUpdateStatus(handleUpdateStatus);
      window.electronAPI.onUpdateProgress(handleUpdateProgress);

      // Cleanup listeners on unmount
      return () => {
        if (window.electronAPI.removeUpdateListeners) {
          window.electronAPI.removeUpdateListeners();
        }
      };
    }
  }, []);

  const checkForUpdates = useCallback(async () => {
    if (!window.electronAPI) return;

    try {
      setUpdateStatus('checking');
      setError(null);
      await window.electronAPI.checkForUpdates();
    } catch (err) {
      console.error('Failed to check for updates:', err);
      setError(err.message || 'Failed to check for updates');
      setUpdateStatus('error');
    }
  }, []);

  const installUpdate = useCallback(async () => {
    if (!window.electronAPI) return;

    try {
      await window.electronAPI.installUpdate();
    } catch (err) {
      console.error('Failed to install update:', err);
      setError(err.message || 'Failed to install update');
      setUpdateStatus('error');
    }
  }, []);

  const getStatusMessage = () => {
    switch (updateStatus) {
      case 'checking':
        return 'Checking for updates...';
      case 'available':
        return `Update available: ${updateInfo?.version || 'New version'}`;
      case 'not-available':
        return 'You have the latest version';
      case 'downloading':
        const percent = downloadProgress ? Math.round(downloadProgress.percent) : 0;
        return `Downloading update... ${percent}%`;
      case 'downloaded':
        return 'Update downloaded! Application will restart automatically in a few seconds...';
      case 'error':
        return `Update error: ${error}`;
      default:
        return '';
    }
  };

  const isUpdateAvailable = updateStatus === 'available';
  const isDownloading = updateStatus === 'downloading';
  const isUpdateReady = updateStatus === 'downloaded';
  const hasError = updateStatus === 'error';

  return {
    currentVersion,
    updateStatus,
    updateInfo,
    downloadProgress,
    error,
    checkForUpdates,
    installUpdate,
    getStatusMessage,
    isUpdateAvailable,
    isDownloading,
    isUpdateReady,
    hasError
  };
}
