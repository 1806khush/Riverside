const { app, BrowserWindow, session, desktopCapturer, dialog, Menu, shell, systemPreferences } = require('electron');
const { spawn } = require('node:child_process');
const { randomBytes } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const smoke = process.argv.includes('--smoke-test');
if (smoke) app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'cpe-electron-test-')));
let window, backend, stopping = false;
const origin = 'http://127.0.0.1:17863'; // Stable origin preserves the existing IndexedDB store.
const token = randomBytes(32).toString('hex');
const trusted = url => { try { return new URL(url).origin === origin; } catch { return false; } };
const root = path.resolve(__dirname, '..');

function stopBackend() {
  if (!backend?.pid) return;
  try {
    if (process.platform === 'win32') spawn('taskkill', ['/pid', String(backend.pid), '/T', '/F'], { windowsHide: true });
    else process.kill(-backend.pid, 'SIGTERM');
  } catch {}
  backend = null;
}

async function startBackend() {
  const resources = app.isPackaged ? process.resourcesPath : root;
  const runtime = path.join(resources, app.isPackaged ? 'runtime' : '.build/runtime');
  const studio = app.isPackaged ? path.join(resources, 'studio') : root;
  const manifest = JSON.parse(fs.readFileSync(path.join(runtime, 'runtime.json'), 'utf8'));
  if (manifest.platform !== process.platform || manifest.arch !== process.arch) throw new Error('This app was built for a different operating system or processor.');
  const env = { ...process.env, CPE_DESKTOP_TOKEN: token, PYTHONUNBUFFERED: '1',
    PYTHONNOUSERSITE: '1', PYTHONDONTWRITEBYTECODE: '1' };
  for (const key of ['PYTHONHOME', 'PYTHONPATH', 'VIRTUAL_ENV', 'DYLD_LIBRARY_PATH', 'DYLD_FRAMEWORK_PATH']) delete env[key];
  backend = spawn(path.join(runtime, manifest.python), ['-u', path.join(studio, 'server.py'), '--port', '17863', '--watch-parent'], {
    cwd: studio, env, windowsHide: true, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe']
  });
  await new Promise((resolve, reject) => {
    let output = '', errors = '', ready = false;
    const timeout = setTimeout(() => reject(new Error('The local recording service did not start within 30 seconds.')), 30000);
    backend.once('error', error => { clearTimeout(timeout); reject(error); });
    backend.stderr.on('data', data => { errors = (errors + data).slice(-6000); console.error(String(data).trimEnd()); });
    backend.stdout.on('data', data => {
      output += data;
      if (!ready && output.includes('CPE Studio:')) { ready = true; clearTimeout(timeout); resolve(); }
    });
    backend.once('exit', code => {
      clearTimeout(timeout);
      if (!ready) reject(new Error(`Local service exited (${code}). ${errors}`));
      else if (!stopping) {
        dialog.showErrorBox('CPE Studio', 'The local recording service stopped. Restart CPE Studio.\n' + errors);
        app.quit();
      }
    });
  });
}

async function createWindow() {
  const ses = session.defaultSession;
  await ses.cookies.set({ url: origin, name: 'cpe-session', value: token, httpOnly: true, sameSite: 'strict', path: '/' });
  const allowed = new Set(['media', 'display-capture', 'speaker-selection']);
  ses.setPermissionCheckHandler((contents, permission, requestingOrigin) =>
    !smoke && contents === window?.webContents && trusted(requestingOrigin) && allowed.has(permission));
  ses.setPermissionRequestHandler((contents, permission, callback, details) =>
    callback(!smoke && contents === window?.webContents && trusted(details.requestingUrl || contents.getURL()) && allowed.has(permission)));
  ses.setDisplayMediaRequestHandler(async (request, callback) => {
    if (!trusted(request.frame?.url) || request.frame !== window?.webContents.mainFrame) return callback({});
    let timer;
    try {
      if (process.platform === 'darwin' && ['denied', 'restricted'].includes(systemPreferences.getMediaAccessStatus('screen'))) {
        const { response } = await dialog.showMessageBox(window, {
          type: 'info', title: 'Allow screen sharing',
          message: 'Allow CPE Studio in Screen & System Audio Recording.',
          detail: 'Open System Settings → Privacy & Security, enable CPE Studio, then quit and reopen the app. Uploaded presentations do not need this permission.',
          buttons: ['Open System Settings', 'Cancel'], defaultId: 0, cancelId: 1
        });
        if (response === 0) await shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture');
        return callback({});
      }
      const sources = await Promise.race([
        desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 0, height: 0 }, fetchWindowIcons: false }),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Screen selection timed out')), 10000); })
      ]);
      clearTimeout(timer);
      // Exclude every CPE window, including the teleprompter, from our picker.
      const sourceKey = id => id.split(':').slice(0, 2).join(':');
      const ownWindows = new Set(BrowserWindow.getAllWindows().map(item => sourceKey(item.getMediaSourceId())));
      const available = sources.filter(source => !ownWindows.has(sourceKey(source.id)) &&
        !/^(CPE Studio(?: AI)?|Teleprompter — CPE Studio)$/i.test(source.name));
      if (!available.length) return callback({});
      const { response } = await dialog.showMessageBox(window, {
        title: 'Share screen', message: 'Choose the screen or window to record.',
        buttons: ['Cancel', ...available.map(source => source.name)], cancelId: 0, defaultId: 0, noLink: true
      });
      callback(response > 0 ? { video: available[response - 1] } : {});
    } catch { callback({}); }
    finally { clearTimeout(timer); }
  // Avoid the experimental macOS overlay, which bypasses our cancellable dialog.
  }, { useSystemPicker: false });
  ses.on('will-download', (_event, item) => {
    item.setSaveDialogOptions({ title: 'Save recording', defaultPath: path.join(app.getPath('downloads'), path.basename(item.getFilename())) });
    item.once('done', (_event, state) => {
      if (state === 'interrupted') dialog.showErrorBox('Save failed', 'The file could not be saved. Try the download again.');
    });
  });
  window = new BrowserWindow({ width: 1360, height: 900, minWidth: 850, minHeight: 650,
    title: 'CPE Studio', backgroundColor: '#101013', show: !smoke,
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false }
  });
  const prompterWindows = new Set();
  window.webContents.setWindowOpenHandler(({ url, frameName }) => {
    if (!trusted(url) || new URL(url).pathname !== '/teleprompter.html' || frameName !== 'cpe-teleprompter') return { action: 'deny' };
    return { action: 'allow', overrideBrowserWindowOptions: {
      title: 'Teleprompter — CPE Studio', width: 900, height: 520, minWidth: 360, minHeight: 260,
      backgroundColor: '#151515', autoHideMenuBar: true,
      webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false }
    } };
  });
  window.webContents.on('did-create-window', child => {
    prompterWindows.add(child);
    child.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    child.webContents.on('will-navigate', (event, url) => {
      if (!trusted(url) || new URL(url).pathname !== '/teleprompter.html') event.preventDefault();
    });
    child.on('closed', () => prompterWindows.delete(child));
  });
  window.on('closed', () => { for (const child of prompterWindows) child.destroy(); });
  window.webContents.on('will-navigate', (event, url) => { if (!trusted(url)) event.preventDefault(); });
  // Existing beforeunload prevents losing an active recording.
  window.webContents.on('will-prevent-unload', () => {
    dialog.showMessageBoxSync(window, { type: 'info', message: 'Stop and save the recording before closing CPE Studio.', buttons: ['OK'] });
  });
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' }] : []),
    { role: 'editMenu' }, { role: 'windowMenu' }
  ]));
  await window.loadURL(origin);
  if (smoke) {
    try {
      let timer;
      try {
        await Promise.race([require('./smoke.cjs')(window), new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('Electron integration test timed out.')), 120000);
        })]);
      } finally { clearTimeout(timer); }
      console.log('CPE_ELECTRON_SMOKE_PASSED');
      app.quit();
    } catch (error) { console.error(error); stopping = true; stopBackend(); app.exit(1); }
  }
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { if (window) { if (window.isMinimized()) window.restore(); window.show(); window.focus(); } });
  app.whenReady().then(startBackend).then(createWindow).catch(error => {
    console.error(error);
    if (!smoke) dialog.showErrorBox('CPE Studio could not start', `${error.message}\n\nFor development, run npm run setup. If port 17863 is in use, close the other CPE Studio instance.`);
    stopping = true; stopBackend(); app.exit(1);
  });
  app.on('window-all-closed', () => app.quit());
  // will-quit runs only after beforeunload has allowed all windows to close.
  app.on('will-quit', () => { stopping = true; stopBackend(); });
  process.on('exit', stopBackend);
}
