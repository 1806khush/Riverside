# Mosaic Web

Mosaic Web is the browser recording workspace for CPE. It uses the same React, TypeScript, TanStack Start, Vite, and Nitro stack as Mosaic Studio.

The browser captures camera and microphone, a shared screen or PDF slides, and stores recording chunks in IndexedDB. It can review the tracks together and download separate synchronized MP4s or one ZIP containing both. Camera effects run in the browser with MediaPipe. The teleprompter can dock, overlay the preview, or open in a browser popup.

## Run locally

Use Node.js 22.12 or later, [uv](https://docs.astral.sh/uv/getting-started/installation/), and Chrome or Edge.

```sh
npm ci
npm run setup
npm run dev
```

Open [http://localhost:3200](http://localhost:3200). Allow camera and microphone access in the browser. The browser also controls screen-sharing and teleprompter popup permissions. Camera and screen capture require localhost or HTTPS.

`npm run setup` prepares a Python 3.12 environment under `.build/web-python`. The web launcher starts the private Python media service on a temporary loopback port, then starts TanStack. The browser calls the same-origin `/api` routes. Only the server has the per-run token for PDF rendering and FFmpeg export.

## Build and verify

```sh
npm run build
npm run check
npm run test:media
npm start
```

`npm start` serves the production build on localhost. `PORT` overrides the web port. `CPE_PYTHON` can point to an existing Python 3.12 executable with the dependencies from `requirements.txt`.

This branch is a local browser workflow. Browser recordings and settings belong to the browser’s origin and profile. Export any existing desktop recordings from their original app profile. They do not appear automatically in the browser.

## Source map

- `src/routes/` contains the TanStack page and media API routes.
- `src/recorder/` contains the existing recording engine and view, loaded after the browser mounts the recording page.
- `public/` contains MediaPipe assets, models, and the teleprompter popup document.
- `server.py` and `presentations.py` handle local FFmpeg export and PDF rendering.
