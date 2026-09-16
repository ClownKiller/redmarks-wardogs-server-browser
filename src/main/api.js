'use strict';
/*
 * RedMarks Wardogs Server Browser - API client
 *
 * This is the ONLY place the app asks the internet for server data.
 * Source: the free public Wardog Servers API (https://wardogservers.com/devs,
 * contract: https://api.wardogservers.com/openapi.json). It never contacts
 * the game, Bulkhead, or Steam.
 *
 * How this file follows the API owner's guidance:
 *   - "fetch /v1/snapshot once and filter locally"   -> getSnapshot()
 *   - "poll with If-None-Match, 304 = unchanged"     -> ETags are kept per URL
 *   - "do not poll faster than meta.refreshSeconds"  -> every answer is cached
 *                                                        for at least 60 s
 *   - be gentle                                      -> at most 20 requests a
 *                                                        minute, 1 s apart, and a
 *                                                        pause on HTTP 429
 *   - "credit Wardog Servers with a link"            -> shown in the status bar
 */

const BASE_URL = 'https://api.wardogservers.com';
const MAX_PER_MINUTE = 20;
const MIN_GAP_MS = 1000;
const TIMEOUT_MS = 20000;

// How long each kind of answer is kept before asking again (milliseconds).
const TTL = {
  snapshot: 60 * 1000,
  server: 60 * 1000,
  serverHistory: 5 * 60 * 1000,
  series: 5 * 60 * 1000,
  lookup: 5 * 60 * 1000,
};

const SERVER_WINDOWS = ['24h', '7d', '30d', '90d'];
const SERIES_WINDOWS = ['24h', '7d', '30d', '90d', '1y'];
const SERIES_GROUPS = ['total', 'type', 'region'];

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'ApiError';
    this.status = status || 0;
  }
}

/**
 * Join codes: official servers use digits (leading zeros matter),
 * community servers use a UUID like 4f263f2b-c918-4edc-9797-d05e2469fbf3.
 * Returns the tidied code, or '' if it can't be a join code.
 */
function cleanCode(code) {
  const s = String(code == null ? '' : code).trim().replace(/\s+/g, '');
  const hex = s.replace(/-/g, '');
  if (/^[0-9a-fA-F]{32}$/.test(hex) && /[a-fA-F-]/.test(s)) {
    const h = hex.toLowerCase();
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  }
  const digits = s.replace(/[\s-]/g, '');
  return /^[0-9]{1,64}$/.test(digits) ? digits : '';
}

function isJoinCode(code) {
  return typeof code === 'string' && (/^[0-9]{1,64}$/.test(code) || UUID_RE.test(code));
}

/** "Bakurani_KOTH_01" -> "King of the Hill"; unknown names are tidied, not guessed. */
function modeLabel(mode) {
  const raw = (mode && (mode.experience || mode.gameMode)) || '';
  if (!raw) return '';
  if (/koth/i.test(raw)) return 'King of the Hill';
  const parts = String(raw).split('+')[0].split('_').filter((p) => p && !/^\d+$/.test(p));
  if (parts.length > 1) parts.shift(); // first part is usually the map name
  return parts.join(' ') || String(raw);
}

const int = (v) => (Number.isFinite(Number(v)) ? Math.max(0, Math.round(Number(v))) : 0);
const text = (v, max = 120) => (typeof v === 'string' ? v.slice(0, max) : '');

/** One server, reduced to exactly what the screen uses. */
function slim(s) {
  const code = isJoinCode(s && s.serverId) ? s.serverId : null;
  return {
    id: text(s && s.id, 64),
    code,
    name: text(s && s.name) || text(s && s.nativeName) || (code ? `Server ${code.slice(0, 8)}` : 'Unnamed server'),
    type: s && s.type === 'official' ? 'official' : 'community',
    region: text(s && s.region, 40),
    players: int(s && s.players),
    max: int(s && s.maxPlayers),
    locked: Boolean(s && s.passwordProtected),
    number: int(s && s.serverNumber),
    map: text(s && s.map && (s.map.variant || s.map.base), 60) || null,
    mode: text(modeLabel(s && s.mode), 60),
    rulesets: Array.isArray(s && s.rulesets) ? s.rulesets.map((r) => text(r, 30)).filter(Boolean) : ['standard'],
  };
}

function slimDetail(s) {
  const base = slim(s);
  const lvl = (s && s.level) || {};
  const cash = (s && s.cash) || {};
  const numOrNull = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
  base.level = { min: numOrNull(lvl.min), max: numOrNull(lvl.max) };
  base.cash = { min: numOrNull(cash.min), max: numOrNull(cash.max) };
  base.build = text(s && s.build && s.build.changelist, 30) || null;
  return base;
}

class WardogsApi {
  /**
   * @param {object} opts
   * @param {Function} opts.fetchImpl  fetch-compatible function (Electron's net.fetch in the app)
   * @param {string}   opts.userAgent  identifies this app to the API owner
   * @param {Function} [opts.now]      clock, swappable for tests
   * @param {Function} [opts.sleep]    delay, swappable for tests
   */
  constructor({ fetchImpl, userAgent, now, sleep }) {
    this.fetchImpl = fetchImpl;
    this.userAgent = userAgent;
    this.now = now || (() => Date.now());
    this.sleep = sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.cache = new Map();     // url -> { value, etag, expires, fetchedAt, meta }
    this.inFlight = new Map();  // url -> Promise
    this.sentAt = [];
    this.pausedUntil = 0;
    this.chain = Promise.resolve();
  }

  // ---------- public ----------

  /** Every server right now: { data: { servers, stale, sourceTime }, fetchedAt, cached } */
  async getSnapshot() {
    const r = await this._get('/v1/snapshot', {}, TTL.snapshot, (body) => ({
      servers: (Array.isArray(body && body.data) ? body.data : []).map(slim),
      stale: Boolean(body && body.meta && body.meta.stale),
      sourceTime: text(body && body.meta && body.meta.fetchedAt, 40) || null,
    }));
    return r;
  }

  /** Live detail for one server by join code (404 when it's not online). */
  getServer(code) {
    const c = cleanCode(code);
    if (!isJoinCode(c)) return Promise.reject(new ApiError('That doesn\'t look like a WARDOGS join code.'));
    return this._get(`/v1/servers/${encodeURIComponent(c)}`, {}, TTL.server, (body) => slimDetail(body && body.data));
  }

  /** Player history, uptime and maps for one server by join code. */
  getServerHistory(code, window) {
    const c = cleanCode(code);
    if (!isJoinCode(c)) return Promise.reject(new ApiError('That doesn\'t look like a WARDOGS join code.'));
    const w = SERVER_WINDOWS.includes(window) ? window : '24h';
    return this._get(`/v1/history/servers/${encodeURIComponent(c)}`, { window: w }, TTL.serverHistory, (body) => {
      const d = (body && body.data) || {};
      const arr = (a) => (Array.isArray(a) ? a : []);
      const srv = d.server || {};
      return {
        server: {
          code: isJoinCode(srv.serverId) ? srv.serverId : c,
          name: text(srv.name),
          type: srv.type === 'official' ? 'official' : 'community',
          region: text(srv.region, 40),
          firstSeen: text(srv.firstSeen, 40) || null,
          lastSeen: text(srv.lastSeen, 40) || null,
          live: Boolean(srv.live),
        },
        t: arr(d.t), players: arr(d.players), peak: arr(d.peak),
        capacity: arr(d.capacity), online: arr(d.online), map: arr(d.map),
      };
    });
  }

  /** Player totals over time, grouped by type (official/community) or region. */
  getSeries(group, window) {
    const g = SERIES_GROUPS.includes(group) ? group : 'total';
    const w = SERIES_WINDOWS.includes(window) ? window : '24h';
    return this._get('/v1/history/players', { window: w, group: g }, TTL.series, (body) => {
      const d = (body && body.data) || {};
      return { t: Array.isArray(d.t) ? d.t : [], series: d.series && typeof d.series === 'object' ? d.series : {} };
    });
  }

  /** Find a server that may be offline right now, by join code. */
  findServer(code) {
    const c = cleanCode(code);
    if (!isJoinCode(c)) return Promise.reject(new ApiError('That doesn\'t look like a WARDOGS join code.'));
    return this._get('/v1/history/servers', { q: c, limit: 1 }, TTL.lookup, (body) => {
      const hit = Array.isArray(body && body.data) ? body.data[0] : null;
      if (!hit || !isJoinCode(hit.serverId)) return null;
      return {
        code: hit.serverId, name: text(hit.name), region: text(hit.region, 40),
        type: hit.type === 'official' ? 'official' : 'community',
      };
    });
  }

  // ---------- internals ----------

  _url(path, params) {
    const u = new URL(path, BASE_URL);
    for (const [k, v] of Object.entries(params)) u.searchParams.set(k, String(v));
    return u.toString();
  }

  _get(path, params, ttl, shape) {
    const url = this._url(path, params);
    const hit = this.cache.get(url);
    if (hit && hit.expires > this.now()) {
      return Promise.resolve({ data: hit.value, fetchedAt: hit.fetchedAt, cached: true });
    }
    if (this.inFlight.has(url)) return this.inFlight.get(url);
    const job = this.chain.then(() => this._fetchNow(url, ttl, shape));
    this.chain = job.catch(() => {});
    const shared = job.finally(() => this.inFlight.delete(url));
    this.inFlight.set(url, shared);
    return shared;
  }

  async _waitForSlot() {
    for (;;) {
      const t = this.now();
      if (this.pausedUntil > t) { await this.sleep(this.pausedUntil - t); continue; }
      this.sentAt = this.sentAt.filter((s) => t - s < 60000);
      const last = this.sentAt[this.sentAt.length - 1] || 0;
      if (t - last < MIN_GAP_MS) { await this.sleep(MIN_GAP_MS - (t - last)); continue; }
      if (this.sentAt.length >= MAX_PER_MINUTE) { await this.sleep(60000 - (t - this.sentAt[0]) + 50); continue; }
      this.sentAt.push(t);
      return;
    }
  }

  async _fetchNow(url, ttl, shape) {
    const hit = this.cache.get(url);
    if (hit && hit.expires > this.now()) return { data: hit.value, fetchedAt: hit.fetchedAt, cached: true };

    await this._waitForSlot();

    const headers = { Accept: 'application/json', 'User-Agent': this.userAgent };
    if (hit && hit.etag) headers['If-None-Match'] = hit.etag;

    let res;
    try {
      res = await this.fetchImpl(url, { method: 'GET', headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch (err) {
      throw new ApiError('Couldn\'t reach wardogservers.com. Check your internet connection.');
    }
    const header = (h) => (res.headers && res.headers.get ? res.headers.get(h) : null);

    if (res.status === 304 && hit) {
      // Unchanged since last time: keep what we have.
      hit.expires = this.now() + ttl;
      hit.fetchedAt = this.now();
      return { data: hit.value, fetchedAt: hit.fetchedAt, cached: true };
    }
    if (res.status === 429) {
      const wait = retryAfterMs(header('Retry-After'));
      this.pausedUntil = this.now() + wait;
      throw new ApiError(`The server list asked us to slow down. Trying again in ${Math.ceil(wait / 1000)} s.`, 429);
    }
    if (res.status === 404) throw new ApiError('Not found. The server may be offline, or the join code is wrong.', 404);
    if (res.status === 503) throw new ApiError('The server list is updating right now. Try again in a minute.', 503);
    if (!res.ok) throw new ApiError(`The server list returned an error (${res.status}). Try again in a few minutes.`, res.status);

    let body;
    try {
      body = await res.json();
    } catch (err) {
      throw new ApiError('The server list sent something unexpected. Try again in a few minutes.');
    }

    const value = shape ? shape(body) : body;
    const fetchedAt = this.now();
    this.cache.set(url, { value, etag: header('ETag') || null, expires: fetchedAt + ttl, fetchedAt });
    return { data: value, fetchedAt, cached: false };
  }
}

/** Retry-After can be seconds or a date. Default 60 s, 5 s minimum, 10 min maximum. */
function retryAfterMs(value) {
  let ms = 60000;
  if (value != null && value !== '') {
    const secs = Number(value);
    if (Number.isFinite(secs)) ms = secs * 1000;
    else {
      const when = Date.parse(value);
      if (Number.isFinite(when)) ms = when - Date.now();
    }
  }
  return Math.min(Math.max(ms, 5000), 10 * 60 * 1000);
}

module.exports = {
  WardogsApi, ApiError, cleanCode, isJoinCode, modeLabel, slim, retryAfterMs, TTL, MAX_PER_MINUTE, BASE_URL,
};
