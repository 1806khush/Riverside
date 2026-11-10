# CPE Studio desktop app

This folder contains the independent desktop application, version **1.5.2**. Its interface and Python service were recovered from the existing version 1.5.2 build. The Electron shell, build scripts, bundled runtime, installed build dependencies, and generated app were restored alongside them. No application features were changed for this folder organization.

The existing app bundle is `dist/mac-arm64/CPE Studio.app`. The separately installed `/Applications/CPE Studio.app` is unchanged. Application recordings and preferences remain in the existing app profile; this reorganization does not move or modify them.

## Existing functionality

Camera/microphone recording, screen/window sharing, PDF uploads and recorded slide changes, the 16:9 shared-content frame and stop-sharing menu, device controls, stage layouts, host-name appearance, all three teleprompter modes, camera effects, screen glow, review, and MP4/ZIP downloads remain as in version 1.5.2. Transcript generation, Magic Audio, and Eye Contact remain removed. PDF upload support remains PDF-only.

The interface is local to the desktop app. Electron starts its own Python service on `127.0.0.1:17863`. This is separate from the hosted service in `../mosaic-web/`. The source uses paths relative to this folder, so the new parent-folder name does not change its backend or asset locations.

## Development and packaging

Run maintainer commands from this folder, not the Riverside root or the Mosaic Web folder. The restored build is for Apple Silicon with macOS 26 or later. Node.js 22.12+ is required for development. Python runtime setup is for maintainers; end users open the built app.

```sh
npm start
```

Existing build dependencies and `.build/runtime` are retained locally. For a fresh checkout, prepare dependencies and runtime:

```sh
npm ci
npm run setup
```

Build on the target platform:

```sh
npm run package
npm run dist
```

`package` creates the app directory in `dist/`; `dist` also creates the platform installer. The current Mac build is locally signed. Existing camera/microphone/screen permissions remain managed by the operating system.

## Source map

- `app.js`, `index.html`, `styles.css`: desktop recording interface, review, and exports.
- `electron/`: existing desktop shell and validation source.
- `server.py`, `presentations.py`: original local export and PDF service.
- `presentations.js`, `presentations.css`: PDF preview, filmstrip, and slide-recording stream.
- `host-name.js`, `teleprompter.*`, `camera-effects*`, `effects-panel.js`: existing studio features.
- `scripts/`: runtime/model preparation and existing validation source.
- `.build/`, `node_modules/`, `dist/`: local runtime, dependencies, and generated builds; excluded from Git.

No application tests, browser tests, builds, or app launches were performed during this file reorganization. The original older prototype is not used by this application.
