'use strict';
/*
 * RedMarks Wardogs Server Browser - main process
 *
 * What this app does:     shows WARDOGS server info from wardogservers.com (public API).
 * What this app never does: open, read, or change game files; read game memory;
 *                         inject overlays; talk to Bulkhead's or Steam's servers.
 */

const { app, BrowserWindow, ipcMain, shell, net, clipboard } = require('electron');
const path = require('path');
const { WardogsApi, cleanCode, isJoinCode } = require('./api');
const { Store } = require('./store');
const ping = require('./ping');
const { Squad, newSquad, makeInvite, readInvite, checkApiUrl, checkWebhook, cleanName } = require('./squad');

const pkg = require('../../package.json');
const REPO_URL = 'https://github.com/ClownKiller/redmarks-wardogs-server-browser';

// WARDOGS on Steam: https://store.steampowered.com/app/1867240/WARDOGS/
// WARDOGS has no official "join this server" link yet, so Join copies the
// join code and starts the game through Steam - the same thing a desktop
// shortcut does. Nothing about the game itself is touched.
const STEAM_APP_ID = '1867240';
const STEAM_LAUNCH_URL = `steam://rungameid/${STEAM_APP_ID}`;

const USER_AGENT = `RedMarksWardogsServerBrowser/${pkg.version} (+${REPO_URL})`;

// Only these sites may be opened in the user's web browser from inside the app.
const EXTERNAL_ALLOWED = ['wardogservers.com', 'github.com'];

let win = null;
let api = null;
let store = null;
let squad = null;

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
  squad = new Squad({
    fetchImpl: (url, opts) => net.fetch(url, opts),
    userAgent: USER_AGENT,
    getSettings: () => store.getSettings(),
  });
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
const oneOf = (list) => (v) => (list.includes(v) ? v : undefined);
const serverWindow = oneOf(['24h', '7d', '30d', '90d']);
const seriesGroup = oneOf(['total', 'type', 'region']);

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

  handle('api:snapshot', async () => api.getSnapshot());
  handle('api:server', async (a) => api.getServer(str(a.code, 80)));
  handle('api:history', async (a) => api.getServerHistory(str(a.code, 80), serverWindow(a.window)));
  handle('api:series', async (a) => api.getSeries(seriesGroup(a.group), '24h'));
  handle('api:find', async (a) => api.findServer(str(a.code, 80)));
  handle('code:clean', async (a) => ({ code: cleanCode(str(a.code, 80) || '') }));

  handle('ping:region', async (a) => ({ region: str(a.region, 40), ms: await ping.estimate(str(a.region, 40)) }));

  handle('fav:list', async () => ({ favourites: store.listFavourites() }));
  handle('fav:add', async (a) => ({ favourites: store.addFavourite({ key: str(a.key), name: a.name, region: a.region, official: a.official }) }));
  handle('fav:replace', async (a) => ({ favourites: store.replaceFavourite(str(a.oldKey), { key: str(a.key), name: a.name, region: a.region, official: a.official }) }));
  handle('fav:remove', async (a) => ({ favourites: store.removeFavourite(str(a.key)) }));
  handle('fav:touch', async (a) => { store.touchFavourite(str(a.key), a.name, a.region); return {}; });

  handle('settings:get', async () => ({ settings: store.getSettings() }));
  handle('settings:save', async (a) => ({ settings: store.saveSettings(a) }));

  handle('game:join', async (a) => {
    const code = isJoinCode(a.code) ? a.code : null;
    if (!code) throw new Error('This server has no usable join code.');
    clipboard.writeText(code);

    // Tell the squad, if the user set that up and didn't ask for a quiet join.
    let shared = null;
    if (!a.quiet && store.getSettings().squadAnnounce) {
      const result = await squad.announce({ code, name: str(a.serverName, 80), region: str(a.region, 40) });
      shared = { api: result.api, discord: result.discord, errors: result.errors || [] };
    }
    if (!store.getSettings().launchGame) return { launched: false, code, shared };
    try {
      await shell.openExternal(STEAM_LAUNCH_URL); // fixed address, never built from outside input
    } catch (err) {
      throw new Error(`Join code ${code} copied, but Steam couldn't be opened. Start WARDOGS yourself and paste the code.`);
    }
    return { launched: true, code, shared };
  });

  // ----- squad presence -----

  handle('squad:create', async (a) => {
    const made = newSquad(str(a.squadName, 40));
    const settings = store.saveSettings({ squadCode: made.squadCode, squadKey: made.squadKey });
    return { squad: made, settings };
  });

  handle('squad:invite', async () => {
    const s = store.getSettings();
    if (!s.squadApiUrl) throw new Error('Add your website address first, then create or join a squad.');
    if (!s.squadCode || !s.squadKey) throw new Error('Create a squad first, or paste an invite you were sent.');
    return { invite: makeInvite({ apiUrl: s.squadApiUrl, squadCode: s.squadCode, squadKey: s.squadKey }) };
  });

  handle('squad:join', async (a) => {
    const invite = readInvite(str(a.line, 2000) || '');
    const settings = store.saveSettings({
      squadApiUrl: invite.apiUrl, squadCode: invite.squadCode, squadKey: invite.squadKey, squadApiOn: true,
    });
    return { settings };
  });

  /** Save squad settings, checking the web address and webhook look right. */
  handle('squad:save', async (a) => {
    const patch = {};
    if (a.name != null) patch.squadName = cleanName(a.name);
    if (a.apiUrl != null) patch.squadApiUrl = a.apiUrl ? checkApiUrl(a.apiUrl) : '';
    if (a.webhook != null) patch.squadWebhook = a.webhook ? checkWebhook(a.webhook) : '';
    if (a.code != null) patch.squadCode = str(a.code, 40) || '';
    if (a.key != null) patch.squadKey = str(a.key, 80) || '';
    if (a.apiOn != null) patch.squadApiOn = Boolean(a.apiOn);
    if (a.discordOn != null) patch.squadDiscordOn = Boolean(a.discordOn);
    if (a.announce != null) patch.squadAnnounce = Boolean(a.announce);
    return { settings: store.saveSettings(patch) };
  });

  handle('squad:roster', async (a) => squad.getRoster(Boolean(a.force)));
  handle('squad:leave', async () => squad.leave());

  handle('clipboard:write', async (a) => { clipboard.writeText(str(a.text, 80) || ''); return {}; });
  handle('link:open', async (a) => { openExternalSafe(str(a.url, 500)); return {}; });

  handle('window:minimize', async () => { if (win) win.minimize(); return {}; });
  handle('window:maximize', async () => {
    if (win) { if (win.isMaximized()) win.unmaximize(); else win.maximize(); }
    return {};
  });
  handle('window:close', async () => { if (win) win.close(); return {}; });
}

app.on('window-all-closed', () => app.quit());
