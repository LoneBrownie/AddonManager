# GitHub Copilot Instructions - WoW Addon Manager

## Project Context
You are helping to build a Windows desktop application using Electron + React that manages World of Warcraft addons by downloading from GitHub and GitLab repositories and keeping them updated.

## Core Functionality
- Add addons by pasting GitHub/GitLab repository URLs
- Download latest releases automatically
- Check for and install updates when new releases are available
- Parse WoW addon .toc files for metadata
- Extract ZIP files to WoW addons directory

## Technology Stack
- **Platform**: Windows only (Electron)
- **Frontend**: React with functional components and hooks
- **APIs**: GitHub REST API v3, GitLab REST API v4
- **File Operations**: Node.js fs for file system operations
- **Archive Handling**: Extract ZIP files from releases

## Project Structure
```
src/
├── components/
│   ├── AddAddon.jsx      # URL input and add functionality
│   ├── AddonList.jsx     # Display addons with update buttons
│   └── Settings.jsx      # WoW directory configuration
├── services/
│   ├── api-client.js     # GitHub/GitLab API calls
│   └── addon-manager.js  # Install/update addon logic
├── hooks/
│   └── useAddons.js      # React hook for addon state
└── App.jsx
```

## Key Data Structure
```javascript
const addon = {
  name: "AddonName",
  repoUrl: "https://github.com/user/repo",
  currentVersion: "1.2.3",
  latestVersion: "1.2.4", 
  needsUpdate: true,
  installPath: "C:/WoW/Interface/AddOns/AddonName"
};
```

## API Patterns to Follow

### GitHub API
```javascript
// Get latest release
GET https://api.github.com/repos/{owner}/{repo}/releases/latest

// Download asset
GET {asset.browser_download_url}
```

### GitLab API  
```javascript
// Get latest release
GET https://gitlab.com/api/v4/projects/{id}/releases

// For gitlab.com, project ID can be URL encoded: {owner}%2F{repo}
```

## Code Style Preferences
- Use modern React patterns (functional components, hooks)
- Use async/await for API calls and file operations
- Handle errors gracefully with try/catch blocks
- Use descriptive variable names
- Add JSDoc comments for service functions
- Prefer const/let over var
- Use template literals for string interpolation

## File Operation Patterns
- Use Node.js `fs.promises` for async file operations
- Create directories with `fs.mkdir({ recursive: true })`
- Use `path.join()` for cross-platform path handling
- Validate file paths before operations
- Handle file conflicts during addon updates

## React Patterns to Use
- Custom hooks for complex state logic (useAddons)
- useState for component state
- useEffect for side effects (checking updates)
- Error boundaries for error handling
- Loading states for async operations

## WoW Addon Specific Logic
- Parse `.toc` files to extract addon metadata
- Look for `## Version:` and `## Title:` in .toc files
- Handle addon folders that may contain multiple .toc files
- Respect WoW addon directory structure: `Interface/AddOns/`

## Error Handling Priorities
- Invalid GitHub/GitLab URLs
- API rate limiting
- Network connectivity issues  
- File permission errors
- Corrupted or invalid ZIP files
- Missing WoW installation directory

## Security Considerations
- Validate URLs before making API calls
- Sanitize file paths to prevent directory traversal
- Handle malformed ZIP files safely
- Don't expose API tokens in client code

## Performance Tips
- Cache API responses when appropriate
- Use AbortController for cancellable requests
- Show progress indicators for long operations
- Batch operations when possible

## Common Functions You'll Need
```javascript
// URL validation
function isValidRepoUrl(url) { /* validate github/gitlab URL */ }

// Parse repository info from URL
function parseRepoFromUrl(url) { /* extract owner/repo */ }

// Extract ZIP files
function extractAddon(zipPath, extractPath) { /* extract to directory */ }

// Parse .toc files
function parseAddonToc(tocContent) { /* extract name/version */ }

// Check if addon needs update
function compareVersions(current, latest) { /* semver comparison */ }
```

## Testing Considerations
- Mock API responses for consistent testing
- Test with various GitHub/GitLab URL formats
- Test file operations with different WoW directory structures
- Handle edge cases like empty releases or malformed .toc files

## Development Workflow
- Use Electron in development mode for hot reloading
- Test with real GitHub/GitLab repositories
- Handle both public and private repository scenarios
- Test with different addon structures and naming conventions

When writing code, prioritize:
1. Functionality over perfect UI styling
2. Error handling and user feedback
3. Async operation management
4. File system safety and validation
5. Clear separation of concerns between components and services