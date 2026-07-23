# DiskDhobi

A local-only Linux app to choose for heavy, reclaimable items — node_modules, build/cache folders, and large individual files — then selectively delete them after a dry-run preview and explicit confirmation.

## Quick Start

```bash
cd DiskDhobi
npm install
npm start
```

On NixOS, use:
```bash
nix-shell -p electron --run "electron . --no-sandbox"
```

## What it does

- Pick any root folder via a native folder picker
- Scan for `node_modules`, `.venv`, `target`, `.cache`, `dist`, `build`, and other heavy directories
- Detect individual files above 100 MB
- Select items individually, by category, or all at once — live reclaimable total updates as you select
- Dry-run preview modal shows every path and total size before any deletion
- Permanent deletion with per-item error reporting

## Editing detection rules

Edit `config/patterns.json` to change:
- `sizeThresholdBytes` — minimum file size to flag (default 100 MB)
- `dependencyFolders` — folder names treated as dependencies
- `cacheFolders` — folder names treated as cache
- `dangerousRoots` — paths that trigger a warning if selected as root

## Project structure

```
DiskDhobi/
├── main/
│   ├── main.js       # Electron entry, window setup
│   ├── scanner.js    # scan logic (du calls, pattern matching)
│   ├── deleter.js    # delete logic
│   ├── ipc.js        # IPC channel handlers
│   └── preload.js    # contextBridge API surface
├── renderer/
│   ├── index.html
│   ├── renderer.js
│   └── style.css
├── config/
│   └── patterns.json
└── package.json
```
