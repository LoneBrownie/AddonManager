# WoW Addon Manager

A modern Windows desktop application built with Electron and React for managing World of Warcraft addons from GitHub and GitLab repositories. Features a sleek tab-based interface with curated addon recommendations and persistent data storage.

## ✨ Features

### Core Functionality
- 🔗 **Add addons from URLs**: Simply paste GitHub or GitLab repository URLs
- 📦 **Automatic installation**: Downloads and extracts addons to your WoW directory
- 🔄 **Smart update management**: Check for and install updates with one click
- 📊 **Rich addon information**: Displays version info, author, and metadata from .toc files
- 💾 **Persistent storage**: Addon lists and settings survive application updates
- ⚙️ **Easy configuration**: Set your WoW installation path once

### User Interface
- 🎯 **Tab-based navigation**: Organized interface with My Addons, Handy Addons, and Settings tabs
- 📋 **List view**: Clean, readable addon list with improved visibility
- 🎨 **Modern design**: Intuitive interface with proper contrast and accessibility
- 📱 **Responsive layout**: Adapts to different window sizes

### Advanced Features
- 🔍 **Existing addon scanning**: Import and manage addons already installed in your WoW directory
- 📚 **Curated addon collection**: Pre-selected quality addons for Classic and WotLK
- 🎯 **Custom installation options**: Special handling for complex addons with custom folder names
- 🔒 **Security focused**: Content Security Policy and secure IPC communication
- 🔄 **Automatic migration**: Seamlessly migrates data from older versions

### API Support
- 🐙 **GitHub integration**: Full support for GitHub repositories and releases
- 🦊 **GitLab compatibility**: Works with GitLab.com repositories
- 📦 **Flexible downloads**: Supports direct downloads and custom asset selection

## 📋 Prerequisites

- **OS**: Windows 10 or later
- **Runtime**: Node.js 16+ and npm (for development)
- **Game**: World of Warcraft installation (Classic, WotLK, or Retail)
- **Optional**: Git (for development contributions)

## 🚀 Quick Start

### For Users (Recommended)
1. Download the latest `WoW Addon Manager Setup.exe` from the releases page
2. Run the installer and follow the setup wizard
3. Launch the application
4. Configure your WoW installation path in Settings
5. Start adding addons!

### For Developers

```bash
git clone https://github.com/LoneBrownie/AddonManager.git
cd AddonManager
npm install
npm run electron-dev
```

## 📖 Usage Guide

### Initial Setup
1. **Launch the application**
2. **Navigate to Settings tab** (or click the gear icon)
3. **Set WoW Path**: Browse to your WoW installation directory
   - Example: `C:\Program Files (x86)\World of Warcraft`
   - Example: `C:\Games\World of Warcraft`
4. **Save settings** - Your configuration will persist across app updates

### My Addons Tab
- **Add new addons**: Paste GitHub/GitLab repository URLs
- **Manage existing**: View, update, or remove your installed addons
- **Bulk operations**: Update all addons at once or check for updates
- **Import existing**: Scan your AddOns folder to manage already installed addons

### Handy Addons Tab
- **Curated collection**: Pre-selected quality addons for Classic and WotLK
- **One-click install**: Install recommended addons with special configurations
- **Category filtering**: Browse by addon type (Core, Healing, Questing, etc.)
- **Special handling**: Automatic custom folder naming and preferred asset selection

## 🔧 Technical Overview

### Architecture
- **Frontend**: React 18 with functional components and hooks
- **Backend**: Electron 32+ with secure IPC communication
- **Storage**: Persistent userData storage (survives app updates)
- **APIs**: GitHub REST API v3, GitLab REST API v4
- **Security**: Content Security Policy, context isolation, no remote modules

### Project Structure

```
src/
├── components/
│   ├── AddAddon.jsx              # URL input and validation
│   ├── AddonList.jsx             # Main addon list display
│   ├── AddonListItem.jsx         # Individual addon list items
│   ├── AddonCard.jsx             # Detailed addon cards (legacy)
│   ├── HandyAddons.jsx           # Curated addon recommendations
│   ├── ExistingAddonManager.jsx  # Import existing addons
│   └── Settings.jsx              # Configuration management
├── services/
│   ├── api-client.js             # GitHub/GitLab API integration
│   └── addon-manager.js          # Addon installation and file management
├── hooks/
│   └── useAddons.js              # React state management and persistence
└── App.js                        # Main application with tab navigation

public/
├── electron.js                   # Main Electron process
├── preload.js                    # Secure IPC bridge
└── installer.nsh                 # Custom NSIS installer script
```

### Data Persistence
- **Storage Location**: `%APPDATA%\wow-addon-manager\`
- **Files**: `addons.json`, `settings.json`
- **Migration**: Automatic migration from localStorage
- **Backup**: Installer preserves data during updates

### Addon Data Structure

```javascript
{
  id: "unique-addon-identifier",
  name: "Addon Display Name",
  repoUrl: "https://github.com/owner/repo",
  currentVersion: "1.2.3",
  latestVersion: "1.2.4",
  needsUpdate: true,
  installPath: "C:/WoW/Interface/AddOns/AddonName",
  installedFolders: ["AddonName", "AddonName_Config"],
  lastUpdated: "2025-01-01T00:00:00.000Z",
  customFolderName: "CustomName",      // Optional: custom installation folder
  preferredAssetName: "specific.zip",  // Optional: specific release asset
  isDirectDownload: false,             // Optional: direct download handling
  tocData: {
    title: "Addon Name",
    version: "1.2.3",
    author: "Author Name",
    interface: "110000",
    notes: "Addon description"
  }
}
```

## 🛠️ Development

### Available Scripts

```bash
# Development
npm run electron-dev    # Start React + Electron in development mode
npm start              # Start React development server only
npm run electron       # Start Electron (requires built React app)

# Production
npm run build          # Build React app for production
npm run dist           # Build and package for Windows distribution
npm run dist-win       # Windows-specific build
npm run dist-portable  # Portable version (no installer)

# Testing
npm test               # Run React test suite
```

### Build Requirements
- **Node.js**: 16+ with npm
- **Python**: 2.7 or 3.x (for native modules)
- **Visual Studio Build Tools**: For native dependencies
- **Windows SDK**: For Windows builds

### Technologies Used
- **Electron 32+**: Desktop application framework with security focus
- **React 18**: Modern frontend with hooks and functional components
- **Node.js**: Backend runtime for file operations and API calls
- **adm-zip**: ZIP file extraction and archive handling
- **electron-builder**: Application packaging and installer creation

## 🔍 Supported Repository Formats

### GitHub
- **URL**: `https://github.com/owner/repository`
- **API**: GitHub REST API v3
- **Assets**: Downloads ZIP files from release assets
- **Features**: Full release metadata, asset selection, redirect handling

### GitLab
- **URL**: `https://gitlab.com/owner/repository`
- **API**: GitLab REST API v4
- **Assets**: Downloads ZIP files from release assets
- **Features**: Release information, project metadata

### Special Cases
- **Direct Downloads**: Custom handling for non-standard release patterns
- **Custom Assets**: Preferred asset name selection for multi-file releases
- **Folder Naming**: Custom installation folder names for compatibility

## 🐛 Troubleshooting

### Common Issues

**"WoW installation path not configured"**
- **Solution**: Set the WoW path in the Settings tab to your main WoW folder
- **Check**: Ensure the path contains `Interface/AddOns` subdirectory

**"Repository not found or has no releases"**
- **Check**: Repository exists and is publicly accessible
- **Verify**: Repository has published releases (not just tags)
- **Assets**: Releases contain ZIP files for download

**"Download failed" or timeout errors**
- **Network**: Check internet connection and firewall settings
- **Redirects**: Application handles redirects automatically
- **Retry**: Use the retry button or restart the download

**Permission errors during installation**
- **Administrator**: Try running as Administrator
- **Antivirus**: Check if antivirus is blocking file operations
- **Read-only**: Ensure WoW directory is not set to read-only

**Data loss after update**
- **Migration**: Data should migrate automatically from localStorage
- **Backup**: Check `%APPDATA%\wow-addon-manager\` for backup files
- **Recovery**: Re-scan existing addons if needed

### Advanced Troubleshooting

**Application won't start**
- Clear Electron cache: Delete `%APPDATA%\wow-addon-manager\Electron*`
- Reinstall with latest installer
- Check Windows event logs for detailed error information

**Addon detection issues**
- Verify `.toc` files are properly formatted
- Check for Unicode/encoding issues in addon folders
- Manually refresh the addon list

**Update detection problems**
- Clear cache and restart application
- Check if repository still exists and has new releases
- Verify network connectivity to GitHub/GitLab APIs

## 🤝 Contributing

We welcome contributions! Here's how to get started:

### Development Setup
1. **Fork** the repository on GitHub
2. **Clone** your fork locally
3. **Install** dependencies: `npm install`
4. **Create** a feature branch: `git checkout -b feature/amazing-feature`
5. **Test** your changes: `npm run electron-dev`

### Making Changes
- Follow existing code style and patterns
- Test thoroughly on Windows
- Update documentation for new features
- Add comments for complex functionality

### Submitting Changes
1. **Commit** your changes: `git commit -m 'Add amazing feature'`
2. **Push** to your branch: `git push origin feature/amazing-feature`
3. **Create** a Pull Request with detailed description
4. **Respond** to code review feedback

### Areas for Contribution
- 🐛 Bug fixes and stability improvements
- ✨ New features and enhancements
- 📚 Documentation improvements
- 🎨 UI/UX enhancements
- 🔧 Performance optimizations

## 📄 License

This project is licensed under the **MIT License** - see the [LICENSE](LICENSE) file for details.

## ⚠️ Disclaimer

This application is **not affiliated** with Blizzard Entertainment or World of Warcraft. 

- Use at your own risk
- Always backup your WoW addons before making changes
- Some addons may require specific WoW versions
- Verify addon compatibility with your WoW installation

## 🙏 Acknowledgments

- WoW addon community for creating amazing addons
- Electron and React teams for excellent frameworks
- Contributors who help improve this project
- Addon authors who maintain their repositories

## 📧 Support

- **Issues**: Report bugs and request features on GitHub Issues
- **Discussions**: Join community discussions on GitHub Discussions
- **Documentation**: Check this README and inline code comments

---

**Made with ❤️ for the WoW community**
