# Modio Manager

A Windows desktop mod manager built with Electron, TypeScript, and React. It uses mod.io's official REST API and keeps API keys and access tokens out of the renderer process.

## Requirements

- Windows 10 or later
- Node.js 22 or later
- npm

## Development

Open PowerShell in the project folder and run:

```powershell
npm.cmd install
npm.cmd run dev
```

If PowerShell blocks the `npm` script, use `npm.cmd` instead.

## Build the Windows installer

```powershell
npm.cmd run package:win
```

The installer is created in the `release` folder as `Modio-Manager-Setup-2.0.6.exe`.

## Publish a GitHub Release

The `.github/workflows/release.yml` workflow builds a Windows x64 installer and attaches it to a GitHub Release whenever a Git tag beginning with `v` is pushed.

For the first upload, run these commands in the project folder:

```powershell
git init -b main
git remote add origin https://github.com/USERNAME/REPOSITORY.git
git add .
git commit -m "Initial release"
git push -u origin main
```

Replace `USERNAME/REPOSITORY` with your GitHub repository. The repository should be empty, and GitHub Actions must be enabled.

To publish a release, update the `version` in `package.json`, commit and push your changes to `main`, then push a new version tag:

```powershell
git add .
git commit -m "Prepare v2.0.6 release"
git push origin main
git tag v2.0.6
git push origin v2.0.6
```

Replace the example version with the version in `package.json`. Use your repository's default branch if it is not named `main`. After the workflow completes, the installer will be available in the repository's **Releases** section. Each release must use a unique tag.

Installed versions check this GitHub Release feed at startup. When a newer version is available, the app asks before downloading and installing it. The release workflow uploads the installer, update metadata, and block map needed by the updater.

## Features

- Sign in with a mod.io email verification code and sync subscriptions
- Browse subscribed games with artwork and configure platform and ZIP extraction options
- Search the game and mod catalogs, browse paginated results, and subscribe to mods
- Sort mod catalogs by popularity, rating, downloads, or subscribers in ascending or descending order
- Download mods into game folders and safely extract ZIP archives or save them as-is
- View account and sync activity
- Use a custom dark desktop interface

Game and mod catalog results are shown 40 items per page. Sign in to your mod.io account to subscribe to mods and sync your library.

## Local settings and the previous version

Current settings are stored in `%LOCALAPPDATA%\ModioManager\modio_config.electron.json`. The API key and access token are encrypted with Electron `safeStorage`, tied to the current Windows user account. Game folders and download preferences are stored in the same file.

The previous WPF source code is retained in the `ModioManager` folder. A source backup created before the migration is in `backups\pre-electron-20261102-185852`. On first launch, the app imports game folders and the User ID from the previous `%LOCALAPPDATA%\ModioManager\modio_config.json` file. Because Electron's secure storage differs from the previous DPAPI format, you must enter your API key and sign in again once. The previous settings file is not modified.

## Project structure

- `electron`: Secure main process, API client, local settings, IPC, and synchronization
- `renderer`: React and TypeScript user interface
- `ModioManager`: Previous WPF/C# application source
