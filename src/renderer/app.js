/*
 * RedMarks Wardogs Server Browser - screen logic (1.1.0)
 *
 * Data comes from the Wardog Servers public API through the main process.
 * The whole server list is downloaded once per refresh and filtered here.
 *
 * Safety note for anyone editing: server names and other text from the
 * internet are ALWAYS placed with textContent (via el()), never innerHTML,
 * so a server called "<script>..." is shown as plain text.
 */

(() => {
'use strict';

// Wrapped in its own scope: Electron already puts "rm" on the page, so
// declaring it again at the top level would stop the script from starting.
const rm = window.rm;

const PAGE_SIZE = 150;
const SOURCE_URL = 'https://wardogservers.com/';

// ============================================================
//  State
// ============================================================

const S = {
  view: 'servers',
  builtView: null,
  serverType: 'official',           // Servers tab switch
  settings: { homeRegion: '', refreshMinutes: 5, hidePassworded: false, onlyWithSpace: false, hideEmpty: false, launchGame: true },
  favourites: [],                   // [{ key: joinCode, name, region, official }]
  servers: [],                      // every server right now (slim objects from main)
  byCode: new Map(),                // join code -> server
  snapshotStale: false,
  snapshotError: '',
  loaded: false,
  typeSeries: null,                 // { t, series: { official, community } }
  regionSeries: null,               // { t, series: { <region>: [...] } }
  pings: new Map(),
  selected: null,                   // { code, name, region, type }
  live: null,                       // live detail of the selected server
  history: null,
  detailWindow: '24h',
  detailError: '',
  detailLoading: false,
  filters: { official: { q: '', region: '' }, community: { q: '', region: '' }, fav: { q: '', region: '' } },
  sort: {
    official: { col: 'players', dir: -1 },
    community: { col: 'players', dir: -1 },
    fav: { col: 'players', dir: -1 },
  },
  shown: { official: PAGE_SIZE, community: PAGE_SIZE },
  squad: { members: [], error: '', loading: false, at: 0 },
  lastRefresh: 0,
  nextRefresh: 0,
  refreshing: false,
  autoPicked: false,
  migrating: false,
};

// ============================================================
//  Small helpers
// ============================================================

/** Build an element. props: class, text, title, attrs{}, style{}, on{event:fn} */
function el(tag, props, ...kids) {
  const e = document.createElement(tag);
  const p = props || {};
  if (p.class) e.className = p.class;
  if (p.text != null) e.textContent = String(p.text);
  if (p.title) e.title = p.title;
  if (p.attrs) for (const [k, v] of Object.entries(p.attrs)) if (v != null) e.setAttribute(k, String(v));
  if (p.style) Object.assign(e.style, p.style); // CSSOM styles are allowed by the page's security policy
  if (p.on) for (const [k, fn] of Object.entries(p.on)) e.addEventListener(k, fn);
  for (const k of kids.flat()) if (k != null && k !== false) e.append(k instanceof Node ? k : String(k));
  return e;
}
const icon = (name, cls) => el('i', { class: `ti ti-${name}${cls ? ' ' + cls : ''}`, attrs: { 'aria-hidden': 'true' } });
const $ = (id) => document.getElementById(id);
const fmtNum = (n) => (Number.isFinite(n) ? Math.round(n).toLocaleString() : '–');

function ago(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '–';
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 48) return m % 60 ? `${h} h ${m % 60} min ago` : `${h} h ago`;
  return `${Math.floor(h / 24)} days ago`;
}

const REGION_NAMES = {
  'asia-east': 'Asia (East)', 'asia-southeast': 'Asia (Southeast)', 'asia-west': 'Asia (West)',
  'eu-central': 'Europe (Central)', 'eu-east': 'Europe (East)', 'eu-south': 'Europe (South)', 'eu-west': 'Europe (West)',
  'na-central': 'North America (Central)', 'na-east': 'North America (East)', 'na-north': 'North America (North)',
  'na-west': 'North America (West)', 'oceania': 'Oceania', 'south-america': 'South America',
  // labels saved by version 1.0.x
  'oce': 'Oceania', 'sa': 'South America',
};
function regionName(code) {
  if (!code) return 'Unknown';
  const c = String(code).toLowerCase();
  if (REGION_NAMES[c]) return REGION_NAMES[c];
  return c.split(/[-_|]/).filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');
}

function rangeText(r) {
  if (!r || (r.min == null && r.max == null)) return 'Any';
  const min = r.min || 0;
  if (!r.max && !min) return 'Any';
  if (!r.max) return `${fmtNum(min)}+`;
  return `${fmtNum(min)}–${fmtNum(r.max)}`;
}

function toast(message, isError) {
  const t = el('div', { class: `toast${isError ? ' error' : ''}`, text: message });
  $('toasts').append(t);
  setTimeout(() => t.remove(), isError ? 7000 : 5000);
}

const isFav = (code) => S.favourites.some((f) => f.key === code);
const isLegacyKey = (key) => String(key).includes('|');

// ============================================================
//  Data loading
// ============================================================

async function loadSettings() {
  const r = await rm.settingsGet();
  if (r.ok) S.settings = r.settings;
}

async function loadFavourites() {
  const r = await rm.favList();
  if (r.ok) S.favourites = r.favourites;
}

async function loadSnapshot() {
  const r = await rm.snapshot();
  if (r.ok) {
    S.servers = r.data.servers || [];
    S.byCode = new Map(S.servers.filter((s) => s.code).map((s) => [s.code, s]));
    S.snapshotStale = Boolean(r.data.stale);
    S.snapshotError = '';
    S.loaded = true;
    for (const f of S.favourites) {
      const s = S.byCode.get(f.key);
      if (s) rm.favTouch({ key: f.key, name: s.name, region: s.region });
    }
    await migrateOldFavourites();
  } else {
    S.snapshotError = r.error;
  }
  fillRegionSelects();
  renderStats();
  renderResults();
}

async function loadSeries() {
  const [a, b] = await Promise.all([rm.series({ group: 'type' }), rm.series({ group: 'region' })]);
  if (a.ok) S.typeSeries = a.data;
  if (b.ok) S.regionSeries = b.data;
  if (S.view === 'servers' || S.view === 'regions') renderResults();
}

/** Turn { t:[unix s], series:{k:[...]}} into chart points for one key. */
function seriesPoints(data, key) {
  if (!data || !Array.isArray(data.t) || !data.series || !Array.isArray(data.series[key])) return [];
  const vals = data.series[key];
  const pts = [];
  data.t.forEach((t, i) => { if (vals[i] != null) pts.push([Number(t) * 1000, Number(vals[i])]); });
  return pts;
}

/**
 * Favourites saved by version 1.0.x used a different kind of key. Match them
 * to a live server by name and region; if exactly one matches, switch the
 * favourite to that server's join code.
 */
async function migrateOldFavourites() {
  if (S.migrating) return;
  const old = S.favourites.filter((f) => isLegacyKey(f.key));
  if (!old.length) return;
  S.migrating = true;
  let upgraded = 0;
  for (const f of old) {
    const name = String(f.name || '').trim().toLowerCase();
    if (!name) continue;
    let matches = S.servers.filter((s) => s.code && s.name.trim().toLowerCase() === name);
    if (matches.length > 1 && f.region) matches = matches.filter((s) => regionName(s.region) === regionName(f.region));
    if (matches.length !== 1) continue;
    const m = matches[0];
    const r = await rm.favReplace({ oldKey: f.key, key: m.code, name: m.name, region: m.region, official: m.type === 'official' });
    if (r.ok) { S.favourites = r.favourites; upgraded++; }
  }
  S.migrating = false;
  if (upgraded) toast(`Updated ${upgraded} saved favourite${upgraded > 1 ? 's' : ''} to the new server list.`);
}

async function loadSquad(force) {
  if (!S.settings.squadApiOn) { S.squad = { members: [], error: '', loading: false, at: 0 }; return; }
  S.squad.loading = true;
  if (S.view === 'squad') renderResults();
  const r = await rm.squadRoster({ force: Boolean(force) });
  S.squad.loading = false;
  if (r.ok) { S.squad.members = r.members || []; S.squad.error = ''; S.squad.at = Date.now(); }
  else S.squad.error = r.error;
  if (S.view === 'squad') renderResults();
}

async function loadDetail() {
  const sel = S.selected;
  if (!sel) return;
  S.detailLoading = true;
  S.detailError = '';
  if (S.view === 'detail') renderResults();

  const [live, hist] = await Promise.all([
    S.byCode.has(sel.code) ? rm.server({ code: sel.code }) : Promise.resolve({ ok: false, offline: true }),
    rm.history({ code: sel.code, window: S.detailWindow }),
  ]);
  if (sel !== S.selected) return; // user picked another server meanwhile
  S.detailLoading = false;
  S.live = live.ok ? live.data : null;
  if (hist.ok) S.history = hist.data;
  else {
    S.history = null;
    // A 404 here just means history hasn't been recorded yet.
    if (!/not found/i.test(hist.error || '')) S.detailError = hist.error;
  }
  if (S.view === 'detail') renderResults();
}

/** Ask for a region's ping estimate once; the main process caches it. */
function pingFor(region) {
  if (!region) return undefined;
  if (!S.pings.has(region)) {
    S.pings.set(region, 'pending');
    rm.pingRegion({ region }).then((r) => {
      S.pings.set(region, r.ok ? r.ms : null);
      renderStats();
      if (S.view !== 'detail') scheduleRender();
    });
  }
  const v = S.pings.get(region);
  return v === 'pending' ? undefined : v;
}
const pingText = (ms) => (ms == null ? '–' : `~${ms} ms`);

let renderTimer = null;
function scheduleRender() {
  if (renderTimer) return;
  renderTimer = setTimeout(() => { renderTimer = null; renderResults(); }, 300);
}

function allRegionCodes() {
  const set = new Set(S.servers.map((s) => s.region).filter(Boolean));
  S.favourites.forEach((f) => f.region && set.add(f.region));
  return [...set].sort((a, b) => regionName(a).localeCompare(regionName(b)));
}

/** First run: pick the home region with the lowest ping, then tell the user. */
async function autoPickHomeRegion() {
  if (S.settings.homeRegion || S.autoPicked || !S.servers.length) return;
  S.autoPicked = true;
  let best = null;
  for (const code of allRegionCodes()) {
    const r = await rm.pingRegion({ region: code });
    if (r.ok) {
      S.pings.set(code, r.ms);
      if (r.ms != null && (!best || r.ms < best.ms)) best = { code, ms: r.ms };
    }
  }
  if (best && !S.settings.homeRegion) {
    const s = await rm.settingsSave({ homeRegion: best.code });
    if (s.ok) S.settings = s.settings;
    toast(`Home region set to ${regionName(best.code)}, your closest. You can change it in settings.`);
    fillRegionSelects();
    renderStats();
    if (S.view !== 'detail') renderResults();
  }
}

async function refreshAll() {
  if (S.refreshing) return;
  S.refreshing = true;
  $('btn-refresh').classList.add('spin');
  await Promise.allSettled([loadSnapshot(), loadSeries(), loadSquad(true)]);
  if (S.selected && S.view === 'detail') await loadDetail();
  S.lastRefresh = Date.now();
  S.nextRefresh = S.lastRefresh + S.settings.refreshMinutes * 60000;
  S.refreshing = false;
  $('btn-refresh').classList.remove('spin');
  renderStats();
  renderStatus();
  autoPickHomeRegion();
}

// ============================================================
//  Actions
// ============================================================

async function toggleFavourite(server) {
  const code = server.code;
  if (!code) { toast('This server has no join code yet, so it can\'t be saved. Try again after the next refresh.', true); return; }
  if (isFav(code)) {
    const r = await rm.favRemove({ key: code });
    if (r.ok) { S.favourites = r.favourites; toast(`Removed ${server.name} from favourites`); }
    else toast(r.error, true);
  } else {
    const r = await rm.favAdd({ key: code, name: server.name, region: server.region, official: server.type === 'official' });
    if (r.ok) { S.favourites = r.favourites; toast(`Added ${server.name} to favourites`); }
    else toast(r.error, true);
  }
  renderStats();
  renderResults();
}

async function removeFavouriteKey(key, name) {
  const r = await rm.favRemove({ key });
  if (r.ok) { S.favourites = r.favourites; toast(`Removed ${name || 'server'} from favourites`); }
  renderStats();
  renderResults();
}

async function addByCode(input, button) {
  const typed = input.value.trim();
  if (!typed) { toast('Type or paste a join code first. You\'ll find it in the in-game server browser.', true); input.focus(); return; }
  const c = await rm.cleanCode({ code: typed });
  const code = c.ok ? c.code : '';
  if (!code) { toast('That doesn\'t look like a WARDOGS join code. Official codes are numbers; community codes look like 4f263f2b-c918-….', true); return; }
  if (isFav(code)) { toast('That server is already in your favourites'); input.value = ''; return; }

  button.disabled = true;
  let server = S.byCode.get(code);
  if (!server) {
    const f = await rm.find({ code });
    if (f.ok && f.data) server = { code: f.data.code, name: f.data.name || `Server ${code}`, region: f.data.region, type: f.data.type };
  }
  button.disabled = false;
  if (!server) { toast('No server found with that join code. Check it, or try again once the server is online.', true); return; }

  const r = await rm.favAdd({ key: server.code, name: server.name, region: server.region, official: server.type === 'official' });
  if (!r.ok) { toast(r.error, true); return; }
  S.favourites = r.favourites;
  input.value = '';
  toast(S.byCode.has(server.code) ? `Added ${server.name} to favourites` : `Added ${server.name} to favourites. It's offline right now.`);
  renderStats();
  renderResults();
}

/** Join: copy the join code and (if enabled) start WARDOGS through Steam. */
async function joinServer(server, quiet) {
  const r = await rm.join({ code: server.code, serverName: server.name, region: server.region, quiet: Boolean(quiet) });
  if (!r.ok) { toast(r.error, true); return; }
  const full = server.max && server.players >= server.max;
  const fullNote = full ? ' This server is full right now, so you may be put in a queue.' : '';
  if (r.launched) toast(`Join code copied. WARDOGS is starting: press Deploy, then Community, then Join By ID, and paste with Ctrl+V.${fullNote}`);
  else toast(`Join code copied. In game: Deploy, Community, Join By ID, then paste with Ctrl+V.${fullNote}`);

  const shared = r.shared;
  if (shared) {
    if (shared.api) { S.squad.at = 0; loadSquad(true); }
    const where = [shared.api ? 'your squad' : null, shared.discord ? 'Discord' : null].filter(Boolean).join(' and ');
    if (where) toast(`Told ${where} where you're heading.`);
    (shared.errors || []).forEach((e) => toast(`Squad: ${e}`, true));
  }
}

function openDetail(server) {
  if (!server.code) { toast('This server has no join code yet, so its details aren\'t available. Try again after the next refresh.', true); return; }
  S.selected = { code: server.code, name: server.name, region: server.region, type: server.type };
  S.live = null;
  S.history = null;
  switchView('detail');
  loadDetail();
}

async function copyCode(code) {
  await rm.copy({ text: code });
  toast('Join code copied');
}

// ============================================================
//  Rendering: frame
// ============================================================

function switchView(view) {
  S.view = view;
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('on', t.dataset.view === view));
  buildView();
}

function renderStats() {
  if (S.loaded) {
    $('stat-players').textContent = fmtNum(S.servers.reduce((n, s) => n + s.players, 0));
    $('stat-servers').textContent = fmtNum(S.servers.length);
  }
  const current = S.favourites.filter((f) => !isLegacyKey(f.key));
  const online = current.filter((f) => S.byCode.has(f.key)).length;
  $('stat-favs').textContent = current.length ? `${online} / ${current.length}` : '0';

  const home = S.settings.homeRegion;
  $('stat-ping-label').textContent = home ? `${regionName(home)} ping (est.)` : 'Region ping (est.)';
  $('stat-ping').textContent = home ? pingText(pingFor(home)) : 'Finding…';
}

function renderStatus() {
  const box = $('status-text');
  box.textContent = '';
  box.append(icon('circle-check'), ' ');
  if (!S.lastRefresh) { box.append('Loading…'); return; }
  const left = Math.max(0, Math.round((S.nextRefresh - Date.now()) / 1000));
  const mm = Math.floor(left / 60);
  const ss = String(left % 60).padStart(2, '0');
  box.append(`Updated ${ago(S.lastRefresh)}, next refresh in ${mm}:${ss}`);
  if (S.snapshotStale) box.append(el('span', { class: 'accent', text: ' (the server list source is running behind)' }));
  if (S.snapshotError && S.loaded) box.append(el('span', { class: 'accent', text: ` (last refresh failed: ${S.snapshotError})` }));
}

function buildView() {
  const view = $('view');
  view.textContent = '';
  view.scrollTop = 0;
  S.builtView = S.view;
  if (S.view === 'servers') view.append(serversToolbar());
  if (S.view === 'squad' && S.settings.squadApiOn) loadSquad(false);
  if (S.view === 'fav') view.append(favToolbar());
  view.append(el('div', { attrs: { id: 'results' } }));
  fillRegionSelects();
  renderResults();
}

function renderResults() {
  const box = $('results');
  if (!box || S.builtView !== S.view) return;
  box.textContent = '';
  if (S.view === 'servers') box.append(serversResults());
  else if (S.view === 'fav') box.append(favResults());
  else if (S.view === 'regions') box.append(regionsResults());
  else if (S.view === 'squad') box.append(squadResults());
  else box.append(detailResults());
}

function regionSelect(filterKey) {
  return el('select', {
    attrs: { 'data-region-select': filterKey, 'aria-label': 'Region' },
    on: { change: (e) => { S.filters[filterKey].region = e.target.value; resetPaging(); renderResults(); } },
  });
}

function fillRegionSelects() {
  const codes = allRegionCodes();
  document.querySelectorAll('[data-region-select]').forEach((sel) => {
    const key = sel.dataset.regionSelect;
    const current = S.filters[key].region;
    sel.textContent = '';
    sel.append(el('option', { text: 'All regions', attrs: { value: '' } }));
    codes.forEach((c) => sel.append(el('option', { text: regionName(c), attrs: { value: c } })));
    if (current && !codes.includes(current)) sel.append(el('option', { text: regionName(current), attrs: { value: current } }));
    sel.value = current;
  });
  const home = $('set-home');
  if (home) {
    home.textContent = '';
    home.append(el('option', { text: 'Pick automatically', attrs: { value: '' } }));
    codes.forEach((c) => home.append(el('option', { text: regionName(c), attrs: { value: c } })));
    home.value = S.settings.homeRegion || '';
  }
}

function resetPaging() { S.shown.official = PAGE_SIZE; S.shown.community = PAGE_SIZE; }

function searchBox(filterKey, placeholder) {
  const input = el('input', {
    class: 'input',
    attrs: { type: 'search', placeholder, 'aria-label': 'Search' },
    on: { input: (e) => { S.filters[filterKey].q = e.target.value; resetPaging(); renderResults(); } },
  });
  input.value = S.filters[filterKey].q;
  return el('div', { class: 'search' }, icon('search'), input);
}

function toggleChip(label, iconName, settingKey) {
  const chip = el('button', {
    class: `chip${S.settings[settingKey] ? ' on' : ''}`,
    on: {
      click: async () => {
        const r = await rm.settingsSave({ [settingKey]: !S.settings[settingKey] });
        if (r.ok) S.settings = r.settings;
        document.querySelectorAll(`[data-chip="${settingKey}"]`).forEach((c) => c.classList.toggle('on', S.settings[settingKey]));
        resetPaging();
        renderResults();
      },
    },
    attrs: { 'data-chip': settingKey },
  }, icon(iconName), label);
  return chip;
}

function filterChips() {
  return [
    toggleChip('Has space', 'users', 'onlyWithSpace'),
    toggleChip('Hide empty', 'user-off', 'hideEmpty'),
    toggleChip('Hide locked', 'lock', 'hidePassworded'),
  ];
}

/** Table with clickable, sortable headers. cols: [{id, label, width, sort:false, cls}] */
function table(tabKey, cols, rows) {
  const sort = S.sort[tabKey];
  const head = el('tr', null, cols.map((c) => {
    const th = el('th', { class: `${c.sort === false ? 'nosort' : ''} ${c.cls || ''}`, style: c.width ? { width: c.width } : null }, c.label);
    if (c.sort !== false) {
      if (sort.col === c.id) th.append(' ', icon(sort.dir > 0 ? 'arrow-up' : 'arrow-down'));
      th.addEventListener('click', () => {
        if (sort.col === c.id) sort.dir = -sort.dir;
        else { sort.col = c.id; sort.dir = c.defaultDir || 1; }
        renderResults();
      });
    }
    return th;
  }));
  return el('table', { class: 'list' }, el('thead', null, head), el('tbody', null, rows));
}

function sortRows(list, tabKey, getters) {
  const { col, dir } = S.sort[tabKey];
  const get = getters[col];
  if (!get) return list;
  return list.slice().sort((a, b) => {
    const va = get(a); const vb = get(b);
    const na = va == null || va === ''; const nb = vb == null || vb === '';
    if (na !== nb) return na ? 1 : -1; // blanks always last
    if (typeof va === 'string') return va.localeCompare(vb) * dir;
    return (va - vb) * dir;
  });
}

const SERVER_SORT = {
  name: (s) => s.name.toLowerCase(),
  map: (s) => (s.map || '').toLowerCase() || null,
  mode: (s) => (s.mode || '').toLowerCase() || null,
  region: (s) => regionName(s.region),
  players: (s) => (s.offline ? null : s.players),
  ping: (s) => pingFor(s.region),
};

function applyFilters(list, f) {
  const q = f.q.trim().toLowerCase();
  if (q) {
    list = list.filter((s) => s.name.toLowerCase().includes(q) ||
      (s.code && s.code.toLowerCase().includes(q)) ||
      (s.map && s.map.toLowerCase().includes(q)) ||
      regionName(s.region).toLowerCase().includes(q));
  }
  if (f.region) list = list.filter((s) => s.region === f.region);
  if (S.settings.onlyWithSpace) list = list.filter((s) => !s.offline && s.max > 0 && s.players < s.max);
  if (S.settings.hideEmpty) list = list.filter((s) => s.offline || s.players > 0);
  if (S.settings.hidePassworded) list = list.filter((s) => !s.locked);
  return list;
}

function starButton(server) {
  const on = server.code && isFav(server.code);
  return el('button', {
    class: `star-btn${on ? ' on' : ''}`,
    title: on ? 'Remove from favourites' : 'Add to favourites',
    attrs: { 'aria-label': on ? 'Remove from favourites' : 'Add to favourites' },
    on: { click: (e) => { e.stopPropagation(); toggleFavourite(server); } },
  }, icon('star'));
}

function playersCell(s) {
  if (s.offline) return el('td', { class: 'dim', text: 'Offline' });
  const pct = s.max ? Math.min(100, Math.round((s.players / s.max) * 100)) : 0;
  let label;
  if (s.players === 0) label = el('span', { class: 'tag-empty', text: `Empty (0 / ${s.max})` });
  else if (s.max && s.players >= s.max) label = el('span', { class: 'tag-full', text: `Full (${s.players} / ${s.max})` });
  else label = `${s.players} / ${s.max}`;
  const bar = el('div', { class: 'bar' }, el('span', { style: { width: `${pct}%` } }));
  return el('td', { title: `${s.players} of ${s.max} players` }, label, bar);
}

function joinButton(server, big) {
  if (!server || server.offline || !server.code) {
    return big ? null : el('span', { class: 'dim', title: server && server.offline ? 'Offline' : 'No join code yet', text: '–' });
  }
  return el('button', {
    class: `btn primary join-btn${big ? '' : ' small'}`,
    title: 'Copy the join code and start WARDOGS',
    on: { click: (e) => { e.stopPropagation(); joinServer(server); } },
  }, icon('player-play'), big ? 'Join server' : 'Join');
}

function rulesetBadges(s) {
  return (s.rulesets || []).filter((r) => r !== 'standard').map((r) =>
    el('span', { class: 'badge', text: r === 'infantry-only' ? 'Infantry only' : r[0].toUpperCase() + r.slice(1) }));
}

function emptyState(iconName, title, textLine, action) {
  return el('div', { class: 'empty' }, icon(iconName), el('h3', { text: title }), el('p', { text: textLine }), action || null);
}

function retryButton() {
  return el('button', { class: 'btn', on: { click: refreshAll } }, icon('refresh'), 'Try again');
}

/** The shared server table used by Servers and Favourites. */
function serverTable(list, tabKey, options) {
  const opts = options || {};
  const rows = list.map((s) => {
    const nameCell = el('td', { class: 'name-cell', title: s.name },
      s.name, ' ',
      s.type === 'official' && opts.showType ? el('span', { class: 'badge official', text: 'Official' }) : null, ' ',
      rulesetBadges(s),
      s.legacy ? el('span', { class: 'badge', text: 'Add again by join code' }) : null);
    const star = s.legacy
      ? el('button', { class: 'star-btn on', title: 'Remove', attrs: { 'aria-label': 'Remove' }, on: { click: (e) => { e.stopPropagation(); removeFavouriteKey(s.key, s.name); } } }, icon('star'))
      : starButton(s);
    return el('tr', {
      class: s.offline ? 'offline' : '',
      title: s.legacy ? 'Saved by an older version' : 'Show server details',
      on: { click: () => { if (!s.legacy) openDetail(s); } },
    },
    el('td', null, star),
    nameCell,
    el('td', { text: s.offline ? '–' : (s.map || '–') }),
    el('td', { class: 'sub', text: s.offline ? '–' : (s.mode || '–') }),
    el('td', { class: 'sub', text: regionName(s.region) }),
    playersCell(s),
    el('td', { class: 'num', text: pingText(pingFor(s.region)) }),
    el('td', { title: s.locked ? 'Password needed' : 'No password' }, s.offline ? '' : icon(s.locked ? 'lock' : 'lock-open', s.locked ? 'accent' : '')),
    el('td', { class: 'join-cell' }, joinButton(s)),
    );
  });
  return table(tabKey, [
    { id: 'star', label: '', width: '40px', sort: false },
    { id: 'name', label: 'Server' },
    { id: 'map', label: 'Map', width: '11%' },
    { id: 'mode', label: 'Mode', width: '13%' },
    { id: 'region', label: 'Region', width: '15%' },
    { id: 'players', label: 'Players', width: '15%', defaultDir: -1 },
    { id: 'ping', label: 'Ping (est.)', width: '9%', cls: 'num' },
    { id: 'lock', label: '', width: '36px', sort: false },
    { id: 'join', label: '', width: '86px', sort: false },
  ], rows);
}

// ============================================================
//  Tab: Servers (Official / Community switch)
// ============================================================

function serverTypeSwitch() {
  const options = [
    ['official', 'Official servers', 'shield'],
    ['community', 'Community servers', 'users-group'],
  ];
  return el('div', { class: 'type-switch', attrs: { role: 'group', 'aria-label': 'Server type' } },
    options.map(([id, label, ic]) => el('button', {
      class: S.serverType === id ? 'on' : '',
      attrs: { 'aria-pressed': S.serverType === id },
      on: { click: () => { if (S.serverType !== id) { S.serverType = id; buildView(); } } },
    }, icon(ic), label)));
}

function serversToolbar() {
  const key = S.serverType;
  return el('div', { class: 'toolbar' },
    serverTypeSwitch(),
    searchBox(key, 'Search name, map, region or join code'),
    regionSelect(key),
    filterChips(),
  );
}

function typeSummary(type) {
  const list = S.servers.filter((s) => s.type === type);
  const players = list.reduce((n, s) => n + s.players, 0);
  const all = S.servers.reduce((n, s) => n + s.players, 0);
  const withSpace = list.filter((s) => s.max > 0 && s.players < s.max).length;
  const label = type === 'official' ? 'Official' : 'Community';
  const card = (k, v) => el('div', { class: 'stat' }, el('div', { class: 'stat-label', text: k }), el('div', { class: 'stat-value', text: v }));
  return el('div', { class: 'mini-stats' },
    card(`${label} players now`, fmtNum(players)),
    card(`${label} servers online`, fmtNum(list.length)),
    card('Servers with space', fmtNum(withSpace)),
    card('Share of all players', all ? `${Math.round((players / all) * 100)}%` : '–'),
  );
}

function serversResults() {
  if (!S.loaded) {
    if (S.snapshotError) return emptyState('alert-triangle', 'Couldn\'t load the server list', S.snapshotError, retryButton());
    return emptyState('refresh', 'Loading servers…', 'Fetching every official and community server.');
  }
  const type = S.serverType;
  const all = S.servers.filter((s) => s.type === type);
  let list = applyFilters(all, S.filters[type]);
  list = sortRows(list, type, SERVER_SORT);

  const parts = [typeSummary(type)];
  const shown = list.slice(0, S.shown[type]);
  parts.push(el('div', { class: 'list-head' },
    el('span', { class: 'section-title', style: { margin: '0' } }, icon(type === 'official' ? 'shield' : 'users-group'),
      ` ${type === 'official' ? 'Official' : 'Community'} servers`),
    el('span', { class: 'dim', text: list.length === all.length ? `${fmtNum(all.length)} servers` : `${fmtNum(list.length)} of ${fmtNum(all.length)} servers match` })));

  if (!list.length) {
    parts.push(emptyState('filter', 'No servers match', 'Clear the search, pick another region, or turn off a filter.'));
    return el('div', null, parts);
  }
  parts.push(serverTable(shown, type));
  if (list.length > shown.length) {
    parts.push(el('div', { class: 'more-row' },
      el('span', { class: 'dim', text: `Showing ${fmtNum(shown.length)} of ${fmtNum(list.length)}` }),
      el('button', { class: 'btn', on: { click: () => { S.shown[type] += PAGE_SIZE; renderResults(); } } }, icon('chevron-down'), `Show ${Math.min(PAGE_SIZE, list.length - shown.length)} more`)));
  }
  return el('div', null, parts);
}

// ============================================================
//  Tab: Favourites
// ============================================================

/** Join code box + Add server button. */
function addCodeBox() {
  const input = el('input', {
    class: 'input',
    attrs: { placeholder: 'Join code', 'aria-label': 'Join code', maxlength: '80' },
  });
  const button = el('button', { class: 'btn primary', on: { click: () => addByCode(input, button) } }, icon('plus'), 'Add server');
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') addByCode(input, button); });
  return el('div', { class: 'add-box' }, input, button);
}

function favToolbar() {
  return el('div', { class: 'toolbar' },
    addCodeBox(),
    searchBox('fav', 'Search favourites'),
    regionSelect('fav'),
    filterChips(),
  );
}

/** Favourites as server rows: live data when online, saved details when not. */
function favRows() {
  return S.favourites.map((f) => {
    if (isLegacyKey(f.key)) {
      return { key: f.key, legacy: true, offline: true, code: null, name: f.name || 'Saved server', region: f.region, type: f.official ? 'official' : 'community', players: 0, max: 0, rulesets: [] };
    }
    const live = S.byCode.get(f.key);
    if (live) return live;
    return { key: f.key, code: f.key, offline: true, name: f.name || `Server ${f.key}`, region: f.region, type: f.official ? 'official' : 'community', players: 0, max: 0, locked: false, rulesets: [] };
  });
}

function favResults() {
  if (!S.favourites.length) {
    return emptyState('star', 'Add your first server',
      'Star any server in the Servers tab, or paste a join code above and select Add server. Join codes are shown in the in-game server browser.');
  }
  if (!S.loaded) return emptyState('refresh', 'Loading…', 'Checking which of your servers are online.');
  let list = applyFilters(favRows(), S.filters.fav);
  list = sortRows(list, 'fav', SERVER_SORT);
  if (!list.length) return emptyState('filter', 'No favourites match', 'Clear the search or turn off a filter to see them.');
  const parts = [serverTable(list, 'fav', { showType: true })];
  if (S.favourites.some((f) => isLegacyKey(f.key))) {
    parts.push(el('p', { class: 'dim', text: 'Servers marked "Add again by join code" were saved by an older version and couldn\'t be matched automatically. Remove them with the star and add them again.' }));
  }
  return el('div', null, parts);
}

// ============================================================
//  Tab: Regions
// ============================================================

function regionsResults() {
  if (!S.loaded) {
    if (S.snapshotError) return emptyState('alert-triangle', 'Couldn\'t load regions', S.snapshotError, retryButton());
    return emptyState('refresh', 'Loading regions…', 'Counting players in each region.');
  }
  const totals = new Map();
  for (const s of S.servers) {
    const t = totals.get(s.region) || { code: s.region, players: 0, official: 0, community: 0 };
    t.players += s.players;
    t[s.type] += 1;
    totals.set(s.region, t);
  }
  const regions = [...totals.values()].sort((a, b) => b.players - a.players);

  const grid = el('div', { class: 'region-grid' });
  const sparks = [];
  for (const r of regions) {
    const isHome = S.settings.homeRegion === r.code;
    const spark = el('div', { class: 'spark chart' });
    sparks.push([spark, seriesPoints(S.regionSeries, r.code)]);
    const homeBtn = isHome
      ? el('span', { class: 'badge official', text: 'Home region' })
      : el('button', {
        class: 'btn small',
        on: { click: async () => {
          const s = await rm.settingsSave({ homeRegion: r.code });
          if (s.ok) { S.settings = s.settings; fillRegionSelects(); renderStats(); renderResults(); toast(`Home region set to ${regionName(r.code)}`); }
        } },
      }, 'Set as home');
    grid.append(el('div', { class: `card${isHome ? ' home' : ''}` },
      el('h3', null, regionName(r.code), homeBtn),
      el('div', { class: 'big', text: fmtNum(r.players) }),
      el('div', { class: 'row' }, el('span', { text: 'players now' }), el('span', { text: 'last 24 hours' })),
      spark,
      el('div', { class: 'row' }, el('span', { text: `${fmtNum(r.official)} official, ${fmtNum(r.community)} community` })),
      el('div', { class: 'row' }, el('span', { text: 'Ping estimate' }), el('span', { class: 'accent', text: pingText(pingFor(r.code)) })),
    ));
  }
  requestAnimationFrame(() => sparks.forEach(([box, pts]) => window.RMChart.spark(box, pts)));

  const chartBox = el('div', { class: 'chart' });
  const readout = el('div', { class: 'chart-readout' });
  const official = seriesPoints(S.typeSeries, 'official');
  const community = seriesPoints(S.typeSeries, 'community');
  requestAnimationFrame(() => window.RMChart.line(chartBox, official, { readout, unit: 'players on official servers', compare: community, compareUnit: 'on community servers' }));
  return el('div', null, grid,
    el('div', { class: 'section-title' }, icon('chart-line'), ' Players over the last 24 hours'),
    el('div', { class: 'chart-box' },
      el('div', { class: 'legend' },
        el('span', { class: 'key' }, el('i', { class: 'swatch' }), 'Official'),
        el('span', { class: 'key' }, el('i', { class: 'swatch alt' }), 'Community')),
      chartBox, readout));
}

// ============================================================
//  Tab: Squad
// ============================================================

function squadResults() {
  const set = S.settings;
  if (!set.squadApiOn && !set.squadDiscordOn) {
    return emptyState('users-group', 'Share where you\'re heading',
      'Squad presence lets your mates see which server you pressed Join on. Set it up with a Discord channel, or with the Web API on your own website.',
      el('button', { class: 'btn primary', on: { click: () => openSettings('squad') } }, icon('settings'), 'Open settings'));
  }

  const parts = [];
  if (set.squadDiscordOn && !set.squadApiOn) {
    parts.push(el('div', { class: 'card note' },
      el('p', { text: 'Discord announcements are on. The app posts where you\'re heading when you press Join, but it can\'t read Discord back, so your mates appear in the Discord channel rather than here. Turn on the Web API to get a live squad list.' }),
      el('button', { class: 'btn', on: { click: () => openSettings('squad') } }, icon('settings'), 'Settings')));
    return el('div', null, parts);
  }

  if (S.squad.error) {
    parts.push(emptyState('alert-triangle', 'Couldn\'t reach your squad', S.squad.error,
      el('button', { class: 'btn', on: { click: () => loadSquad(true) } }, icon('refresh'), 'Try again')));
    return el('div', null, parts);
  }
  if (!S.squad.members.length) {
    parts.push(emptyState('users-group', S.squad.loading ? 'Checking your squad…' : 'Nobody has checked in yet',
      'Names appear here when someone in your squad presses Join. Entries disappear again after a few hours.'));
  } else {
    parts.push(el('div', { class: 'list-head' },
      el('span', { class: 'section-title', style: { margin: '0' } }, icon('users-group'), ' Your squad'),
      el('span', { class: 'dim', text: `${S.squad.members.length} checked in` })));
    const sorted = S.squad.members.slice().sort((a, b) => b.at - a.at);
    for (const m of sorted) {
      const live = m.code ? S.byCode.get(m.code) : null;
      const stale = Date.now() - m.at > 60 * 60 * 1000;
      const where = el('div', { class: 'where' },
        el('div', { class: 'srv', text: m.serverName || (m.code ? `Join code ${m.code}` : 'Unknown server') }),
        el('div', { class: 'when' },
          `heading there ${ago(m.at)}`,
          m.region ? ` · ${regionName(m.region)}` : '',
          live ? ` · ${live.players} / ${live.max} players${live.map ? ' · ' + live.map : ''}` : (m.code ? ' · that server is offline now' : '')));
      parts.push(el('div', { class: `squad-card${stale ? ' stale' : ''}` },
        el('div', { class: 'who', text: m.name }),
        where,
        live ? el('button', { class: 'btn small', on: { click: () => openDetail(live) } }, icon('chart-line'), 'Details') : null,
        m.code ? joinButton(live || { code: m.code, name: m.serverName, region: m.region }) : null));
    }
  }

  parts.push(el('div', { class: 'note card' },
    el('p', { text: 'Squad mates show the server they pressed Join on, not where they are now: the app never reads the game. Use Steam\'s friends list to drop straight in beside someone already playing.' }),
    el('button', { class: 'btn', on: { click: async () => { const r = await rm.squadLeave(); if (r.ok !== false) { toast('Removed your name from the squad list'); loadSquad(true); } } } }, icon('user-off'), 'Remove me from the list')));
  return el('div', null, parts);
}

// ============================================================
//  Tab: Details
// ============================================================

function info(label, value, extra) {
  return el('div', { class: 'info' }, el('div', { class: 'k', text: label }),
    el('div', { class: 'v', title: typeof value === 'string' ? value : null }, value, extra || null));
}

function historySummary(h) {
  const nums = (a) => a.filter((v) => v != null && Number.isFinite(Number(v))).map(Number);
  const players = nums(h.players);
  const peaks = nums(h.peak);
  const online = nums(h.online);
  const maps = new Map();
  h.map.forEach((m) => { if (m) maps.set(m, (maps.get(m) || 0) + 1); });
  const mapTotal = [...maps.values()].reduce((a, b) => a + b, 0);
  return {
    avg: players.length ? players.reduce((a, b) => a + b, 0) / players.length : null,
    peak: peaks.length ? Math.max(...peaks) : null,
    uptime: online.length ? (online.reduce((a, b) => a + b, 0) / online.length) * 100 : null,
    maps: [...maps.entries()].map(([map, n]) => ({ map, pct: (n / mapTotal) * 100 })).sort((a, b) => b.pct - a.pct),
    points: h.t.map((t, i) => [Number(t) * 1000, h.players[i]]).filter((p) => p[1] != null),
  };
}

function detailResults() {
  const sel = S.selected;
  if (!sel) {
    return emptyState('chart-line', 'Pick a server',
      'Select any server in the Servers or Favourites tab to see its live info, player history and maps.',
      el('button', { class: 'btn', on: { click: () => switchView('servers') } }, icon('list'), 'Open server list'));
  }

  const live = S.live;
  const inList = S.byCode.get(sel.code);
  const h = S.history;
  const name = (live && live.name) || (inList && inList.name) || (h && h.server.name) || sel.name;
  const type = (live && live.type) || (inList && inList.type) || (h && h.server.type) || sel.type;
  const region = (live && live.region) || (inList && inList.region) || (h && h.server.region) || sel.region;
  const online = Boolean(inList);
  const favTarget = { code: sel.code, name, region, type };

  const parts = [el('div', { class: 'detail-head' },
    el('div', null,
      el('h2', { text: name }),
      el('div', null,
        el('span', { class: `badge${type === 'official' ? ' official' : ''}`, text: type === 'official' ? 'Official' : 'Community' }), ' ',
        el('span', { class: 'badge', text: regionName(region) }), ' ',
        el('span', { class: 'badge', text: online ? 'Online' : 'Offline' }), ' ',
        rulesetBadges(live || inList || {}),
      ),
    ),
    el('div', { class: 'detail-actions' },
      joinButton(inList ? (live || inList) : null, true),
      el('button', { class: 'btn', on: { click: () => toggleFavourite(favTarget) } },
        icon('star'), isFav(sel.code) ? 'Remove favourite' : 'Add to favourites'),
    ),
  )];

  const s = live || inList;
  const codeValue = el('span', null, el('span', { class: 'code', text: sel.code, title: sel.code }), ' ',
    el('button', { class: 'icon-btn', title: 'Copy join code', attrs: { 'aria-label': 'Copy join code' }, on: { click: () => copyCode(sel.code) } }, icon('copy')));
  if (s) {
    parts.push(el('div', { class: 'info-grid' },
      info('Players', `${fmtNum(s.players)} / ${fmtNum(s.max)}`),
      info('Map', s.map || '–'),
      info('Mode', s.mode || '–'),
      info('Password', s.locked ? 'Needed' : 'No'),
      info('Level limit', live ? rangeText(live.level) : '…'),
      info('Cash limit', live ? rangeText(live.cash) : '…'),
      info('Ping (est.)', pingText(pingFor(region))),
      info('Game build', live && live.build ? live.build : '–'),
    ));
  }
  parts.push(el('div', { class: 'info-grid' }, el('div', { class: 'info wide' }, el('div', { class: 'k', text: 'Join code' }), el('div', { class: 'v' }, codeValue))));

  if (S.detailLoading && !h) {
    parts.push(el('p', { class: 'dim', text: 'Loading history…' }));
    return el('div', null, parts);
  }
  if (S.detailError) {
    parts.push(el('p', { class: 'error-line', text: S.detailError }), retryButton());
    return el('div', null, parts);
  }
  if (!h) {
    parts.push(el('p', { class: 'dim', text: 'No history has been recorded for this server yet.' }));
    return el('div', null, parts);
  }

  const sum = historySummary(h);
  parts.push(el('div', { class: 'info-grid' },
    info('Average players', sum.avg == null ? '–' : sum.avg.toFixed(1)),
    info('Peak players', fmtNum(sum.peak)),
    info('Uptime', sum.uptime == null ? '–' : `${Math.round(sum.uptime)}%`),
    info('First seen', h.server.firstSeen ? ago(Date.parse(h.server.firstSeen)) : '–'),
    info('Last seen', online ? 'Online now' : (h.server.lastSeen ? ago(Date.parse(h.server.lastSeen)) : '–')),
  ));

  const seg = el('div', { class: 'seg', attrs: { role: 'group', 'aria-label': 'Time range' } },
    [['24h', '24 hours'], ['7d', '7 days'], ['30d', '30 days'], ['90d', '90 days']].map(([w, label]) => el('button', {
      class: S.detailWindow === w ? 'on' : '',
      text: label,
      on: { click: () => { if (S.detailWindow !== w) { S.detailWindow = w; loadDetail(); } } },
    })),
  );
  const chartBox = el('div', { class: 'chart' });
  const readout = el('div', { class: 'chart-readout' });
  const mapsCard = el('div', { class: 'card' }, el('div', { class: 'section-title', style: { marginTop: '0' } }, icon('map-pin'), ' Maps played'));
  if (!sum.maps.length) mapsCard.append(el('p', { class: 'dim', text: 'No map history yet.' }));
  sum.maps.forEach((m) => {
    const pct = Math.round(m.pct);
    mapsCard.append(el('div', { class: 'map-row' },
      el('span', { text: m.map }),
      el('div', { class: 'bar' }, el('span', { style: { width: `${pct}%` } })),
      el('span', { class: 'num', text: `${pct}%` })));
  });

  parts.push(el('div', { class: 'two-col' },
    el('div', { class: 'chart-box' },
      el('div', { class: 'toolbar', style: { justifyContent: 'space-between', marginBottom: '6px' } },
        el('span', { class: 'section-title', style: { margin: '0' } }, icon('users'), ' Players over time'), seg),
      chartBox, readout),
    mapsCard,
  ));
  const cap = s && s.max ? s.max : undefined;
  requestAnimationFrame(() => window.RMChart.line(chartBox, sum.points, { readout, unit: 'players', yMax: cap }));
  return el('div', null, parts);
}

// ============================================================
//  Settings panel
// ============================================================

/** Settings has three pages so it always fits, even on a small window. */
function showSettingsPage(which) {
  for (const name of ['general', 'squad', 'about']) {
    document.getElementById(`set-page-${name}`).hidden = name !== which;
    document.getElementById(`set-tab-${name}`).classList.toggle('on', name === which);
  }
  const body = document.querySelector('.panel-body');
  if (body) body.scrollTop = 0;
}

function openSettings(page) {
  fillRegionSelects();
  $('set-refresh').value = String(S.settings.refreshMinutes);
  $('set-launch').checked = S.settings.launchGame;
  $('squad-name').value = S.settings.squadName || '';
  $('squad-webhook').value = S.settings.squadWebhook || '';
  $('squad-url').value = S.settings.squadApiUrl || '';
  $('squad-code').value = S.settings.squadCode || '';
  $('squad-key').value = S.settings.squadKey || '';
  $('squad-discord-on').checked = S.settings.squadDiscordOn;
  $('squad-api-on').checked = S.settings.squadApiOn;
  $('squad-announce').checked = S.settings.squadAnnounce;
  showSettingsPage(page === 'squad' ? 'squad' : 'general');
  $('settings').hidden = false;
}
function closeSettings() { $('settings').hidden = true; }

// ============================================================
//  Start up
// ============================================================

function wireFrame() {
  document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => switchView(t.dataset.view)));
  $('btn-refresh').addEventListener('click', refreshAll);
  $('btn-settings').addEventListener('click', () => openSettings());
  $('btn-min').addEventListener('click', () => rm.minimize());
  $('btn-max').addEventListener('click', () => rm.maximize());
  $('btn-close').addEventListener('click', () => rm.close());
  rm.onWindowState((st) => {
    const i = $('btn-max').querySelector('.ti');
    i.className = `ti ti-${st.maximized ? 'copy' : 'square'}`;
  });
  $('link-source').addEventListener('click', (e) => { e.preventDefault(); rm.openLink({ url: SOURCE_URL }); });
  $('stat-ping').addEventListener('click', () => openSettings());

  $('settings-close').addEventListener('click', closeSettings);
  $('settings').addEventListener('click', (e) => { if (e.target.id === 'settings') closeSettings(); });
  $('set-home').addEventListener('change', async (e) => {
    const r = await rm.settingsSave({ homeRegion: e.target.value });
    if (r.ok) S.settings = r.settings;
    if (!S.settings.homeRegion) { S.autoPicked = false; autoPickHomeRegion(); }
    renderStats();
    if (S.view === 'regions') renderResults();
  });
  $('set-launch').addEventListener('change', async (e) => {
    const r = await rm.settingsSave({ launchGame: e.target.checked });
    if (r.ok) S.settings = r.settings;
  });
  $('set-refresh').addEventListener('change', async (e) => {
    const r = await rm.settingsSave({ refreshMinutes: Number(e.target.value) });
    if (r.ok) S.settings = r.settings;
    S.nextRefresh = S.lastRefresh + S.settings.refreshMinutes * 60000;
    renderStatus();
  });

  for (const name of ['general', 'squad', 'about']) {
    $(`set-tab-${name}`).addEventListener('click', () => showSettingsPage(name));
  }
  wireSquadSettings();

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('help').hidden) { $('help').hidden = true; return; }
    if (e.key === 'Escape' && !$('settings').hidden) closeSettings();
    if (e.key === 'F5') { e.preventDefault(); refreshAll(); }
  });

  let resizeTimer;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => { if (S.view === 'detail' || S.view === 'regions') renderResults(); }, 200);
  });
}

/** Save one squad setting and report any problem with what was typed. */
async function saveSquad(patch, okMessage) {
  const r = await rm.squadSave(patch);
  if (!r.ok) { toast(r.error, true); return false; }
  S.settings = r.settings;
  if (okMessage) toast(okMessage);
  return true;
}

function wireSquadSettings() {
  const help = $('help');
  $('squad-help-btn').addEventListener('click', () => { help.hidden = false; });
  $('help-close').addEventListener('click', () => { help.hidden = true; });
  help.addEventListener('click', (e) => { if (e.target.id === 'help') help.hidden = true; });
  const showHelp = (api) => {
    $('help-discord').hidden = api;
    $('help-api').hidden = !api;
    $('help-tab-discord').classList.toggle('on', !api);
    $('help-tab-api').classList.toggle('on', api);
  };
  $('help-tab-discord').addEventListener('click', () => showHelp(false));
  $('help-tab-api').addEventListener('click', () => showHelp(true));

  $('squad-name').addEventListener('change', (e) => saveSquad({ name: e.target.value }));
  $('squad-webhook').addEventListener('change', async (e) => {
    if (!await saveSquad({ webhook: e.target.value })) e.target.value = S.settings.squadWebhook || '';
  });
  $('squad-url').addEventListener('change', async (e) => {
    if (!await saveSquad({ apiUrl: e.target.value })) e.target.value = S.settings.squadApiUrl || '';
  });
  $('squad-code').addEventListener('change', (e) => saveSquad({ code: e.target.value }));
  $('squad-key').addEventListener('change', (e) => saveSquad({ key: e.target.value }));
  $('squad-announce').addEventListener('change', (e) => saveSquad({ announce: e.target.checked }));

  $('squad-discord-on').addEventListener('change', async (e) => {
    const on = e.target.checked;
    if (on && !$('squad-webhook').value.trim()) { toast('Paste your Discord webhook link first.', true); e.target.checked = false; return; }
    if (on && !$('squad-name').value.trim()) { toast('Type the name you want your mates to see.', true); e.target.checked = false; return; }
    await saveSquad({ discordOn: on });
  });
  $('squad-api-on').addEventListener('change', async (e) => {
    const on = e.target.checked;
    if (on && !$('squad-url').value.trim()) { toast('Add your website address first. The guide shows how.', true); e.target.checked = false; return; }
    if (on && !$('squad-name').value.trim()) { toast('Type the name you want your mates to see.', true); e.target.checked = false; return; }
    if (!await saveSquad({ apiOn: on })) { e.target.checked = !on; return; }
    loadSquad(true);
  });

  $('squad-create').addEventListener('click', async () => {
    const r = await rm.squadCreate({ squadName: '' });
    if (!r.ok) { toast(r.error, true); return; }
    S.settings = r.settings;
    $('squad-code').value = S.settings.squadCode;
    $('squad-key').value = S.settings.squadKey;
    toast('Squad created. Put the same key into config.php on your website, then send mates the invite line.');
  });
  $('squad-copy-invite').addEventListener('click', async () => {
    const r = await rm.squadInvite();
    if (!r.ok) { toast(r.error, true); return; }
    await rm.copy({ text: r.invite });
    toast('Invite line copied. Send it privately: it contains your squad key.');
  });
  $('squad-paste-invite').addEventListener('click', async () => {
    const line = $('squad-invite-in').value.trim();
    if (!line) { toast('Paste the invite line into the box above first.', true); $('squad-invite-in').focus(); return; }
    const r = await rm.squadJoin({ line });
    if (!r.ok) { toast(r.error, true); return; }
    S.settings = r.settings;
    $('squad-invite-in').value = '';
    openSettings();
    toast('Squad joined. Type your name above if you haven\'t already.');
    loadSquad(true);
  });
}

async function main() {
  wireFrame();
  const appInfo = await rm.appInfo();
  if (appInfo.ok) $('about-version').textContent = `Version ${appInfo.version}`;
  await Promise.all([loadSettings(), loadFavourites()]);
  switchView(S.favourites.length ? 'fav' : 'servers');
  renderStats();
  refreshAll();

  // Clock: updates the countdown and triggers the scheduled refresh.
  setInterval(() => {
    renderStatus();
    if (S.lastRefresh && !S.refreshing && Date.now() >= S.nextRefresh) refreshAll();
  }, 1000);
}

main();
})();
