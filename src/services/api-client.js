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
 * Try to discover latest release/tag via public web endpoints (no API) to avoid hitting API rate limits.
 * Returns an object similar to API release `{ version, downloadUrl, name, publishedAt, source }` or null.
 */
async function getGitHubLatestFromWeb(repoInfo) {
  const cacheKey = `gh:web:${repoInfo.owner}/${repoInfo.repo}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  try {
    // Try the releases/latest web URL which redirects to the release page with the tag in URL
    const releasesLatestUrl = `https://github.com/${repoInfo.owner}/${repoInfo.repo}/releases/latest`;
    const resp = await fetch(releasesLatestUrl, { redirect: 'follow' });
    if (resp && resp.ok) {
      const finalUrl = resp.url || '';
      // eslint-disable-next-line no-useless-escape
      const m = finalUrl.match(/\/releases\/tag\/(.+)$/);
      if (m && m[1]) {
        const tag = decodeURIComponent(m[1]);
        const downloadUrl = `https://codeload.github.com/${repoInfo.owner}/${repoInfo.repo}/zip/${tag}`;
        const result = { version: tag, name: `Release ${tag}`, downloadUrl, publishedAt: null, size: null, source: 'release-web' };
        cacheSet(cacheKey, result);
        return result;
      }
    }

    // If release redirect failed, fetch releases page HTML and try to parse first /releases/tag/ link
    const listResp = await fetch(`https://github.com/${repoInfo.owner}/${repoInfo.repo}/releases`);
    if (listResp && listResp.ok) {
  const text = await listResp.text();
  // eslint-disable-next-line no-useless-escape
  const tagMatch = text.match(/\/(?:[^/]+)\/(?:[^/]+)\/releases\/tag\/([\w%\-.+]+)/);
      if (tagMatch && tagMatch[1]) {
        const tag = decodeURIComponent(tagMatch[1]);
        const downloadUrl = `https://codeload.github.com/${repoInfo.owner}/${repoInfo.repo}/zip/${tag}`;
        const result = { version: tag, name: `Release ${tag}`, downloadUrl, publishedAt: null, size: null, source: 'release-web' };
        cacheSet(cacheKey, result);
        return result;
      }
    }

    // As a last web fallback, try the tags page and find the first tag link
    const tagsResp = await fetch(`https://github.com/${repoInfo.owner}/${repoInfo.repo}/tags`);
    if (tagsResp && tagsResp.ok) {
    const text = await tagsResp.text();
    // eslint-disable-next-line no-useless-escape
  const tagMatch = text.match(/\/(?:[^/]+)\/(?:[^/]+)\/releases\/tag\/([\w%\-.+]+)/) || text.match(/\/(?:[^/]+)\/(?:[^/]+)\/tree\/([\w%\-.+]+)/);
      if (tagMatch && tagMatch[1]) {
        const tag = decodeURIComponent(tagMatch[1]);
        const downloadUrl = `https://codeload.github.com/${repoInfo.owner}/${repoInfo.repo}/zip/${tag}`;
        const result = { version: tag, name: `Tag ${tag}`, downloadUrl, publishedAt: null, size: null, source: 'tag-web' };
        cacheSet(cacheKey, result);
        return result;
      }
    }
  } catch (err) {
    // ignore web fallback errors and let API-based methods handle it
    console.debug('GitHub web fallback failed:', err);
  }

  return null;
}

async function getGitLabLatestFromWeb(repoInfo) {
  const cacheKey = `gl:web:${repoInfo.owner}/${repoInfo.repo}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  try {
    const releasesLatestUrl = `https://gitlab.com/${repoInfo.owner}/${repoInfo.repo}/-/releases/latest`;
    const resp = await fetch(releasesLatestUrl, { redirect: 'follow' });
    if (resp && resp.ok) {
      const finalUrl = resp.url || '';
      // eslint-disable-next-line no-useless-escape
  const m = finalUrl.match(/\/-\/releases\/(?:[^/]+)\/([\w%\-.+]+)$/) || finalUrl.match(/\/-\/releases\/([^/]+)$/);
      if (m && m[1]) {
        const tag = decodeURIComponent(m[1]);
        const downloadUrl = `https://gitlab.com/${repoInfo.owner}/${repoInfo.repo}/-/archive/${tag}/${repoInfo.repo}-${tag}.zip`;
        const result = { version: tag, name: `Release ${tag}`, downloadUrl, publishedAt: null, size: null, source: 'release-web' };
        cacheSet(cacheKey, result);
        return result;
      }
    }

    const listResp = await fetch(`https://gitlab.com/${repoInfo.owner}/${repoInfo.repo}/-/releases`);
    if (listResp && listResp.ok) {
    const text = await listResp.text();
    // eslint-disable-next-line no-useless-escape
  const tagMatch = text.match(/\/-\/releases\/([\w%\-.+]+)/);
      if (tagMatch && tagMatch[1]) {
        const tag = decodeURIComponent(tagMatch[1]);
        const downloadUrl = `https://gitlab.com/${repoInfo.owner}/${repoInfo.repo}/-/archive/${tag}/${repoInfo.repo}-${tag}.zip`;
        const result = { version: tag, name: `Release ${tag}`, downloadUrl, publishedAt: null, size: null, source: 'release-web' };
        cacheSet(cacheKey, result);
        return result;
      }
    }

    const tagsResp = await fetch(`https://gitlab.com/${repoInfo.owner}/${repoInfo.repo}/-/tags`);
    if (tagsResp && tagsResp.ok) {
      const text = await tagsResp.text();
      // eslint-disable-next-line no-useless-escape
  const tagMatch = text.match(/\/-\/tags\/([\w%\-.+]+)/) || text.match(/\/-\/tree\/([\w%\-.+]+)/);
      if (tagMatch && tagMatch[1]) {
        const tag = decodeURIComponent(tagMatch[1]);
        const downloadUrl = `https://gitlab.com/${repoInfo.owner}/${repoInfo.repo}/-/archive/${tag}/${repoInfo.repo}-${tag}.zip`;
        const result = { version: tag, name: `Tag ${tag}`, downloadUrl, publishedAt: null, size: null, source: 'tag-web' };
        cacheSet(cacheKey, result);
        return result;
      }
    }
  } catch (err) {
    console.debug('GitLab web fallback failed:', err);
  }

  return null;
}

/**
 * Get the latest tag from GitHub
 * @param {Object} repoInfo - Repository information from parseRepoFromUrl
 * @returns {Promise<Object>} - Tagapi-client.js:403 API Error: Error: GitHub API error: 403
    at getGitHubLatestRelease (api-client.js:126:1)
    at async getLatestRelease (api-client.js:396:1)
    at async checkForUpdates (addon-manager.js:638:1)
    at async useAddons.js:296:1
addon-manager.js:648 Failed to check updates for |cff33ffccpf|cffffffffQuest |cffcccccc[Project Epoch DB] |cffff5555[RELEASE]: Error: GitHub API error: 403
    at getGitHubLatestRelease (api-client.js:126:1)
    at async getLatestRelease (api-client.js:396:1)
    at async checkForUpdates (addon-manager.js:638:1)
    at async useAddons.js:296:1
api-client.js:113 
 GET https://api.github.com/repos/Raynbock/Atlas-Project-Epoch/releases/latest 403 (Forbidden)
api-client.js:403 API Error: Error: GitHub API error: 403
    at getGitHubLatestRelease (api-client.js:126:1)
    at async getLatestRelease (api-client.js:396:1)
    at async checkForUpdates (addon-manager.js:638:1)
    at async useAddons.js:296:1
addon-manager.js:648 Failed to check updates for Atlas: Error: GitHub API error: 403
    at getGitHubLatestRelease (api-client.js:126:1)
    at async getLatestRelease (api-client.js:396:1)
    at async checkForUpdates (addon-manager.js:638:1)
    at async useAddons.js:296:1
api-client.js:113 
 GET https://api.github.com/repos/NeticSoul/DragonUI/releases/latest 403 (Forbidden)
api-client.js:403 API Error: Error: GitHub API error: 403
    at getGitHubLatestRelease (api-client.js:126:1)
    at async getLatestRelease (api-client.js:396:1)
    at async checkForUpdates (addon-manager.js:638:1)
    at async useAddons.js:296:1
addon-manager.js:648 Failed to check updates for |cfffff0f5DragonUI|r: Error: GitHub API error: 403
    at getGitHubLatestRelease (api-client.js:126:1)
    at async getLatestRelease (api-client.js:396:1)
    at async checkForUpdates (addon-manager.js:638:1)
    at async useAddons.js:296:1
﻿
 information
 */
async function getGitHubLatestTag(repoInfo) {
  const response = await fetch(`${repoInfo.apiUrl}/tags`);
  
  if (!response.ok) {
    throw new Error(`GitHub API error: ${response.status}`);
  }
  
  const tags = await response.json();
  
  if (!tags || tags.length === 0) {
    throw new Error('No tags found');
  }
  
  const latestTag = tags[0];
  const codeloadUrl = `https://codeload.github.com/${repoInfo.owner}/${repoInfo.repo}/zip/${latestTag.name}`;
  
  return {
    version: latestTag.name,
    name: `Tag ${latestTag.name}`,
    downloadUrl: codeloadUrl,
    publishedAt: null, // Tags don't have published dates
    size: null,
    source: 'tag'
  };
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
    // Network or CORS error when calling API from renderer - try web/tag/branch fallbacks
    console.debug('GitHub releases/latest fetch failed, trying web/tag/branch fallbacks', fetchErr);
    try {
      if (window?.electronAPI?.fetchReleaseWeb) {
        const web = await window.electronAPI.fetchReleaseWeb(`https://github.com/${repoInfo.owner}/${repoInfo.repo}`);
        if (web) return web;
      } else {
        const web = await getGitHubLatestFromWeb(repoInfo);
        if (web) return web;
      }
    } catch (webErr) {
      console.debug('Web fallback failed after network error:', webErr);
    }
    try {
      return await getGitHubLatestTag(repoInfo);
    } catch (tagError) {
      return await getGitHubLatestCode(repoInfo);
    }
  }

  if (!response.ok) {
    if (response.status === 404) {
      // No releases found, try to fall back to latest tag first
      console.log('No releases found, falling back to latest tag');
      try {
        return await getGitHubLatestTag(repoInfo);
      } catch (tagError) {
        console.log('No tags found either, falling back to latest code from default branch');
        return await getGitHubLatestCode(repoInfo);
      }
    }

    // Handle rate limiting / forbidden - try web fallback then tags/branch
    if (response.status === 403) {
      console.warn('GitHub API returned 403; attempting web/tag/branch fallbacks to avoid failure');
      try {
        if (window?.electronAPI?.fetchReleaseWeb) {
          const web = await window.electronAPI.fetchReleaseWeb(`https://github.com/${repoInfo.owner}/${repoInfo.repo}`);
          if (web) return web;
        } else {
          const web = await getGitHubLatestFromWeb(repoInfo);
          if (web) return web;
        }
      } catch (webErr) {
        console.debug('Web fallback failed after 403:', webErr);
      }

      try {
        return await getGitHubLatestTag(repoInfo);
      } catch (tagError) {
        return await getGitHubLatestCode(repoInfo);
      }
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

    // No ZIP asset or zipball - try to fall back to latest tag first
    console.log('No ZIP asset in release, falling back to latest tag');
    try {
      return await getGitHubLatestTag(repoInfo);
    } catch (tagError) {
      console.log('No tags found either, falling back to latest code from default branch');
      return await getGitHubLatestCode(repoInfo);
    }
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
 * Get the latest code from GitHub default branch
 * @param {Object} repoInfo - Repository information from parseRepoFromUrl
 * @returns {Promise<Object>} - Code download information
 */
async function getGitHubLatestCode(repoInfo) {
  // Get repository information to find default branch
  const repoResponse = await fetch(repoInfo.apiUrl);
  
  if (!repoResponse.ok) {
    throw new Error(`GitHub API error: ${repoResponse.status}`);
  }
  
  const repoData = await repoResponse.json();
  const defaultBranch = repoData.default_branch || 'main';
  
  // Get the latest commit to use as version
  const commitsResponse = await fetch(`${repoInfo.apiUrl}/commits/${defaultBranch}`);
  
  if (!commitsResponse.ok) {
    throw new Error(`Failed to get latest commit: ${commitsResponse.status}`);
  }
  
  const commitData = await commitsResponse.json();
  const shortSha = commitData.sha.substring(0, 7);
  const commitDate = new Date(commitData.commit.author.date).toISOString().split('T')[0];
  
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
}

/**
 * Get the latest tag from GitLab
 * @param {Object} repoInfo - Repository information from parseRepoFromUrl
 * @returns {Promise<Object>} - Tag information
 */
async function getGitLabLatestTag(repoInfo) {
  const response = await fetch(`${repoInfo.apiUrl}/repository/tags`);
  
  if (!response.ok) {
    throw new Error(`GitLab API error: ${response.status}`);
  }
  
  const tags = await response.json();
  
  if (!tags || tags.length === 0) {
    throw new Error('No tags found');
  }
  
  const latestTag = tags[0];
  const archiveUrl = `https://gitlab.com/${repoInfo.owner}/${repoInfo.repo}/-/archive/${latestTag.name}/${repoInfo.repo}-${latestTag.name}.zip`;
  
  return {
    version: latestTag.name,
    name: `Tag ${latestTag.name}`,
    downloadUrl: archiveUrl,
    publishedAt: latestTag.commit?.committed_date || null,
    size: null,
    source: 'tag'
  };
}

/**
 * Get the latest release from GitLab
 * @param {Object} repoInfo - Repository information from parseRepoFromUrl
 * @returns {Promise<Object>} - Release information
 */
async function getGitLabLatestRelease(repoInfo) {
  const response = await fetch(`${repoInfo.apiUrl}/releases`);
  
  if (!response.ok) {
    if (response.status === 404) {
      // No releases found, try to fall back to latest tag first
      console.log('No releases found, falling back to latest tag');
      try {
        return await getGitLabLatestTag(repoInfo);
      } catch (tagError) {
        console.log('No tags found either, falling back to latest code from default branch');
        return await getGitLabLatestCode(repoInfo);
      }
    }
    throw new Error(`GitLab API error: ${response.status}`);
  }
  
  const releases = await response.json();
  
  if (!releases || releases.length === 0) {
    // No releases, try to fall back to latest tag first
    console.log('No releases found, falling back to latest tag');
    try {
      return await getGitLabLatestTag(repoInfo);
    } catch (tagError) {
      console.log('No tags found either, falling back to latest code from default branch');
      return await getGitLabLatestCode(repoInfo);
    }
  }
  
  const latestRelease = releases[0];
  
  // Find ZIP asset in release assets
  const zipAsset = latestRelease.assets?.links?.find(link => 
    link.name?.toLowerCase().endsWith('.zip') || 
    link.url?.toLowerCase().includes('.zip')
  );
  
  if (!zipAsset) {
    // No explicit ZIP asset - try constructing a release archive URL for the tag
    try {
      const tag = latestRelease.tag_name || latestRelease.name;
      if (tag) {
        const archiveUrl = `https://gitlab.com/${repoInfo.owner}/${repoInfo.repo}/-/archive/${tag}/${repoInfo.repo}-${tag}.zip`;
        return {
          version: latestRelease.tag_name,
          name: latestRelease.name || latestRelease.tag_name,
          downloadUrl: archiveUrl,
          publishedAt: latestRelease.released_at,
          size: null,
          source: 'release-archive'
        };
      }
    } catch (err) {
      // ignore and fall back
    }

    // No ZIP asset or constructed archive, try to fall back to latest tag first
    console.log('No ZIP asset in release, falling back to latest tag');
    try {
      return await getGitLabLatestTag(repoInfo);
    } catch (tagError) {
      console.log('No tags found either, falling back to latest code from default branch');
      return await getGitLabLatestCode(repoInfo);
    }
  }
  
  return {
    version: latestRelease.tag_name,
    name: latestRelease.name || latestRelease.tag_name,
    downloadUrl: zipAsset.url,
    publishedAt: latestRelease.released_at,
    size: null, // GitLab doesn't provide size in the same way
    source: 'release'
  };
}

/**
 * Get the latest code from GitLab default branch
 * @param {Object} repoInfo - Repository information from parseRepoFromUrl
 * @returns {Promise<Object>} - Code download information
 */
async function getGitLabLatestCode(repoInfo) {
  // Get repository information to find default branch
  const repoResponse = await fetch(repoInfo.apiUrl);
  
  if (!repoResponse.ok) {
    throw new Error(`GitLab API error: ${repoResponse.status}`);
  }
  
  const repoData = await repoResponse.json();
  const defaultBranch = repoData.default_branch || 'main';
  
  // Get the latest commit to use as version
  const commitsResponse = await fetch(`${repoInfo.apiUrl}/repository/commits/${defaultBranch}`);
  
  if (!commitsResponse.ok) {
    throw new Error(`Failed to get latest commit: ${commitsResponse.status}`);
  }
  
  const commitData = await commitsResponse.json();
  const shortSha = commitData.id.substring(0, 7);
  const commitDate = new Date(commitData.committed_date).toISOString().split('T')[0];
  
  return {
    version: `${commitDate}-${shortSha}`,
    name: `Latest code (${shortSha})`,
    downloadUrl: `https://gitlab.com/${repoInfo.owner}/${repoInfo.repo}/-/archive/${defaultBranch}/${repoInfo.repo}-${defaultBranch}.zip`,
    publishedAt: commitData.committed_date,
    size: null, // Unknown size for archive
    source: 'branch',
    branch: defaultBranch,
    commit: commitData.id
  };
}

/**
 * Get the latest release for a repository
 * @param {string} repoUrl - GitHub or GitLab repository URL
 * @param {string} preferredAssetName - Optional preferred asset name to download
 * @returns {Promise<Object>} - Release information
 */
export async function getLatestRelease(repoUrl, preferredAssetName = null) {
  const repoInfo = parseRepoFromUrl(repoUrl);
  
  try {
    if (repoInfo.platform === 'github') {
      // If no specific asset is requested, try the web fallback first to avoid API limits
      if (!preferredAssetName) {
        try {
          // Prefer main-process fetch (avoids CORS) when available
          if (window.electronAPI?.fetchReleaseWeb) {
            const web = await window.electronAPI.fetchReleaseWeb(repoUrl);
            // Ignore non-informative web responses that return the literal 'latest'
            if (web && web.version && String(web.version).toLowerCase() !== 'latest') return web;
          } else {
            const web = await getGitHubLatestFromWeb(repoInfo);
            if (web && web.version && String(web.version).toLowerCase() !== 'latest') return web;
          }
        } catch (err) {
          // ignore and fall back to API
        }
      }
      return await getGitHubLatestRelease(repoInfo, preferredAssetName);
    } else if (repoInfo.platform === 'gitlab') {
      // Try web fallback first when possible (prefer main-process fetch to avoid CORS)
      try {
        if (window.electronAPI?.fetchReleaseWeb) {
          const web = await window.electronAPI.fetchReleaseWeb(repoUrl);
          if (web && web.version && String(web.version).toLowerCase() !== 'latest') return web;
        } else {
          const web = await getGitLabLatestFromWeb(repoInfo);
          if (web && web.version && String(web.version).toLowerCase() !== 'latest') return web;
        }
      } catch (err) {
        // ignore and fall back to API
      }
      return await getGitLabLatestRelease(repoInfo);
    }
    
    throw new Error('Unsupported platform');
  } catch (error) {
    console.error('API Error:', error);
    throw error;
  }
}

/**
 * Download a file from a URL using Electron main process
 * @param {string} url - Download URL
 * @param {string} destinationPath - Local file path to save to
 * @returns {Promise<string>} - Path to downloaded file
 */
export async function downloadFile(url, destinationPath) {
  // ✅ Security: Use secure Electron API access for downloads
  if (window.electronAPI?.downloadFile) {
    try {
      await window.electronAPI.downloadFile(url, destinationPath);
      return destinationPath;
    } catch (error) {
      throw new Error(`Download failed: ${error.message}`);
    }
  } else {
    throw new Error('Download functionality not available. Please run in Electron environment.');
  }
}
