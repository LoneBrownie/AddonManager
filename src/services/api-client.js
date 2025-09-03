/**
 * API client for GitHub and GitLab repositories
 */

/**
 * Parse repository information from a URL
 * @param {string} url - GitHub or GitLab repository URL
 * @returns {Object} - { platform, owner, repo, apiUrl }
 */
export function parseRepoFromUrl(url) {
  try {
    const urlObj = new URL(url);
    const hostname = urlObj.hostname.toLowerCase();
    const pathParts = urlObj.pathname.split('/').filter(part => part);

    if (hostname === 'github.com' && pathParts.length >= 2) {
      return {
        platform: 'github',
        owner: pathParts[0],
        repo: pathParts[1],
        apiUrl: `https://api.github.com/repos/${pathParts[0]}/${pathParts[1]}`
      };
    }

    if (hostname === 'gitlab.com' && pathParts.length >= 2) {
      const projectId = encodeURIComponent(`${pathParts[0]}/${pathParts[1]}`);
      return {
        platform: 'gitlab',
        owner: pathParts[0],
        repo: pathParts[1],
        projectId,
        apiUrl: `https://gitlab.com/api/v4/projects/${projectId}`
      };
    }

    throw new Error('Unsupported repository URL. Only GitHub and GitLab are supported.');
  } catch (error) {
    throw new Error('Invalid repository URL');
  }
}

/**
 * Validate if URL is a valid GitHub or GitLab repository URL
 * @param {string} url - URL to validate
 * @returns {boolean}
 */
export function isValidRepoUrl(url) {
  try {
    parseRepoFromUrl(url);
    return true;
  } catch {
    return false;
  }
}

// Simple in-memory cache to avoid repeated network calls during a session
const latestCache = new Map();

function cacheSet(key, value, ttlMs = 1000 * 60 * 10) {
  const expires = Date.now() + ttlMs;
  latestCache.set(key, { value, expires });
}

function cacheGet(key) {
  const entry = latestCache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expires) {
    latestCache.delete(key);
    return null;
  }
  return entry.value;
}

/**
 * Web scraping fallback using Electron main process to avoid CSP violations
 * @param {Object} repoInfo - Repository information from parseRepoFromUrl
 * @returns {Promise<Object>} - Release/tag information
 */
async function getGitHubWebFallback(repoInfo) {
  try {
    // Use Electron main process to bypass CSP
    if (window?.electronAPI?.fetchReleaseWeb) {
      const repoUrl = `https://github.com/${repoInfo.owner}/${repoInfo.repo}`;
      console.log(`Trying web fallback for ${repoUrl}`);
      const result = await window.electronAPI.fetchReleaseWeb(repoUrl);
      console.log(`Web fallback result for ${repoInfo.owner}/${repoInfo.repo}:`, result);
      
      if (result && result.version && result.downloadUrl) {
        return {
          version: result.version,
          name: result.version,
          downloadUrl: result.downloadUrl,
          publishedAt: new Date().toISOString(),
          size: null,
          source: result.source || 'web-electron'
        };
      } else {
        console.warn(`Web fallback returned invalid result for ${repoInfo.owner}/${repoInfo.repo}:`, result);
      }
    }
    
    // If web scraping fails, try code fallback
    console.log(`Web scraping failed, trying code fallback for ${repoInfo.owner}/${repoInfo.repo}`);
    return await getGitHubCodeFallback(repoInfo);
  } catch (error) {
    console.error(`GitHub web fallback failed for ${repoInfo.owner}/${repoInfo.repo}:`, error.message);
    // Try code fallback on error
    return await getGitHubCodeFallback(repoInfo);
  }
}

/**
 * Code fallback - download latest code from default branch
 * @param {Object} repoInfo - Repository information from parseRepoFromUrl
 * @returns {Promise<Object>} - Code download information
 */
async function getGitHubCodeFallback(repoInfo) {
  try {
    console.log(`Trying code fallback for ${repoInfo.owner}/${repoInfo.repo}`);
    
    // Get repository information to find default branch
    const repoResponse = await fetch(repoInfo.apiUrl);
    
    if (!repoResponse.ok) {
      throw new Error(`GitHub API error: ${repoResponse.status}`);
    }
    
    const repoData = await repoResponse.json();
    const defaultBranch = repoData.default_branch || 'main';
    
    console.log(`Found default branch: ${defaultBranch} for ${repoInfo.owner}/${repoInfo.repo}`);
    
    // Get the latest commit to use as version
    const commitsResponse = await fetch(`${repoInfo.apiUrl}/commits/${defaultBranch}`);
    
    if (!commitsResponse.ok) {
      throw new Error(`Failed to get latest commit: ${commitsResponse.status}`);
    }
    
    const commitData = await commitsResponse.json();
    const shortSha = commitData.sha.substring(0, 7);
    const commitDate = new Date(commitData.commit.author.date).toISOString().split('T')[0];
    
    console.log(`✓ Latest commit for ${repoInfo.owner}/${repoInfo.repo}: ${shortSha} on ${commitDate}`);
    
    return {
      version: `${commitDate}-${shortSha}`,
      name: `Latest code (${shortSha})`,
      downloadUrl: `https://github.com/${repoInfo.owner}/${repoInfo.repo}/archive/${defaultBranch}.zip`,
      publishedAt: commitData.commit.author.date,
      size: null, // Unknown size for archive
      source: 'branch',
      branch: defaultBranch,
      commit: commitData.sha
    };
    
  } catch (error) {
    console.error(`GitHub code fallback failed for ${repoInfo.owner}/${repoInfo.repo}:`, error.message);
    
    // If API calls fail, fall back to the simple branch approach
    console.log(`Falling back to simple branch detection for ${repoInfo.owner}/${repoInfo.repo}`);
    
    // Try common default branches in order of preference
    const defaultBranches = ['main', 'master', 'develop'];
    
    for (const branch of defaultBranches) {
      const downloadUrl = `https://codeload.github.com/${repoInfo.owner}/${repoInfo.repo}/zip/refs/heads/${branch}`;
      
      console.log(`Attempting ${branch} branch for ${repoInfo.owner}/${repoInfo.repo}`);
      
      // Test the download URL by attempting a download
      try {
        if (window?.electronAPI?.downloadFile) {
          // Test download to a temporary location to validate the branch exists
          const tempTestPath = `temp-test-${Date.now()}.zip`;
          await window.electronAPI.downloadFile(downloadUrl, tempTestPath);
          
          // If we get here, the download worked - clean up and return this branch
          try {
            await window.electronAPI.deleteFile(tempTestPath);
          } catch (cleanupError) {
            console.warn('Failed to clean up test file:', cleanupError);
          }
          
          console.log(`✓ Successfully validated ${branch} branch for ${repoInfo.owner}/${repoInfo.repo}`);
          return {
            version: branch,
            name: `${branch} branch`,
            downloadUrl: downloadUrl,
            publishedAt: new Date().toISOString(),
            size: null,
            source: 'code-branch',
            branch: branch
          };
        } else {
          // No download API available, just return the first branch
          console.log(`No validation available, using ${branch} branch for ${repoInfo.owner}/${repoInfo.repo}`);
          return {
            version: branch,
            name: `${branch} branch`,
            downloadUrl: downloadUrl,
            publishedAt: new Date().toISOString(),
            size: null,
            source: 'code-branch',
            branch: branch
          };
        }
      } catch (downloadError) {
        console.log(`✗ ${branch} branch test failed for ${repoInfo.owner}/${repoInfo.repo}:`, downloadError.message);
        continue;
      }
    }
    
    // If no branches worked, throw an error
    throw new Error(`No accessible branches found for ${repoInfo.owner}/${repoInfo.repo}`);
  }
}

/**
 * Get the latest release from GitHub
 * @param {Object} repoInfo - Repository information from parseRepoFromUrl
 * @param {string} preferredAssetName - Optional preferred asset name to download
 * @returns {Promise<Object>} - Release information
 */
async function getGitHubLatestRelease(repoInfo, preferredAssetName = null) {
  let response;
  try {
    response = await fetch(`${repoInfo.apiUrl}/releases/latest`);
  } catch (fetchErr) {
    // Network or CORS error when calling API from renderer - use Electron API fallback
    console.debug('GitHub releases/latest fetch failed, trying Electron API fallback', fetchErr);
    return await getGitHubWebFallback(repoInfo);
  }

  if (!response.ok) {
    if (response.status === 404) {
      // No releases found, try web fallback
      console.log('No releases found, falling back to web methods');
      return await getGitHubWebFallback(repoInfo);
    }

    // Handle rate limiting / forbidden - try web fallback
    if (response.status === 403) {
      console.warn('GitHub API returned 403; attempting web fallback to avoid failure');
      return await getGitHubWebFallback(repoInfo);
    }

    throw new Error(`GitHub API error: ${response.status}`);
  }
  
  const release = await response.json();
  
  // Find the preferred asset or the first ZIP asset
  let zipAsset;
  if (preferredAssetName) {
    zipAsset = release.assets.find(asset => 
      asset.name.toLowerCase() === preferredAssetName.toLowerCase()
    );
  }
  
  if (!zipAsset) {
    // Fall back to first ZIP asset
    zipAsset = release.assets.find(asset => 
      asset.name.toLowerCase().endsWith('.zip')
    );
  }
  
  if (!zipAsset) {
    // No ZIP asset in release - check if GitHub provides a zipball for the release
    if (release.zipball_url) {
      // Prefer codeload.github.com URL which is a public redirectable binary download
      const tag = release.tag_name || release.name;
      const codeloadUrl = `https://codeload.github.com/${repoInfo.owner}/${repoInfo.repo}/zip/${tag}`;
      return {
        version: release.tag_name,
        name: release.name || release.tag_name,
        downloadUrl: codeloadUrl,
        publishedAt: release.published_at,
        size: null,
        source: 'release-zipball-codeload'
      };
    }

    // No ZIP asset or zipball - try to fall back to web scraping
    console.log('No ZIP asset in release, falling back to web methods');
    return await getGitHubWebFallback(repoInfo);
  }
  
  return {
    version: release.tag_name,
    name: release.name || release.tag_name,
    downloadUrl: zipAsset.browser_download_url,
    publishedAt: release.published_at,
    size: zipAsset.size,
    source: 'release'
  };
}

/**
 * Get the latest release from GitLab
 * @param {Object} repoInfo - Repository information from parseRepoFromUrl
 * @returns {Promise<Object>} - Release information
 */
async function getGitLabLatestRelease(repoInfo) {
  const cacheKey = `gitlab:release:${repoInfo.owner}/${repoInfo.repo}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  try {
    const response = await fetch(`${repoInfo.apiUrl}/releases`);
    
    if (!response.ok) {
      if (response.status === 403) {
        // Rate limited - try web fallback using Electron API
        console.warn('GitLab API returned 403; attempting web fallback');
        return await getGitLabWebFallback(repoInfo);
      }
      throw new Error(`GitLab API error: ${response.status}`);
    }
    
    const releases = await response.json();
    
    if (!releases || releases.length === 0) {
      // No releases, try web fallback
      return await getGitLabWebFallback(repoInfo);
    }
    
    const latestRelease = releases[0];
    
    // Find ZIP asset in release links
    let zipAsset = latestRelease.assets?.links?.find(link => 
      link.name.toLowerCase().endsWith('.zip') || 
      link.link_type === 'package'
    );
    
    let downloadUrl;
    if (zipAsset) {
      downloadUrl = zipAsset.url;
    } else {
      // Generate archive URL
      downloadUrl = `https://gitlab.com/${repoInfo.owner}/${repoInfo.repo}/-/archive/${latestRelease.tag_name}/${repoInfo.repo}-${latestRelease.tag_name}.zip`;
    }
    
    const result = {
      version: latestRelease.tag_name,
      name: latestRelease.name || latestRelease.tag_name,
      downloadUrl: downloadUrl,
      publishedAt: latestRelease.created_at,
      size: zipAsset?.size || null,
      source: 'release'
    };
    
    cacheSet(cacheKey, result);
    return result;
  } catch (error) {
    console.error('GitLab releases API error:', error.message);
    return await getGitLabWebFallback(repoInfo);
  }
}

/**
 * GitLab web fallback using Electron main process
 * @param {Object} repoInfo - Repository information
 * @returns {Promise<Object>} - Release information
 */
async function getGitLabWebFallback(repoInfo) {
  try {
    // Use Electron main process to bypass CSP
    if (window?.electronAPI?.fetchReleaseWeb) {
      const repoUrl = `https://gitlab.com/${repoInfo.owner}/${repoInfo.repo}`;
      const result = await window.electronAPI.fetchReleaseWeb(repoUrl);
      
      if (result && result.version && result.downloadUrl) {
        return {
          version: result.version,
          name: result.version,
          downloadUrl: result.downloadUrl,
          publishedAt: new Date().toISOString(),
          size: null,
          source: result.source || 'web-electron'
        };
      }
    }
    
    // If web scraping fails, try code fallback
    console.log(`GitLab web scraping failed, trying code fallback for ${repoInfo.owner}/${repoInfo.repo}`);
    return await getGitLabCodeFallback(repoInfo);
  } catch (error) {
    console.error(`GitLab web fallback failed for ${repoInfo.owner}/${repoInfo.repo}:`, error.message);
    // Try code fallback on error
    return await getGitLabCodeFallback(repoInfo);
  }
}

/**
 * GitLab code fallback - download latest code from default branch
 * @param {Object} repoInfo - Repository information
 * @returns {Promise<Object>} - Code download information
 */
async function getGitLabCodeFallback(repoInfo) {
  try {
    console.log(`Trying GitLab code fallback for ${repoInfo.owner}/${repoInfo.repo}`);
    
    // Try common default branches
    const defaultBranches = ['main', 'master', 'develop'];
    
    for (const branch of defaultBranches) {
      try {
        const downloadUrl = `https://gitlab.com/${repoInfo.owner}/${repoInfo.repo}/-/archive/${branch}/${repoInfo.repo}-${branch}.zip`;
        
        console.log(`Using ${branch} branch for GitLab ${repoInfo.owner}/${repoInfo.repo}`);
        return {
          version: branch,
          name: `${branch} branch`,
          downloadUrl: downloadUrl,
          publishedAt: new Date().toISOString(),
          size: null,
          source: 'code-branch'
        };
      } catch (branchError) {
        console.debug(`GitLab branch ${branch} test failed for ${repoInfo.owner}/${repoInfo.repo}:`, branchError.message);
        continue;
      }
    }
    
    // Ultimate fallback - try main branch anyway
    console.log(`All GitLab branch tests failed, defaulting to main branch for ${repoInfo.owner}/${repoInfo.repo}`);
    return {
      version: 'main',
      name: 'main branch',
      downloadUrl: `https://gitlab.com/${repoInfo.owner}/${repoInfo.repo}/-/archive/main/${repoInfo.repo}-main.zip`,
      publishedAt: new Date().toISOString(),
      size: null,
      source: 'code-branch-fallback'
    };
  } catch (error) {
    console.error(`GitLab code fallback failed for ${repoInfo.owner}/${repoInfo.repo}:`, error.message);
    
    // Final fallback - return unknown
    return {
      version: 'Unknown',
      name: 'Unknown',
      downloadUrl: null,
      publishedAt: null,
      size: null,
      source: 'unknown'
    };
  }
}

/**
 * Get the latest release from any supported platform
 * @param {string} repoUrl - Repository URL
 * @param {string} preferredAssetName - Optional preferred asset name for download
 * @returns {Promise<Object>} - Release information
 */
export async function getLatestRelease(repoUrl, preferredAssetName = null) {
  const cacheKey = `latest:${repoUrl}:${preferredAssetName || 'default'}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  try {
    const repoInfo = parseRepoFromUrl(repoUrl);
    
    let result;
    if (repoInfo.platform === 'github') {
      result = await getGitHubLatestRelease(repoInfo, preferredAssetName);
    } else if (repoInfo.platform === 'gitlab') {
      result = await getGitLabLatestRelease(repoInfo);
    } else {
      throw new Error(`Unsupported platform: ${repoInfo.platform}`);
    }
    
    // Only cache successful results (not 'Unknown' versions)
    if (result.version !== 'Unknown') {
      cacheSet(cacheKey, result);
    }
    
    return result;
  } catch (error) {
    console.error(`Error getting latest release for ${repoUrl}:`, error.message);
    
    // Improve error message for user-facing errors
    const userFriendlyMessage = error.message.includes('not found') || error.message.includes('404') 
      ? error.message 
      : `Failed to access repository: ${error.message}`;
    
    // Re-throw with better error message instead of returning unknown
    throw new Error(userFriendlyMessage);
  }
}

/**
 * Download a file using Electron's download API
 * @param {string} url - URL to download
 * @param {string} destinationPath - Where to save the file
 * @returns {Promise<string>} - Path to downloaded file
 */
export async function downloadFile(url, destinationPath) {
  if (!window.electronAPI || !window.electronAPI.downloadFile) {
    throw new Error('Download functionality not available');
  }
  
  return await window.electronAPI.downloadFile(url, destinationPath);
}

/**
 * Check for curated addon list
 * @param {string} url - URL to curated JSON list
 * @returns {Promise<Array>} - Array of curated addons
 */
export async function getCuratedAddons(url) {
  try {
    if (window.electronAPI && window.electronAPI.fetchCuratedList) {
      const response = await window.electronAPI.fetchCuratedList(url);
      return JSON.parse(response);
    } else {
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      return await response.json();
    }
  } catch (error) {
    console.error('Error fetching curated addons:', error);
    return [];
  }
}
