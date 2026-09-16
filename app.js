/*
 * RedMarks Wardogs Server Browser - screen logic
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

// ============================================================
//  State
// ============================================================

const S = {
  view: 'top',
  builtView: null,
  settings: { homeRegion: '', refreshMinutes: 5, hidePassworded: false, onlyWithSpace: false },
  favourites: [],
  live: new Map(),          // serverKey -> { server, error, at }
  leaderboard: null,
  leaderboardError: '',
  totals: null,
  regionSeries: null,
  regionsError: '',
  builds: null,
  pings: new Map(),         // region code -> number | null | 'pending'
  selected: null,           // { key, id, name, region, official }
  detail: null,
  detailWindow: '24h',
  detailError: '',
  detailLoading: false,
  filters: { top: { q: '', region: '' }, fav: { q: '', region: '' } },
  sort: { top: { col: 'rank', dir: 1 }, fav: { col: 'players', dir: -1 } },
  lastRefresh: 0,
  nextRefresh: 0,
  refreshing: false,
  autoPicked: false,
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
  if (h < 48) return `${h} h ${m % 60} min ago`;
  return `${Math.floor(h / 24)} days ago`;
}

const REGION_NAMES = {
  'eu-west': 'Europe (West)', 'eu-east': 'Europe (East)', 'eu-central': 'Europe (Central)', 'eu-south': 'Europe (South)',
  'na-west': 'North America (West)', 'na-east': 'North America (East)', 'na-central': 'North America (Central)',
  'na-north': 'North America (North)', 'sa': 'South America', 'asia-east': 'Asia (East)', 'asia-west': 'Asia (West)',
  'oce': 'Oceania',
};
function regionName(code) {
  if (!code) return 'Unknown';
  const c = String(code).toLowerCase();
  if (REGION_NAMES[c]) return REGION_NAMES[c];
  // Codes we haven't seen yet: "eu-north" -> "Eu North"
  return c.split(/[-_|]/).filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');
}

function limitText(pair) {
  if (!Array.isArray(pair) || pair.length !== 2) return 'Any';
  const [min, max] = pair.map(Number);
  if (!min && !max) return 'Any';
  if (!max) return `${fmtNum(min)}+`;
  return `${fmtNum(min)}–${fmtNum(max)}`;
}

function toast(message, isError) {
  const t = el('div', { class: `toast${isError ? ' error' : ''}`, text: message });
  $('toasts').append(t);
  setTimeout(() => t.remove(), isError ? 7000 : 4000);
}

const isFav = (key) => S.favourites.some((f) => f.key === key);

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

async function loadTotals() {
  const r = await rm.totals({ window: '24h' });
  if (r.ok) S.totals = r.data;
  renderStats();
}

async function loadLeaderboard() {
  const r = await rm.leaderboard();
  if (r.ok) { S.leaderboard = r.data; S.leaderboardError = ''; }
  else S.leaderboardError = r.error;
  if (S.view === 'top') renderResults();
}

async function loadRegions() {
  const [r, b] = await Promise.all([rm.regions({ window: '24h' }), rm.builds()]);
  if (r.ok) { S.regionSeries = (r.data && r.data.series) || {}; S.regionsError = ''; }
  else S.regionsError = r.error;
  if (b.ok) S.builds = b.data;
  fillRegionSelects();
  if (S.view === 'regions') renderResults();
}

async function refreshOneFavourite(key) {
  const r = await rm.server({ key });
  if (r.ok && r.data && r.data.server) {
    const s = r.data.server;
    S.live.set(key, { server: s, rank: r.data.rank, at: r.fetchedAt });
    rm.favTouch({ key, name: s.name, region: s.region });
  } else {
    S.live.set(key, { server: null, error: r.ok ? 'Offline' : r.error, at: Date.now() });
  }
  renderStats();
  if (S.view === 'fav') renderResults();
}

async function refreshFavourites() {
  // The main process queues these one at a time within the rate limit.
  await Promise.allSettled(S.favourites.map((f) => refreshOneFavourite(f.key)));
}

async function loadDetail() {
  const sel = S.selected;
  if (!sel) return;
  S.detailLoading = true;
  S.detailError = '';
  if (S.view === 'detail') renderResults();

  let id = sel.id;
  if (sel.official && !id) {
    // Official servers are looked up by their current session id.
    const live = await rm.server({ key: sel.key });
    if (live.ok && live.data.server) id = live.data.server.id;
  }
  const r = await rm.detail(sel.official && id ? { id, window: S.detailWindow } : { key: sel.key, window: S.detailWindow });
  if (sel !== S.selected) return; // user picked another server meanwhile
  S.detailLoading = false;
  if (r.ok) S.detail = r.data;
  else { S.detail = null; S.detailError = r.error; }
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
      if (S.view !== 'detail') renderResults();
    });
  }
  const v = S.pings.get(region);
  return v === 'pending' ? undefined : v;
}
const pingText = (ms) => (ms == null ? '–' : `~${ms} ms`);

function allRegionCodes() {
  const set = new Set();
  if (S.regionSeries) Object.keys(S.regionSeries).forEach((c) => set.add(c));
  if (S.leaderboard) (S.leaderboard.servers || []).forEach((s) => s.region && set.add(s.region));
  S.favourites.forEach((f) => f.region && set.add(f.region));
  return [...set].sort((a, b) => regionName(a).localeCompare(regionName(b)));
}

/** First run: pick the home region with the lowest ping, then tell the user. */
async function autoPickHomeRegion() {
  if (S.settings.homeRegion || S.autoPicked || !S.regionSeries) return;
  S.autoPicked = true;
  let best = null;
  for (const code of Object.keys(S.regionSeries)) {
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
  await Promise.allSettled([loadTotals(), loadLeaderboard(), loadRegions(), refreshFavourites()]);
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

async function toggleFavourite(entry) {
  if (isFav(entry.key)) {
    const r = await rm.favRemove({ key: entry.key });
    if (r.ok) { S.favourites = r.favourites; S.live.delete(entry.key); toast(`Removed ${entry.name || 'server'} from favourites`); }
    else toast(r.error, true);
  } else {
    const r = await rm.favAdd(entry);
    if (r.ok) {
      S.favourites = r.favourites;
      toast(`Added ${entry.name || 'server'} to favourites`);
      refreshOneFavourite(entry.key);
    } else toast(r.error, true);
  }
  renderStats();
  renderResults();
}

async function addByCode(input, button) {
  const code = input.value.trim();
  if (!code) { toast('Type a join code first. You\'ll find it in the in-game server browser.', true); input.focus(); return; }
  button.disabled = true;
  const r = await rm.server({ code });
  button.disabled = false;
  if (!r.ok || !r.data || !r.data.server) {
    toast(r.ok ? 'No server found for that code.' : r.error, true);
    return;
  }
  const s = r.data.server;
  if (isFav(s.serverKey)) { toast(`${s.name} is already in your favourites`); input.value = ''; return; }
  const f = await rm.favAdd({ key: s.serverKey, name: s.name, region: s.region, official: s.official });
  if (!f.ok) { toast(f.error, true); return; }
  S.favourites = f.favourites;
  S.live.set(s.serverKey, { server: s, rank: r.data.rank, at: r.fetchedAt });
  input.value = '';
  toast(`Added ${s.name} to favourites`);
  renderStats();
  renderResults();
}

function openDetail(entry) {
  const live = S.live.get(entry.key);
  S.selected = {
    key: entry.key,
    name: entry.name,
    region: entry.region,
    official: Boolean(entry.official),
    id: live && live.server ? live.server.id : undefined,
  };
  S.detail = null;
  switchView('detail');
  loadDetail();
}

async function copyCode(code) {
  await rm.copy({ text: code });
  toast(`Join code ${code} copied`);
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
  const t = S.totals;
  if (t && Array.isArray(t.cols) && Array.isArray(t.rows) && t.rows.length) {
    const row = t.rows[t.rows.length - 1];
    const col = (name) => { const i = t.cols.indexOf(name); return i >= 0 ? Number(row[i]) || 0 : 0; };
    $('stat-players').textContent = fmtNum(col('offPlayers') + col('comPlayers'));
    $('stat-servers').textContent = fmtNum(col('offServers') + col('comServers'));
  }
  const total = S.favourites.length;
  const online = S.favourites.filter((f) => { const l = S.live.get(f.key); return l && l.server; }).length;
  $('stat-favs').textContent = total ? `${online} / ${total}` : '0';

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
}

/** Build the toolbar for the current tab once, then fill the results area. */
function buildView() {
  const view = $('view');
  view.textContent = '';
  S.builtView = S.view;
  if (S.view === 'top') view.append(topToolbar());
  if (S.view === 'fav') view.append(favToolbar());
  view.append(el('div', { attrs: { id: 'results' } }));
  fillRegionSelects();
  renderResults();
}

function renderResults() {
  const box = $('results');
  if (!box || S.builtView !== S.view) return;
  box.textContent = '';
  if (S.view === 'top') box.append(topResults());
  else if (S.view === 'fav') box.append(favResults());
  else if (S.view === 'regions') box.append(regionsResults());
  else box.append(detailResults());
}

function regionSelect(filterKey) {
  return el('select', {
    attrs: { 'data-region-select': filterKey, 'aria-label': 'Region' },
    on: { change: (e) => { S.filters[filterKey].region = e.target.value; renderResults(); } },
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

function searchBox(filterKey, placeholder) {
  const input = el('input', {
    class: 'input',
    attrs: { type: 'search', placeholder, 'aria-label': 'Search' },
    on: { input: (e) => { S.filters[filterKey].q = e.target.value; renderResults(); } },
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
        chip.classList.toggle('on', S.settings[settingKey]);
        renderResults();
      },
    },
  }, icon(iconName), label);
  return chip;
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

function starButton(entry) {
  const on = isFav(entry.key);
  return el('button', {
    class: `star-btn${on ? ' on' : ''}`,
    title: on ? 'Remove from favourites' : 'Add to favourites',
    attrs: { 'aria-label': on ? 'Remove from favourites' : 'Add to favourites' },
    on: { click: (e) => { e.stopPropagation(); toggleFavourite(entry); } },
  }, icon('star'));
}

function playersCell(s) {
  const players = Number(s.players) || 0;
  const max = Number(s.maxPlayers) || 0;
  const pct = max ? Math.min(100, Math.round((players / max) * 100)) : 0;
  let label;
  if (players === 0) label = el('span', { class: 'tag-empty', text: 'Empty' });
  else if (max && players >= max) label = el('span', { class: 'tag-full', text: 'Full' });
  else label = `${players} / ${max}`;
  const bar = el('div', { class: 'bar' }, el('span', { style: { width: `${pct}%` } }));
  return el('td', { title: `${players} of ${max} players` }, label, bar);
}

function emptyState(iconName, title, text, action) {
  return el('div', { class: 'empty' }, icon(iconName), el('h3', { text: title }), el('p', { text }), action || null);
}

// ============================================================
//  Tab: Top 100
// ============================================================

function topToolbar() {
  return el('div', { class: 'toolbar' },
    searchBox('top', 'Search server name'),
    regionSelect('top'),
  );
}

function topResults() {
  if (!S.leaderboard) {
    if (S.leaderboardError) return emptyState('alert-triangle', 'Couldn\'t load the top 100', S.leaderboardError, retryButton());
    return emptyState('refresh', 'Loading the top 100…', 'Fetching the most popular community servers.');
  }
  const f = S.filters.top;
  const q = f.q.trim().toLowerCase();
  let list = (S.leaderboard.servers || []).map((s, i) => ({ ...s, rank: i + 1 }));
  if (q) list = list.filter((s) => String(s.name || '').toLowerCase().includes(q));
  if (f.region) list = list.filter((s) => s.region === f.region);

  list = sortRows(list, 'top', {
    rank: (s) => s.rank, name: (s) => String(s.name || '').toLowerCase(), region: (s) => regionName(s.region),
    avg: (s) => s.avgPlayers, peak: (s) => s.peakPlayers, uptime: (s) => s.uptimePct, ping: (s) => pingFor(s.region),
  });

  if (!list.length) return emptyState('search', 'No servers match', 'Try a different name or region.');

  const rows = list.map((s) => {
    const entry = { key: s.serverKey, name: s.name, region: s.region, official: false };
    return el('tr', { on: { click: () => openDetail(entry) }, title: 'Show server details' },
      el('td', null, starButton(entry)),
      el('td', { class: 'rank', text: `#${s.rank}` }),
      el('td', { class: 'name-cell', text: s.name || 'Unnamed server', title: s.name }),
      el('td', { class: 'sub', text: regionName(s.region) }),
      el('td', { class: 'num', text: Number.isFinite(s.avgPlayers) ? s.avgPlayers.toFixed(1) : '–' }),
      el('td', { class: 'num', text: fmtNum(s.peakPlayers) }),
      el('td', { class: 'num', text: Number.isFinite(s.uptimePct) ? `${Math.round(s.uptimePct)}%` : '–' }),
      el('td', { class: 'num', text: pingText(pingFor(s.region)) }),
    );
  });

  const note = el('p', { class: 'dim', text: 'Ranked by average players over the last 7 days. Click a server for live details, or star it to track it.' });
  return el('div', null, table('top', [
    { id: 'star', label: '', width: '40px', sort: false },
    { id: 'rank', label: 'Rank', width: '70px' },
    { id: 'name', label: 'Server' },
    { id: 'region', label: 'Region', width: '18%' },
    { id: 'avg', label: 'Avg players', width: '11%', cls: 'num', defaultDir: -1 },
    { id: 'peak', label: 'Peak', width: '8%', cls: 'num', defaultDir: -1 },
    { id: 'uptime', label: 'Uptime', width: '9%', cls: 'num', defaultDir: -1 },
    { id: 'ping', label: 'Ping (est.)', width: '10%', cls: 'num' },
  ], rows), note);
}

function retryButton() {
  return el('button', { class: 'btn', on: { click: refreshAll } }, icon('refresh'), 'Try again');
}

// ============================================================
//  Tab: Favourites
// ============================================================

function favToolbar() {
  const input = el('input', {
    class: 'input',
    attrs: { placeholder: 'Join code', 'aria-label': 'Join code', maxlength: '20' },
  });
  const button = el('button', { class: 'btn primary', on: { click: () => addByCode(input, button) } }, icon('plus'), 'Add server');
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') addByCode(input, button); });
  return el('div', { class: 'toolbar' },
    el('div', { class: 'add-box' }, input, button),
    searchBox('fav', 'Search favourites'),
    regionSelect('fav'),
    toggleChip('Has space', 'users', 'onlyWithSpace'),
    toggleChip('Hide locked', 'lock', 'hidePassworded'),
  );
}

function favResults() {
  if (!S.favourites.length) {
    return emptyState('star', 'Add your first server',
      'Type a server\'s join code above and select Add server, or star any server in the Top 100 tab. Join codes are shown in the in-game server browser.');
  }
  const f = S.filters.fav;
  const q = f.q.trim().toLowerCase();
  let list = S.favourites.map((fav) => {
    const l = S.live.get(fav.key);
    return { fav, live: l, s: l && l.server };
  });
  if (q) list = list.filter((x) => String((x.s && x.s.name) || x.fav.name).toLowerCase().includes(q));
  if (f.region) list = list.filter((x) => ((x.s && x.s.region) || x.fav.region) === f.region);
  if (S.settings.onlyWithSpace) list = list.filter((x) => x.s && x.s.players < x.s.maxPlayers);
  if (S.settings.hidePassworded) list = list.filter((x) => !(x.s && x.s.passworded));

  list = sortRows(list, 'fav', {
    name: (x) => String((x.s && x.s.name) || x.fav.name).toLowerCase(),
    map: (x) => (x.s ? String(x.s.map || '') : null),
    mode: (x) => (x.s ? String(x.s.mode || x.s.gameMode || '') : null),
    region: (x) => regionName((x.s && x.s.region) || x.fav.region),
    players: (x) => (x.s ? x.s.players : null),
    ping: (x) => pingFor((x.s && x.s.region) || x.fav.region),
  });

  if (!list.length) return emptyState('filter', 'No favourites match', 'Clear the search or turn off a filter to see them.');

  const rows = list.map(({ fav, live, s }) => {
    const region = (s && s.region) || fav.region;
    const entry = { key: fav.key, name: (s && s.name) || fav.name, region, official: s ? s.official : fav.official };
    const nameCell = el('td', { class: 'name-cell', title: entry.name }, entry.name || 'Unnamed server', ' ',
      entry.official ? el('span', { class: 'badge official', text: 'Official' }) : null);

    if (!live) {
      return el('tr', { on: { click: () => openDetail(entry) } },
        el('td', null, starButton(entry)), nameCell,
        el('td', { class: 'dim', text: 'Checking…', attrs: { colspan: 6 } }));
    }
    if (!s) {
      return el('tr', { class: 'offline', on: { click: () => openDetail(entry) } },
        el('td', null, starButton(entry)), nameCell,
        el('td', { text: live.error === 'Offline' || /not found/i.test(live.error || '') ? 'Offline' : live.error, title: live.error, attrs: { colspan: 2 } }),
        el('td', { text: regionName(region) }),
        el('td', { text: '–' }),
        el('td', { class: 'num', text: '–' }),
        el('td', { text: '' }));
    }
    return el('tr', { on: { click: () => openDetail(entry) }, title: 'Show server details' },
      el('td', null, starButton(entry)),
      nameCell,
      el('td', { text: s.map || '–' }),
      el('td', { class: 'sub', text: s.mode || s.gameMode || '–' }),
      el('td', { class: 'sub', text: regionName(region) }),
      playersCell(s),
      el('td', { class: 'num', text: pingText(pingFor(region)) }),
      el('td', { title: s.passworded ? 'Password needed' : 'No password' }, icon(s.passworded ? 'lock' : 'lock-open', s.passworded ? 'accent' : '')),
    );
  });

  return table('fav', [
    { id: 'star', label: '', width: '40px', sort: false },
    { id: 'name', label: 'Server' },
    { id: 'map', label: 'Map', width: '12%' },
    { id: 'mode', label: 'Mode', width: '14%' },
    { id: 'region', label: 'Region', width: '15%' },
    { id: 'players', label: 'Players', width: '13%', defaultDir: -1 },
    { id: 'ping', label: 'Ping (est.)', width: '10%', cls: 'num' },
    { id: 'lock', label: '', width: '40px', sort: false },
  ], rows);
}

// ============================================================
//  Tab: Regions
// ============================================================

function regionsResults() {
  if (!S.regionSeries) {
    if (S.regionsError) return emptyState('alert-triangle', 'Couldn\'t load regions', S.regionsError, retryButton());
    return emptyState('refresh', 'Loading regions…', 'Fetching player counts for each region.');
  }
  const regions = Object.entries(S.regionSeries).map(([code, pts]) => {
    const clean = (Array.isArray(pts) ? pts : []).filter((p) => Array.isArray(p) && Number.isFinite(p[1]));
    return { code, points: clean, now: clean.length ? clean[clean.length - 1][1] : 0 };
  }).sort((a, b) => b.now - a.now);

  const grid = el('div', { class: 'region-grid' });
  const sparks = [];
  for (const r of regions) {
    const isHome = S.settings.homeRegion === r.code;
    const spark = el('div', { class: 'spark chart' });
    sparks.push([spark, r.points]);
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
      el('div', { class: 'big', text: fmtNum(r.now) }),
      el('div', { class: 'row' }, el('span', { text: 'players now' }), el('span', { text: 'last 24 hours' })),
      spark,
      el('div', { class: 'row' }, el('span', { text: 'Ping estimate' }), el('span', { class: 'accent', text: pingText(pingFor(r.code)) })),
    ));
  }
  // Draw sparklines after the cards are on screen, so they know their width.
  requestAnimationFrame(() => sparks.forEach(([box, pts]) => window.RMChart.spark(box, pts)));

  return el('div', null, grid, buildsSection());
}

function buildsSection() {
  const b = S.builds;
  if (!b || !Array.isArray(b.current) || !b.current.length) return null;
  const current = b.current.slice().sort((x, y) => (y.sharePct || 0) - (x.sharePct || 0));
  let text;
  if (current.length === 1) {
    text = `All servers are on game build ${current[0].cl}.`;
  } else {
    const newest = current.slice().sort((x, y) => (y.cl || 0) - (x.cl || 0))[0];
    text = `An update is rolling out: ${Math.round(newest.sharePct || 0)}% of servers are on the newest build (${newest.cl}).`;
  }
  return el('div', null,
    el('div', { class: 'section-title' }, icon('info-circle'), ' Game version'),
    el('div', { class: 'card' }, el('div', { text }),
      el('div', { class: 'dim', text: `Checked ${ago(b.updatedAt ? Date.parse(b.updatedAt) : 0)}` })),
  );
}

// ============================================================
//  Tab: Details
// ============================================================

function info(label, value, extra) {
  return el('div', { class: 'info' }, el('div', { class: 'k', text: label }),
    el('div', { class: 'v', title: typeof value === 'string' ? value : null }, value, extra || null));
}

function detailResults() {
  const sel = S.selected;
  if (!sel) {
    return emptyState('chart-line', 'Pick a server',
      'Select any server in the Top 100 or Favourites tab to see its live info, player history and maps.',
      el('button', { class: 'btn', on: { click: () => switchView('top') } }, icon('list'), 'Open Top 100'));
  }

  const d = S.detail;
  const live = (d && d.live) || (S.live.get(sel.key) || {}).server || null;
  const name = (live && live.name) || (d && d.name) || sel.name || 'Unnamed server';
  const official = live ? live.official : (d ? d.official : sel.official);
  const region = (live && live.region) || (d && d.region) || sel.region;
  const fav = isFav(sel.key);

  const head = el('div', { class: 'detail-head' },
    el('div', null,
      el('h2', { text: name }),
      el('div', null,
        el('span', { class: `badge${official ? ' official' : ''}`, text: official ? 'Official' : 'Community' }), ' ',
        el('span', { class: 'badge', text: regionName(region) }), ' ',
        el('span', { class: 'badge', text: live ? 'Online' : (d || !S.detailLoading ? 'Offline' : 'Checking…') }),
      ),
    ),
    el('div', { class: 'detail-actions' },
      el('button', { class: `btn${fav ? '' : ' primary'}`, on: { click: () => toggleFavourite({ key: sel.key, name, region, official }) } },
        icon('star'), fav ? 'Remove favourite' : 'Add to favourites'),
    ),
  );

  const parts = [head];

  if (live) {
    const code = live.joinCode;
    const codeValue = code
      ? el('span', null, el('span', { class: 'code', text: code }), ' ',
        el('button', { class: 'icon-btn', title: 'Copy join code', attrs: { 'aria-label': 'Copy join code' }, on: { click: () => copyCode(code) } }, icon('copy')))
      : el('span', { class: 'dim', text: official ? 'Use the in-game list' : 'None' });
    const limits = live.limits || {};
    parts.push(el('div', { class: 'info-grid' },
      info('Players', `${fmtNum(live.players)} / ${fmtNum(live.maxPlayers)}`),
      info('Map', live.map || '–'),
      info('Mode', live.mode || live.gameMode || '–'),
      info('World', live.world || '–'),
      info('Ruleset', live.ruleset || 'Default'),
      info('Join code', codeValue),
      info('Password', live.passworded ? 'Needed' : 'No'),
      info('Level limit', limitText(limits.level)),
      info('Cash limit', limitText(limits.cash)),
      info('Match started', live.matchStart ? ago(live.matchStart) : '–'),
      info('Ping (est.)', pingText(pingFor(region))),
    ));
  }

  if (S.detailLoading && !d) {
    parts.push(el('p', { class: 'dim', text: 'Loading history…' }));
    return el('div', null, parts);
  }
  if (S.detailError) {
    parts.push(el('p', { class: 'error-line', text: S.detailError }), retryButton());
    return el('div', null, parts);
  }
  if (!d) return el('div', null, parts);

  if (d.tracked === false) {
    parts.push(el('p', { class: 'dim', text: 'Official servers only have live info. History is recorded for community servers.' }));
    return el('div', null, parts);
  }

  const sum = d.summary || {};
  const lb = d.leaderboard;
  parts.push(el('div', { class: 'info-grid' },
    info('Average players', Number.isFinite(sum.avgPlayers) ? sum.avgPlayers.toFixed(1) : '–'),
    info('Peak players', fmtNum(sum.peakPlayers)),
    info('Uptime', Number.isFinite(sum.uptimePct) ? `${Math.round(sum.uptimePct)}%` : '–'),
    info('Top 100 rank', lb && lb.rank ? `#${lb.rank}` : 'Not ranked'),
    info('Best rank', d.bestRank ? `#${d.bestRank}` : '–'),
    info('Online since', d.session && d.session.since ? ago(d.session.since) : '–'),
  ));

  const seg = el('div', { class: 'seg', attrs: { role: 'group', 'aria-label': 'Time range' } },
    ['24h', '7d', '30d'].map((w) => el('button', {
      class: S.detailWindow === w ? 'on' : '',
      text: w === '24h' ? '24 hours' : w === '7d' ? '7 days' : '30 days',
      on: { click: () => { if (S.detailWindow !== w) { S.detailWindow = w; loadDetail(); } } },
    })),
  );
  const chartBox = el('div', { class: 'chart' });
  const readout = el('div', { class: 'chart-readout' });
  const mapsCard = el('div', { class: 'card' }, el('div', { class: 'section-title', style: { marginTop: '0' } }, icon('map-pin'), ' Maps played'));
  const maps = (Array.isArray(d.maps) ? d.maps : []).slice().sort((a, b) => (b.pct || 0) - (a.pct || 0));
  if (!maps.length) mapsCard.append(el('p', { class: 'dim', text: 'No map history yet.' }));
  maps.forEach((m) => {
    const pct = Math.round(m.pct || 0);
    mapsCard.append(el('div', { class: 'map-row' },
      el('span', { text: m.map || 'Unknown' }),
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

  const maxPlayers = live && live.maxPlayers ? live.maxPlayers : undefined;
  requestAnimationFrame(() => window.RMChart.line(chartBox, d.players, { readout, unit: 'players', yMax: maxPlayers }));
  return el('div', null, parts);
}

// ============================================================
//  Settings panel
// ============================================================

function openSettings() {
  fillRegionSelects();
  $('set-refresh').value = String(S.settings.refreshMinutes);
  $('settings').hidden = false;
  $('set-home').focus();
}
function closeSettings() { $('settings').hidden = true; }

// ============================================================
//  Start up
// ============================================================

function wireFrame() {
  document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => switchView(t.dataset.view)));
  $('btn-refresh').addEventListener('click', refreshAll);
  $('btn-settings').addEventListener('click', openSettings);
  $('btn-min').addEventListener('click', () => rm.minimize());
  $('btn-max').addEventListener('click', () => rm.maximize());
  $('btn-close').addEventListener('click', () => rm.close());
  rm.onWindowState((s) => {
    const i = $('btn-max').querySelector('.ti');
    i.className = `ti ti-${s.maximized ? 'copy' : 'square'}`;
  });
  $('link-source').addEventListener('click', (e) => { e.preventDefault(); rm.openLink({ url: 'https://wardogserverlist.com/' }); });
  $('stat-ping').addEventListener('click', openSettings);

  $('settings-close').addEventListener('click', closeSettings);
  $('settings').addEventListener('click', (e) => { if (e.target.id === 'settings') closeSettings(); });
  $('set-home').addEventListener('change', async (e) => {
    const r = await rm.settingsSave({ homeRegion: e.target.value });
    if (r.ok) S.settings = r.settings;
    if (!S.settings.homeRegion) { S.autoPicked = false; autoPickHomeRegion(); }
    renderStats();
    if (S.view === 'regions') renderResults();
  });
  $('set-refresh').addEventListener('change', async (e) => {
    const r = await rm.settingsSave({ refreshMinutes: Number(e.target.value) });
    if (r.ok) S.settings = r.settings;
    S.nextRefresh = S.lastRefresh + S.settings.refreshMinutes * 60000;
    renderStatus();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('settings').hidden) closeSettings();
    if (e.key === 'F5') { e.preventDefault(); refreshAll(); }
  });

  // Redraw charts when the window size changes.
  let resizeTimer;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => { if (S.view === 'detail' || S.view === 'regions') renderResults(); }, 200);
  });
}

async function main() {
  wireFrame();
  const info = await rm.appInfo();
  if (info.ok) $('about-version').textContent = `Version ${info.version}`;
  await Promise.all([loadSettings(), loadFavourites()]);
  switchView(S.favourites.length ? 'fav' : 'top');
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
