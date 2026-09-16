'use strict';
/*
 * RedMarks Wardogs Server Browser - main process
 *
 * What this app does:     shows WARDOGS server info from wardogserverlist.com.
 * What this app never does: open, read, or change game files; read game memory;
 *                         inject overlays; talk to Bulkhead's or Steam's servers.
 */

const { app, BrowserWindow, ipcMain, shell, net, clipboard } = require('electron');
const path = require('path');
const { WardogsApi } = require('./api');
const { Store } = require('./store');
const ping = require('./ping');

const pkg = require('../../package.json');
const REPO_URL = 'https://github.com/ClownKiller/redmarks-wardogs-server-browser';
const USER_AGENT = `RedMarksWardogsServerBrowser/${pkg.version} (+${REPO_URL})`;

// Only these sites may be opened in the user's web browser from inside the app.
const EXTERNAL_ALLOWED = ['wardogserverlist.com', 'github.com'];

let win = null;
let api = null;
let store = null;

// One copy of the app at a time; a second launch just focuses the first.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
  });
  app.whenReady().then(start);
}

function start() {
  api = new WardogsApi({ fetchImpl: (url, opts) => net.fetch(url, opts), userAgent: USER_AGENT });
  store = new Store(app.getPath('userData'));
  registerHandlers();
  createWindow();
}

function createWindow() {
  win = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 900,
    minHeight: 600,
    frame: false,                 // we draw our own military-style title bar
    backgroundColor: '#0A0A0A',
    show: false,
    title: 'RedMarks Wardogs Server Browser',
    icon: path.join(__dirname, '..', 'renderer', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });

  win.setMenu(null);
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  win.once('ready-to-show', () => win.show());

  // Links never open new app windows; allowed ones go to the normal browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    openExternalSafe(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e) => e.preventDefault());

  win.on('maximize', () => win.webContents.send('window:state', { maximized: true }));
  win.on('unmaximize', () => win.webContents.send('window:state', { maximized: false }));
  win.on('closed', () => { win = null; });
}

function openExternalSafe(url) {
  try {
    const u = new URL(url);
    const okHost = EXTERNAL_ALLOWED.some((h) => u.hostname === h || u.hostname.endsWith('.' + h));
    if (u.protocol === 'https:' && okHost) shell.openExternal(u.toString());
  } catch (err) { /* ignore bad links */ }
}

// ---------- argument checks (the screen is treated as untrusted input) ----------

const str = (v, max = 200) => (typeof v === 'string' && v.length > 0 && v.length <= max ? v : undefined);
const win3 = (v) => (['24h', '7d', '30d'].includes(v) ? v : undefined);

/** Wrap a handler so errors come back as { ok:false, error } instead of crashing. */
function handle(channel, fn) {
  ipcMain.handle(channel, async (_event, arg) => {
    try {
      return { ok: true, ...(await fn(arg || {})) };
    } catch (err) {
      return { ok: false, error: err && err.message ? err.message : 'Something went wrong.' };
    }
  });
}

function registerHandlers() {
  handle('app:info', async () => ({ version: pkg.version, repo: REPO_URL }));

  handle('api:server', async (a) => api.getServer({ key: str(a.key), code: str(a.code, 40) }));
  handle('api:leaderboard', async () => api.getLeaderboard());
  handle('api:detail', async (a) => api.getServerDetail({ key: str(a.key), id: str(a.id), window: win3(a.window) }));
  handle('api:totals', async (a) => api.getTotals(win3(a.window)));
  handle('api:regions', async (a) => api.getRegionHistory(win3(a.window)));
  handle('api:builds', async () => api.getBuilds());

  handle('ping:region', async (a) => ({ region: str(a.region, 40), ms: await ping.estimate(str(a.region, 40)) }));

  handle('fav:list', async () => ({ favourites: store.listFavourites() }));
  handle('fav:add', async (a) => ({ favourites: store.addFavourite({ key: str(a.key), name: a.name, region: a.region, official: a.official }) }));
  handle('fav:remove', async (a) => ({ favourites: store.removeFavourite(str(a.key)) }));
  handle('fav:touch', async (a) => { store.touchFavourite(str(a.key), a.name, a.region); return {}; });

  handle('settings:get', async () => ({ settings: store.getSettings() }));
  handle('settings:save', async (a) => ({ settings: store.saveSettings(a) }));

  handle('clipboard:write', async (a) => { clipboard.writeText(str(a.text, 60) || ''); return {}; });
  handle('link:open', async (a) => { openExternalSafe(str(a.url, 500)); return {}; });

  handle('window:minimize', async () => { if (win) win.minimize(); return {}; });
  handle('window:maximize', async () => {
    if (win) { if (win.isMaximized()) win.unmaximize(); else win.maximize(); }
    return {};
  });
  handle('window:close', async () => { if (win) win.close(); return {}; });
}

app.on('window-all-closed', () => app.quit());
