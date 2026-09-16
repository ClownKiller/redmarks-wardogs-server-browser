'use strict';
// Run with: npm test   (also runs automatically on GitHub before each build)

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { WardogsApi, cleanCode, retryAfterMs, MAX_PER_MINUTE } = require('../src/main/api');
const { regionGroup } = require('../src/main/ping');
const { Store, MAX_FAVOURITES } = require('../src/main/store');

/** A fake clock + fake internet, so tests run instantly and offline. */
function harness(responder) {
  let now = 1_000_000;
  const calls = [];
  const api = new WardogsApi({
    userAgent: 'test',
    now: () => now,
    sleep: async (ms) => { now += ms; },
    fetchImpl: async (url, opts) => {
      calls.push({ url, at: now, opts });
      const r = responder(url, calls.length);
      return {
        ok: r.status >= 200 && r.status < 300,
        status: r.status,
        headers: { get: (h) => (r.headers || {})[h] },
        json: async () => r.body,
      };
    },
  });
  return { api, calls, advance: (ms) => { now += ms; }, time: () => now };
}

const okServer = () => ({ status: 200, body: { server: { serverKey: 'id|abc', name: 'Test' }, rank: null } });

test('builds the right URL and sends a user agent', async () => {
  const h = harness(okServer);
  const r = await h.api.getServer({ code: ' 740-878 ' });
  assert.strictEqual(h.calls[0].url, 'https://wardogserverlist.com/api/server?code=740-878');
  assert.strictEqual(h.calls[0].opts.headers['User-Agent'], 'test');
  assert.strictEqual(r.data.server.name, 'Test');
  assert.strictEqual(r.cached, false);
});

test('second ask within the cache time does not hit the network', async () => {
  const h = harness(okServer);
  await h.api.getServer({ key: 'id|abc' });
  h.advance(60 * 1000);
  const r = await h.api.getServer({ key: 'id|abc' });
  assert.strictEqual(h.calls.length, 1);
  assert.strictEqual(r.cached, true);
  h.advance(4 * 60 * 1000);
  await h.api.getServer({ key: 'id|abc' });
  assert.strictEqual(h.calls.length, 2, 'refetches once the cache expires');
});

test('identical requests at the same moment share one network call', async () => {
  const h = harness(okServer);
  await Promise.all([h.api.getServer({ key: 'id|abc' }), h.api.getServer({ key: 'id|abc' })]);
  assert.strictEqual(h.calls.length, 1);
});

test('never more than the limit per minute, and at least 1 s apart', async () => {
  const h = harness(okServer);
  const jobs = [];
  for (let i = 0; i < 45; i++) jobs.push(h.api.getServer({ key: `id|${i}` }));
  await Promise.all(jobs);
  assert.strictEqual(h.calls.length, 45);
  for (let i = 1; i < h.calls.length; i++) {
    assert.ok(h.calls[i].at - h.calls[i - 1].at >= 1000, 'gap of at least 1 s');
  }
  for (let i = 0; i < h.calls.length; i++) {
    const inWindow = h.calls.filter((c) => c.at > h.calls[i].at - 60000 && c.at <= h.calls[i].at).length;
    assert.ok(inWindow <= MAX_PER_MINUTE, `at most ${MAX_PER_MINUTE} in any minute (saw ${inWindow})`);
  }
  assert.ok(MAX_PER_MINUTE <= 30, 'stays well under the owner\'s 60 per minute');
});

test('HTTP 429 pauses all requests for Retry-After', async () => {
  const h = harness((url, n) => (n === 1 ? { status: 429, headers: { 'Retry-After': '30' } } : okServer()));
  await assert.rejects(h.api.getServer({ key: 'id|a' }), /slow down/);
  const before = h.time();
  await h.api.getServer({ key: 'id|b' });
  assert.ok(h.calls[1].at - before >= 29000, 'waited for the pause');
});

test('friendly errors for 404, server errors and no internet', async () => {
  let h = harness(() => ({ status: 404 }));
  await assert.rejects(h.api.getServer({ code: '1' }), /not found/);
  h = harness(() => ({ status: 503 }));
  await assert.rejects(h.api.getLeaderboard(), /503/);
  const offline = new WardogsApi({ userAgent: 't', fetchImpl: async () => { throw new Error('ENOTFOUND'); } });
  await assert.rejects(offline.getLeaderboard(), /internet connection/);
});

test('errors are not cached', async () => {
  const h = harness((url, n) => (n === 1 ? { status: 500 } : okServer()));
  await assert.rejects(h.api.getServer({ key: 'id|x' }));
  const r = await h.api.getServer({ key: 'id|x' });
  assert.strictEqual(r.data.server.name, 'Test');
});

test('unknown time windows fall back to safe defaults', async () => {
  const h = harness(() => ({ status: 200, body: {} }));
  await h.api.getTotals('999d');
  await h.api.getServerDetail({ key: 'id|a', window: 'bogus' });
  assert.match(h.calls[0].url, /window=24h/);
  assert.match(h.calls[1].url, /window=7d/);
});

test('join code and Retry-After helpers', () => {
  assert.strictEqual(cleanCode('ab-12 <x>'), 'ab-12x');
  assert.strictEqual(cleanCode(' 740878 '), '740878');
  assert.strictEqual(cleanCode('4f263f2b-c918-4edc-9797-d05e2469fbf3'), '4f263f2b-c918-4edc-9797-d05e2469fbf3', 'long codes keep their dashes');
  assert.strictEqual(retryAfterMs('20'), 20000);
  assert.strictEqual(retryAfterMs(undefined), 60000);
  assert.strictEqual(retryAfterMs('1'), 5000, 'minimum 5 s');
  assert.strictEqual(retryAfterMs('99999'), 600000, 'maximum 10 min');
});

test('region codes map to the right part of the world', () => {
  assert.strictEqual(regionGroup('eu-west'), 'eu-west');
  assert.strictEqual(regionGroup('eu-central'), 'eu-central');
  assert.strictEqual(regionGroup('na-east'), 'na-east');
  assert.strictEqual(regionGroup('na-west'), 'na-west');
  assert.strictEqual(regionGroup('asia-east'), 'asia-east');
  assert.strictEqual(regionGroup('asia-west'), 'asia-west');
  assert.strictEqual(regionGroup('oce'), 'oce');
  assert.strictEqual(regionGroup('oceania'), 'oce');
  assert.strictEqual(regionGroup('sa'), 'sa');
  assert.strictEqual(regionGroup('south-america'), 'sa');
  assert.strictEqual(regionGroup('mars'), null);
  assert.strictEqual(regionGroup(''), null);
});

test('favourites and settings save and load', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rm-'));
  const store = new Store(dir);
  assert.deepStrictEqual(store.listFavourites(), []);
  store.addFavourite({ key: 'id|1', name: 'One', region: 'oce' });
  store.addFavourite({ key: 'id|1', name: 'Dupe', region: 'oce' });
  assert.strictEqual(store.listFavourites().length, 1, 'no duplicates');
  store.touchFavourite('id|1', 'Renamed', 'oce');
  assert.strictEqual(new Store(dir).listFavourites()[0].name, 'Renamed', 'survives a restart');
  store.removeFavourite('id|1');
  assert.strictEqual(store.listFavourites().length, 0);

  for (let i = 0; i < MAX_FAVOURITES; i++) store.addFavourite({ key: `id|${i}` });
  assert.throws(() => store.addFavourite({ key: 'id|extra' }), /up to/);

  assert.strictEqual(store.getSettings().refreshMinutes, 5);
  assert.strictEqual(store.getSettings().launchGame, true, 'Join starts the game by default');
  store.saveSettings({ launchGame: false });
  assert.strictEqual(store.getSettings().launchGame, false);
  store.saveSettings({ refreshMinutes: 1, homeRegion: 'oce', sneaky: true });
  const s = store.getSettings();
  assert.strictEqual(s.refreshMinutes, 5, 'faster than 5 minutes is refused');
  assert.strictEqual(s.homeRegion, 'oce');
  assert.strictEqual(s.sneaky, undefined, 'unknown settings are ignored');

  fs.writeFileSync(path.join(dir, 'favourites.json'), '{broken');
  assert.deepStrictEqual(store.listFavourites(), [], 'a damaged file does not crash the app');
});
