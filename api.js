'use strict';
/*
 * RedMarks Wardogs Server Browser - API client
 *
 * This is the ONLY place the app asks the internet for server data.
 * It talks to the free public API at wardogserverlist.com (OpenAPI spec:
 * https://wardogserverlist.com/openapi.json). It never contacts the game,
 * Bulkhead, or Steam.
 *
 * House rules from the API owner, and how this file follows them:
 *   - 60 requests / 60 s per IP  -> we allow at most MAX_PER_MINUTE (20),
 *                                   and space requests at least 1 s apart.
 *   - HTTP 429 + Retry-After     -> we pause the whole queue for that long.
 *   - "Cache on your side, poll no faster than every few minutes"
 *                                -> every endpoint has a cache lifetime of
 *                                   4 minutes or more (see TTL below).
 */

const BASE_URL = 'https://wardogserverlist.com';
const MAX_PER_MINUTE = 20;          // one third of the owner's limit
const MIN_GAP_MS = 1000;            // never fire two requests back to back
const TIMEOUT_MS = 15000;           // give up on a stuck request

// How long each kind of answer is kept before we ask again (milliseconds).
const TTL = {
  server: 4 * 60 * 1000,
  leaderboard: 10 * 60 * 1000,
  detail: 10 * 60 * 1000,
  totals: 10 * 60 * 1000,
  regions: 10 * 60 * 1000,
  builds: 30 * 60 * 1000,
};

const WINDOWS = ['24h', '7d', '30d'];

class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'ApiError';
    this.status = status || 0;
  }
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
    this.cache = new Map();        // url -> { value, expires, fetchedAt }
    this.inFlight = new Map();     // url -> Promise (so duplicate asks share one request)
    this.sentAt = [];              // timestamps of recent requests
    this.pausedUntil = 0;          // set when the API says "slow down"
    this.chain = Promise.resolve(); // one request at a time
  }

  // ---------- public endpoints ----------

  /** Look up one server by its stable key or its in-game join code. */
  getServer({ key, code }) {
    if (key) return this._get('/api/server', { key }, TTL.server);
    if (code) return this._get('/api/server', { code: cleanCode(code) }, TTL.server);
    return Promise.reject(new ApiError('A server key or join code is needed.'));
  }

  /** Top 100 community servers over the last 7 days. */
  getLeaderboard() {
    return this._get('/api/leaderboard', {}, TTL.leaderboard);
  }

  /** Full detail for one server: live entry, player history, maps played. */
  getServerDetail({ key, id, window }) {
    const w = WINDOWS.includes(window) ? window : '7d';
    if (id) return this._get('/api/server-detail', { id, window: w }, TTL.detail);
    if (key) return this._get('/api/server-detail', { key, window: w }, TTL.detail);
    return Promise.reject(new ApiError('A server key or id is needed.'));
  }

  /** Global player and server totals over time. */
  getTotals(window) {
    const w = WINDOWS.includes(window) ? window : '24h';
    return this._get('/api/totals', { window: w }, TTL.totals);
  }

  /** Player totals per region over time. */
  getRegionHistory(window) {
    const w = WINDOWS.includes(window) ? window : '24h';
    return this._get('/api/region-history', { window: w }, TTL.regions);
  }

  /** Game builds; more than one "current" build means an update is rolling out. */
  getBuilds() {
    return this._get('/api/builds', {}, TTL.builds);
  }

  // ---------- internals ----------

  _url(path, params) {
    const u = new URL(path, BASE_URL);
    for (const [k, v] of Object.entries(params)) u.searchParams.set(k, String(v));
    return u.toString();
  }

  /** Returns { data, fetchedAt, cached } */
  _get(path, params, ttl) {
    const url = this._url(path, params);
    const hit = this.cache.get(url);
    if (hit && hit.expires > this.now()) {
      return Promise.resolve({ data: hit.value, fetchedAt: hit.fetchedAt, cached: true });
    }
    if (this.inFlight.has(url)) return this.inFlight.get(url);

    // Queue behind any request already running, so the rate limit is exact.
    const job = this.chain.then(() => this._fetchNow(url, ttl));
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
      if (this.sentAt.length >= MAX_PER_MINUTE) {
        await this.sleep(60000 - (t - this.sentAt[0]) + 50);
        continue;
      }
      this.sentAt.push(t);
      return;
    }
  }

  async _fetchNow(url, ttl) {
    // Another caller may have filled the cache while we waited in the queue.
    const hit = this.cache.get(url);
    if (hit && hit.expires > this.now()) {
      return { data: hit.value, fetchedAt: hit.fetchedAt, cached: true };
    }

    await this._waitForSlot();

    let res;
    try {
      res = await this.fetchImpl(url, {
        method: 'GET',
        headers: { Accept: 'application/json', 'User-Agent': this.userAgent },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      throw new ApiError('Couldn\'t reach wardogserverlist.com. Check your internet connection.');
    }

    if (res.status === 429) {
      const wait = retryAfterMs(res.headers && res.headers.get && res.headers.get('Retry-After'));
      this.pausedUntil = this.now() + wait;
      throw new ApiError(`The server list asked us to slow down. Trying again in ${Math.ceil(wait / 1000)} s.`, 429);
    }
    if (res.status === 404) throw new ApiError('Server not found. Check the join code, or the server may be offline.', 404);
    if (!res.ok) throw new ApiError(`The server list returned an error (${res.status}). Try again in a few minutes.`, res.status);

    let data;
    try {
      data = await res.json();
    } catch (err) {
      throw new ApiError('The server list sent something unexpected. Try again in a few minutes.');
    }

    const fetchedAt = this.now();
    this.cache.set(url, { value: data, expires: fetchedAt + ttl, fetchedAt });
    return { data, fetchedAt, cached: false };
  }
}

/** Join codes are typed by people: keep letters and digits only. */
function cleanCode(code) {
  return String(code).replace(/[^A-Za-z0-9]/g, '').slice(0, 32);
}

/** Retry-After can be seconds or a date. Default 60 s, cap 10 min. */
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

module.exports = { WardogsApi, ApiError, cleanCode, retryAfterMs, TTL, MAX_PER_MINUTE, BASE_URL };
