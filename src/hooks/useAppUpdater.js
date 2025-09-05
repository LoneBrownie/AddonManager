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
      // Track a pending error timeout so we can debounce short-lived 'error' statuses
      let pendingErrorTimer = null;

      const handleUpdateStatus = (event, status, info) => {
        console.log('Update status:', status, info);

        // If we receive any non-error status, clear any pending error timer
        if (pendingErrorTimer) {
          clearTimeout(pendingErrorTimer);
          pendingErrorTimer = null;
        }

        // Immediately update status and info for non-error events
        if (status !== 'error') {
          setUpdateStatus(status);
          setUpdateInfo(info || null);
          setError(null);
          return;
        }

        // For 'error' status, debounce briefly to avoid flashing transient errors
        // that may be followed immediately by an 'available' or 'download-progress' event.
        pendingErrorTimer = setTimeout(() => {
          setUpdateStatus('error');
          setUpdateInfo(info || null);
          setError(info || 'Unknown update error');
          pendingErrorTimer = null;
        }, 800);
      };

      const handleUpdateProgress = (event, progress) => {
        console.log('Update progress:', progress);
        setDownloadProgress(progress);
        setUpdateStatus('downloading');
      };

      window.electronAPI.onUpdateStatus(handleUpdateStatus);
      window.electronAPI.onUpdateProgress(handleUpdateProgress);

      // Cleanup listeners and any pending timer on unmount
      return () => {
        if (window.electronAPI.removeUpdateListeners) {
          window.electronAPI.removeUpdateListeners();
        }
        // Clear any pending error timer
        try {
          if (typeof pendingErrorTimer === 'number') {
            clearTimeout(pendingErrorTimer);
          }
        } catch (e) {
          // ignore
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
