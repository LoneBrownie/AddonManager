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

/**
 * Get the latest release from GitHub
 * @param {Object} repoInfo - Repository information from parseRepoFromUrl
 * @param {string} preferredAssetName - Optional preferred asset name to download
 * @returns {Promise<Object>} - Release information
 */
async function getGitHubLatestRelease(repoInfo, preferredAssetName = null) {
  const response = await fetch(`${repoInfo.apiUrl}/releases/latest`);
  
  if (!response.ok) {
    if (response.status === 404) {
      // No releases found, fall back to latest code
      console.log('No releases found, falling back to latest code from default branch');
      return await getGitHubLatestCode(repoInfo);
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

    // No ZIP asset or zipball - fall back to latest code from default branch
    console.log('No ZIP asset in release, falling back to latest code');
    return await getGitHubLatestCode(repoInfo);
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
 * Get the latest release from GitLab
 * @param {Object} repoInfo - Repository information from parseRepoFromUrl
 * @returns {Promise<Object>} - Release information
 */
async function getGitLabLatestRelease(repoInfo) {
  const response = await fetch(`${repoInfo.apiUrl}/releases`);
  
  if (!response.ok) {
    if (response.status === 404) {
      // No releases found, fall back to latest code
      console.log('No releases found, falling back to latest code from default branch');
      return await getGitLabLatestCode(repoInfo);
    }
    throw new Error(`GitLab API error: ${response.status}`);
  }
  
  const releases = await response.json();
  
  if (!releases || releases.length === 0) {
    // No releases, fall back to latest code
    console.log('No releases found, falling back to latest code');
    return await getGitLabLatestCode(repoInfo);
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

    // No ZIP asset or constructed archive, fall back to latest code
    console.log('No ZIP asset in release, falling back to latest code');
    return await getGitLabLatestCode(repoInfo);
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
      return await getGitHubLatestRelease(repoInfo, preferredAssetName);
    } else if (repoInfo.platform === 'gitlab') {
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
