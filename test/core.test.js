'use strict';
// Run with: npm test   (also runs automatically on GitHub before each build)

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { WardogsApi, cleanCode, isJoinCode, modeLabel, slim, retryAfterMs, MAX_PER_MINUTE } = require('../src/main/api');
const { regionGroup } = require('../src/main/ping');
const { Store, MAX_FAVOURITES } = require('../src/main/store');
const { Squad, newSquad, makeInvite, readInvite, checkApiUrl, checkWebhook, cleanName } = require('../src/main/squad');

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
      const r = responder(url, calls.length, opts);
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

const OFFICIAL = {
  id: '001ab36e-9985-4a9c-8dff-9dc137826dfe', serverId: '0756872', name: 'Official #4', nativeName: 'x',
  type: 'official', region: 'eu-south', players: 100, maxPlayers: 100, reservedPlayers: 0,
  passwordProtected: false, serverNumber: 4, map: { variant: 'Bakurani', base: 'Europe' },
  mode: { experience: 'Bakurani_KOTH_01', gameMode: 'GM_Session_C', modifiers: [] }, rulesets: ['standard'],
};
const snapshotBody = () => ({ status: 200, headers: { ETag: '"v1"' }, body: { data: [OFFICIAL], meta: { stale: false, fetchedAt: '2026-09-16T00:00:00Z' } } });

test('snapshot: right URL, user agent, and slimmed servers', async () => {
  const h = harness(snapshotBody);
  const r = await h.api.getSnapshot();
  assert.strictEqual(h.calls[0].url, 'https://api.wardogservers.com/v1/snapshot');
  assert.strictEqual(h.calls[0].opts.headers['User-Agent'], 'test');
  const s = r.data.servers[0];
  assert.strictEqual(s.code, '0756872', 'leading zeros kept');
  assert.strictEqual(s.type, 'official');
  assert.strictEqual(s.max, 100);
  assert.strictEqual(s.map, 'Bakurani');
  assert.strictEqual(s.mode, 'King of the Hill');
  assert.strictEqual(r.data.stale, false);
});

test('cached for a minute, then asks again with If-None-Match and reuses data on 304', async () => {
  const h = harness((url, n, opts) => (n === 1 ? snapshotBody() : { status: 304, headers: {} }));
  await h.api.getSnapshot();
  await h.api.getSnapshot();
  assert.strictEqual(h.calls.length, 1, 'second ask within a minute is served from memory');
  h.advance(61 * 1000);
  const r = await h.api.getSnapshot();
  assert.strictEqual(h.calls.length, 2);
  assert.strictEqual(h.calls[1].opts.headers['If-None-Match'], '"v1"');
  assert.strictEqual(r.data.servers[0].name, 'Official #4', 'unchanged data kept after 304');
});

test('identical requests at the same moment share one network call', async () => {
  const h = harness(snapshotBody);
  await Promise.all([h.api.getSnapshot(), h.api.getSnapshot()]);
  assert.strictEqual(h.calls.length, 1);
});

test('never more than the limit per minute, and at least 1 s apart', async () => {
  const h = harness(() => ({ status: 200, body: { data: OFFICIAL } }));
  const jobs = [];
  for (let i = 0; i < 45; i++) jobs.push(h.api.getServer(String(1000 + i)));
  await Promise.all(jobs);
  assert.strictEqual(h.calls.length, 45);
  for (let i = 1; i < h.calls.length; i++) assert.ok(h.calls[i].at - h.calls[i - 1].at >= 1000);
  for (let i = 0; i < h.calls.length; i++) {
    const inWindow = h.calls.filter((c) => c.at > h.calls[i].at - 60000 && c.at <= h.calls[i].at).length;
    assert.ok(inWindow <= MAX_PER_MINUTE, `at most ${MAX_PER_MINUTE} in any minute (saw ${inWindow})`);
  }
});

test('HTTP 429 pauses all requests for Retry-After', async () => {
  const h = harness((url, n) => (n === 1 ? { status: 429, headers: { 'Retry-After': '30' } } : snapshotBody()));
  await assert.rejects(h.api.getServer('123'), /slow down/);
  const before = h.time();
  await h.api.getSnapshot();
  assert.ok(h.calls[1].at - before >= 29000, 'waited for the pause');
});

test('friendly errors for 404, 503, other errors and no internet', async () => {
  let h = harness(() => ({ status: 404 }));
  await assert.rejects(h.api.getServer('123'), /offline/);
  h = harness(() => ({ status: 503 }));
  await assert.rejects(h.api.getSnapshot(), /updating/);
  h = harness(() => ({ status: 500 }));
  await assert.rejects(h.api.getSnapshot(), /500/);
  const offline = new WardogsApi({ userAgent: 't', fetchImpl: async () => { throw new Error('ENOTFOUND'); } });
  await assert.rejects(offline.getSnapshot(), /internet connection/);
});

test('bad join codes never reach the network', async () => {
  const h = harness(snapshotBody);
  await assert.rejects(h.api.getServer('../../etc'), /join code/);
  await assert.rejects(h.api.getServerHistory('abc', '24h'), /join code/);
  assert.strictEqual(h.calls.length, 0);
});

test('history, series and lookup build the right URLs', async () => {
  const h = harness((url) => {
    if (url.includes('/v1/history/servers/')) return { status: 200, body: { data: { server: { serverId: '123', name: 'A', type: 'official', region: 'oceania' }, t: [1], players: [5], peak: [6], capacity: [100], online: [1], map: ['Ozeti'] } } };
    if (url.includes('/v1/history/players')) return { status: 200, body: { data: { t: [1], series: { official: [5] } } } };
    return { status: 200, body: { data: [{ serverId: '123', name: 'A', type: 'official', region: 'oceania' }] } };
  });
  const hist = await h.api.getServerHistory('123', 'bogus');
  const series = await h.api.getSeries('type', '24h');
  const found = await h.api.findServer(' 123 ');
  assert.strictEqual(h.calls[0].url, 'https://api.wardogservers.com/v1/history/servers/123?window=24h');
  assert.strictEqual(h.calls[1].url, 'https://api.wardogservers.com/v1/history/players?window=24h&group=type');
  assert.strictEqual(h.calls[2].url, 'https://api.wardogservers.com/v1/history/servers?q=123&limit=1');
  assert.deepStrictEqual(hist.data.map, ['Ozeti']);
  assert.deepStrictEqual(series.data.series.official, [5]);
  assert.strictEqual(found.data.region, 'oceania');
});

test('errors are not cached', async () => {
  const h = harness((url, n) => (n === 1 ? { status: 500 } : snapshotBody()));
  await assert.rejects(h.api.getSnapshot());
  const r = await h.api.getSnapshot();
  assert.strictEqual(r.data.servers.length, 1);
});

test('join codes, mode names and Retry-After helpers', () => {
  assert.strictEqual(cleanCode(' 0756872 '), '0756872');
  assert.strictEqual(cleanCode('740-878'), '740878');
  assert.strictEqual(cleanCode('4F263F2B-C918-4EDC-9797-D05E2469FBF3'), '4f263f2b-c918-4edc-9797-d05e2469fbf3');
  assert.strictEqual(cleanCode('4f263f2bc9184edc9797d05e2469fbf3'), '4f263f2b-c918-4edc-9797-d05e2469fbf3');
  assert.strictEqual(cleanCode('hello'), '');
  assert.strictEqual(cleanCode('<script>'), '');
  assert.ok(isJoinCode('0756872'));
  assert.ok(isJoinCode('4f263f2b-c918-4edc-9797-d05e2469fbf3'));
  assert.ok(!isJoinCode('12; rm'));
  assert.strictEqual(modeLabel({ experience: 'Bakurani_KOTH_01' }), 'King of the Hill');
  assert.strictEqual(modeLabel({ experience: 'Ozeti_Conquest_02' }), 'Conquest');
  assert.strictEqual(modeLabel(null), '');
  assert.strictEqual(slim({ type: 'weird', serverId: 'bad code' }).code, null);
  assert.strictEqual(slim({}).type, 'community');
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
  assert.strictEqual(regionGroup('asia-southeast'), 'asia-southeast');
  assert.strictEqual(regionGroup('na-north'), 'na-north');
  assert.strictEqual(regionGroup('eu-south'), 'eu-south');
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
  store.addFavourite({ key: 'id|2', name: 'Two', region: 'oce' });
  store.replaceFavourite('id|2', { key: '0756872', name: 'Official #4', region: 'eu-south', official: true });
  const upgraded = store.listFavourites().find((f) => f.key === '0756872');
  assert.ok(upgraded && upgraded.official, 'old favourite upgraded to its join code');
  assert.ok(!store.listFavourites().some((f) => f.key === 'id|2'));
  store.removeFavourite('0756872');
  store.removeFavourite('id|1');
  assert.strictEqual(store.listFavourites().length, 0);

  for (let i = 0; i < MAX_FAVOURITES; i++) store.addFavourite({ key: `id|${i}` });
  assert.throws(() => store.addFavourite({ key: 'id|extra' }), /up to/);

  assert.strictEqual(store.getSettings().refreshMinutes, 5);
  assert.strictEqual(store.getSettings().launchGame, true, 'Join starts the game by default');
  assert.strictEqual(store.getSettings().hideEmpty, false);
  store.saveSettings({ launchGame: false });
  assert.strictEqual(store.getSettings().launchGame, false);
  store.saveSettings({ refreshMinutes: 0.5, homeRegion: 'oce', sneaky: true });
  const s = store.getSettings();
  assert.strictEqual(s.refreshMinutes, 5, 'polling faster than the source updates is refused');
  store.saveSettings({ refreshMinutes: 1.5 });
  assert.strictEqual(store.getSettings().refreshMinutes, 1.5, '1.5 minutes is allowed');
  store.saveSettings({ refreshMinutes: 7 });
  assert.strictEqual(store.getSettings().refreshMinutes, 5, 'an unknown value falls back to 5');
  assert.strictEqual(s.homeRegion, 'oce');
  assert.strictEqual(s.sneaky, undefined, 'unknown settings are ignored');

  fs.writeFileSync(path.join(dir, 'favourites.json'), '{broken');
  assert.deepStrictEqual(store.listFavourites(), [], 'a damaged file does not crash the app');
});

// ---------- squad presence ----------

/** A fake squad website + Discord, so these tests run offline. */
function squadHarness(settings, responder) {
  const calls = [];
  const squad = new Squad({
    userAgent: 'test',
    now: () => Date.now(),
    getSettings: () => settings,
    fetchImpl: async (url, opts) => {
      const body = JSON.parse(opts.body);
      calls.push({ url, body });
      const r = (responder || (() => ({ status: 200, body: { ok: true } })))(url, body, calls.length);
      return { ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => r.body };
    },
  });
  return { squad, calls };
}

const SQUAD_SETTINGS = {
  squadName: 'RedMark', squadApiUrl: 'https://example.com/squad/squad.php',
  squadCode: 'ABC123', squadKey: 'KEY1234567890', squadWebhook: 'https://discord.com/api/webhooks/1/abc',
  squadApiOn: true, squadDiscordOn: true,
};

test('an invite line survives a round trip and carries the key', () => {
  const made = newSquad('Dogs of War');
  assert.strictEqual(made.squadCode.length, 6);
  assert.ok(made.squadKey.length >= 16, 'the key is long enough to act as a password');
  const line = makeInvite({ apiUrl: 'https://example.com/squad/squad.php', ...made });
  const back = readInvite(`here you go mate: ${line}  `);
  assert.strictEqual(back.squadCode, made.squadCode);
  assert.strictEqual(back.squadKey, made.squadKey);
  assert.strictEqual(back.apiUrl, 'https://example.com/squad/squad.php');
});

test('bad invites and addresses are refused with plain-English errors', () => {
  assert.throws(() => readInvite('hello'), /isn't a squad invite/);
  assert.throws(() => readInvite('rmwd1:not-base64!!'), /damaged/);
  assert.throws(() => checkApiUrl('http://someone.com/squad.php'), /https/);
  assert.throws(() => checkApiUrl('not a url'), /doesn't look right/);
  assert.throws(() => checkWebhook('https://evil.example/api/webhooks/1/2'), /isn't a Discord webhook/);
  assert.ok(checkWebhook('https://discord.com/api/webhooks/1/abc').startsWith('https://discord.com/'));
  assert.strictEqual(checkApiUrl('http://192.168.0.5/squad.php').startsWith('http://192.168'), true, 'a home network address is allowed');
  assert.strictEqual(cleanName('  <b>Red</b>Mark  '), 'bRed/bMark');
});

test('announcing posts to both the website and Discord', async () => {
  const h = squadHarness({ ...SQUAD_SETTINGS });
  const out = await h.squad.announce({ code: '0712345', name: 'Official #412', region: 'oceania' });
  assert.deepStrictEqual([out.api, out.discord], [true, true]);
  assert.strictEqual(h.calls[0].body.action, 'checkin');
  assert.strictEqual(h.calls[0].body.code, '0712345');
  assert.strictEqual(h.calls[0].body.key, 'KEY1234567890');
  assert.match(h.calls[1].body.content, /RedMark/);
  assert.match(h.calls[1].body.content, /0712345/);
  assert.deepStrictEqual(h.calls[1].body.allowed_mentions, { parse: [] }, 'announcements never ping anyone');
});

test('nothing is shared when squad sharing is switched off', async () => {
  const h = squadHarness({ ...SQUAD_SETTINGS, squadApiOn: false, squadDiscordOn: false });
  const out = await h.squad.announce({ code: '0712345', name: 'A', region: 'oceania' });
  assert.deepStrictEqual([out.api, out.discord], [false, false]);
  assert.strictEqual(h.calls.length, 0, 'no requests at all');
});

test('a server with no join code is never announced', async () => {
  const h = squadHarness({ ...SQUAD_SETTINGS });
  await h.squad.announce({ code: 'nonsense; drop', name: 'A' });
  assert.strictEqual(h.calls.length, 0);
});

test('the same server is not announced twice in a row', async () => {
  const h = squadHarness({ ...SQUAD_SETTINGS });
  await h.squad.announce({ code: '0712345', name: 'A' });
  const again = await h.squad.announce({ code: '0712345', name: 'A' });
  assert.ok(again.skipped, 'repeat suppressed');
  assert.strictEqual(h.calls.length, 2, 'only the first announcement went out');
  await h.squad.announce({ code: '0712999', name: 'B' });
  assert.strictEqual(h.calls.length, 4, 'a different server does announce');
});

test('one side failing does not stop the other', async () => {
  const h = squadHarness({ ...SQUAD_SETTINGS }, (url) => (url.includes('discord') ? { status: 500 } : { status: 200, body: { ok: true } }));
  const out = await h.squad.announce({ code: '0712345', name: 'A' });
  assert.strictEqual(out.api, true);
  assert.strictEqual(out.discord, false);
  assert.match(out.errors[0], /Discord/);
});

test('the roster is cleaned up before the screen sees it', async () => {
  const h = squadHarness({ ...SQUAD_SETTINGS }, () => ({
    status: 200,
    body: { ok: true, members: [
      { name: '<b>Mate</b>', code: '0712345', serverName: 'Official #412', region: 'oceania', ageSeconds: 120 },
      { name: 'Dodgy', code: 'rm -rf /', serverName: 'x', region: 'y', ageSeconds: 0 },
    ] },
  }));
  const r = await h.squad.getRoster(true);
  assert.strictEqual(r.members[0].name, 'bMate/b');
  assert.ok(r.members[0].at < Date.now() - 100000, 'age turned into a time');
  assert.strictEqual(r.members[1].code, null, 'a bogus join code is dropped');
});

test('a refused key gives an error worth reading', async () => {
  const h = squadHarness({ ...SQUAD_SETTINGS }, () => ({ status: 403, body: { ok: false } }));
  await assert.rejects(h.squad.getRoster(true), /refused/);
});

test('squad settings are saved and tidied', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rm-squad-'));
  const store = new Store(dir);
  const s = store.getSettings();
  assert.strictEqual(s.squadApiOn, false);
  assert.strictEqual(s.squadDiscordOn, false);
  assert.strictEqual(s.squadAnnounce, true);
  store.saveSettings({ squadName: 'RedMark', squadKey: 'x'.repeat(400), squadApiOn: 'yes' });
  const after = new Store(dir).getSettings();
  assert.strictEqual(after.squadName, 'RedMark');
  assert.strictEqual(after.squadKey.length, 300, 'over-long values are trimmed');
  assert.strictEqual(after.squadApiOn, true);
});
