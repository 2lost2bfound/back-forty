// electron/main.cjs — desktop wrapper: one window, the game served from an
// app:// scheme (ES modules do not load from file://). No game code changes.
const { app, BrowserWindow, protocol, net } = require('electron');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const ROOT = path.join(__dirname, '..');

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

app.whenReady().then(() => {
  protocol.handle('app', (req) => {
    const file = path.normalize(path.join(ROOT, decodeURIComponent(new URL(req.url).pathname)));
    if (!file.startsWith(ROOT + path.sep)) return new Response('Not found', { status: 404 });
    return net.fetch(pathToFileURL(file).toString());
  });
  // BF_HEADLESS=1: no window, rendered offscreen at 60 fps (soak tests while you use the desktop).
  const headless = process.env.BF_HEADLESS === '1';
  const win = new BrowserWindow({
    width: 1600, height: 900, backgroundColor: '#06080d', autoHideMenuBar: true,
    title: 'Back Forty', show: !headless,
    webPreferences: headless ? { offscreen: true, backgroundThrottling: false } : {},
  });
  if (headless) win.webContents.setFrameRate(60);
  win.webContents.on('before-input-event', (e, input) => {
    if (input.type === 'keyDown' && input.key === 'F11') { win.setFullScreen(!win.isFullScreen()); e.preventDefault(); }
  });
  win.loadURL('app://game/index.html');
});

app.on('window-all-closed', () => app.quit());
