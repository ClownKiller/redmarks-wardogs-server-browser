'use strict';
/*
 * RedMarks Wardogs Server Browser - squad presence (added in 1.2.0)
 *
 * Lets a group of players see which server each other is heading to.
 * Two independent ways to share, both OFF until the user turns them on:
 *
 *   1. Discord announcements - posts "<name> is heading to <server>" into a
 *      channel through a webhook. Posting only; the app can't read Discord.
 *   2. Web API - a small script on the user's own website. The app posts its
 *      presence there and reads the squad roster back.
 *
 * What is shared: the display name the user chose, the server they pressed
 * Join on (name, region, join code) and the time. Nothing else. The app can
 * NEVER tell which server someone is actually in - that would mean reading the
 * game - so everything is worded as "heading to".
 */

const { isJoinCode } = require('./api');

const INVITE_PREFIX = 'rmwd1:';          // start of an invite line
const DISCORD_MIN_GAP_MS = 2500;         // Discord allows 30 posts a minute per webhook
const REPEAT_WINDOW_MS = 5 * 60 * 1000;  // don't announce the same server twice in a row
const ROSTER_TTL_MS = 60 * 1000;
const TIMEOUT_MS = 15000;

const text = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

/** Display names are shown to other people: keep them plain and short. */
function cleanName(name) {
  return text(String(name == null ? '' : name).replace(/[\u0000-\u001F<>]/g, ''), 24);
}

function randomCode(len) {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no look-alike characters
  const bytes = require('crypto').randomBytes(len);
  let out = '';
  for (const b of bytes) out += alphabet[b % alphabet.length];
  return out;
}

/** A new squad: a code others join with, and a key that acts as its password. */
function newSquad(name) {
  return { squadName: text(name, 40) || 'My squad', squadCode: randomCode(6), squadKey: randomCode(20) };
}

/** One line that carries everything a mate needs to join the squad. */
function makeInvite({ apiUrl, squadCode, squadKey, squadName }) {
  const payload = JSON.stringify({ u: apiUrl, c: squadCode, k: squadKey, n: squadName || '' });
  return INVITE_PREFIX + Buffer.from(payload, 'utf8').toString('base64url');
}

function readInvite(line) {
  const raw = String(line == null ? '' : line).trim();
  const i = raw.indexOf(INVITE_PREFIX);
  if (i < 0) throw new Error('That isn\'t a squad invite. It should start with "rmwd1:".');
  let data;
  try {
    data = JSON.parse(Buffer.from(raw.slice(i + INVITE_PREFIX.length).trim(), 'base64url').toString('utf8'));
  } catch (err) {
    throw new Error('That squad invite looks damaged. Ask for it again and paste the whole line.');
  }
  const apiUrl = checkApiUrl(data && data.u);
  const squadCode = text(data && data.c, 40);
  const squadKey = text(data && data.k, 80);
  if (!squadCode || !squadKey) throw new Error('That squad invite is missing its code or key.');
  return { apiUrl, squadCode, squadKey, squadName: text(data && data.n, 40) };
}

/** Only https (or http on a local network) addresses are accepted. */
function checkApiUrl(value) {
  const raw = text(value, 300);
  if (!raw) throw new Error('A web address for the squad API is needed.');
  let u;
  try {
    u = new URL(raw);
  } catch (err) {
    throw new Error('That web address doesn\'t look right. It should look like https://yoursite.com/squad/squad.php');
  }
  const local = /^(localhost|127\.0\.0\.1|192\.168\.|10\.)/.test(u.hostname);
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local)) {
    throw new Error('The squad API address must start with https:// so your squad details are sent securely.');
  }
  return u.toString();
}

function checkWebhook(value) {
  const raw = text(value, 300);
  if (!raw) return '';
  let u;
  try {
    u = new URL(raw);
  } catch (err) {
    throw new Error('That webhook link doesn\'t look right. Copy it again from Discord.');
  }
  const okHost = u.hostname === 'discord.com' || u.hostname === 'discordapp.com' || u.hostname.endsWith('.discord.com');
  if (u.protocol !== 'https:' || !okHost || !u.pathname.startsWith('/api/webhooks/')) {
    throw new Error('That isn\'t a Discord webhook link. In Discord: Server Settings, Integrations, Webhooks, Copy Webhook URL.');
  }
  return u.toString();
}

class Squad {
  /**
   * @param {object} opts
   * @param {Function} opts.fetchImpl   fetch-compatible function
   * @param {string}   opts.userAgent
   * @param {Function} opts.getSettings returns the saved settings
   * @param {Function} [opts.now]
   */
  constructor({ fetchImpl, userAgent, getSettings, now }) {
    this.fetchImpl = fetchImpl;
    this.userAgent = userAgent;
    this.getSettings = getSettings;
    this.now = now || (() => Date.now());
    this.lastDiscordAt = 0;
    this.lastAnnounced = { code: '', at: 0 };
    this.roster = { members: [], at: 0 };
  }

  settings() {
    const s = this.getSettings() || {};
    return {
      name: cleanName(s.squadName),
      apiUrl: text(s.squadApiUrl, 300),
      code: text(s.squadCode, 40),
      key: text(s.squadKey, 80),
      webhook: text(s.squadWebhook, 300),
      useApi: Boolean(s.squadApiOn),
      useDiscord: Boolean(s.squadDiscordOn),
    };
  }

  /** Tidy up one presence entry coming back from the Web API. */
  static cleanMember(m, nowMs) {
    const code = typeof m.code === 'string' && isJoinCode(m.code) ? m.code : null;
    const age = Number(m.ageSeconds);
    return {
      name: cleanName(m.name) || 'Someone',
      code,
      serverName: text(m.serverName, 80),
      region: text(m.region, 40),
      at: Number.isFinite(age) ? nowMs - age * 1000 : nowMs,
    };
  }

  async _send(url, body) {
    let res;
    try {
      res = await this.fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'User-Agent': this.userAgent },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      throw new Error('Couldn\'t reach your squad website. Check the address, or try again later.');
    }
    return res;
  }

  /** Tell the squad which server this player is heading to. */
  async announce(server, options) {
    const opts = options || {};
    const s = this.settings();
    const code = server && isJoinCode(server.code) ? server.code : null;
    if (!code) return { api: false, discord: false };
    if (!s.useApi && !s.useDiscord) return { api: false, discord: false };
    if (!opts.force && this.lastAnnounced.code === code && this.now() - this.lastAnnounced.at < REPEAT_WINDOW_MS) {
      return { api: false, discord: false, skipped: 'Already announced that server a moment ago.' };
    }

    const entry = {
      name: s.name || 'Someone',
      code,
      serverName: text(server.name, 80),
      region: text(server.region, 40),
    };
    const out = { api: false, discord: false, errors: [] };

    if (s.useApi && s.apiUrl && s.code && s.key) {
      try {
        const res = await this._send(s.apiUrl, { action: 'checkin', squad: s.code, key: s.key, ...entry });
        const body = await res.json().catch(() => null);
        if (!res.ok || !body || body.ok !== true) throw new Error((body && body.error) || `Your squad website replied with an error (${res.status}).`);
        out.api = true;
        this.roster.at = 0; // roster changed
      } catch (err) {
        out.errors.push(err.message);
      }
    }

    if (s.useDiscord && s.webhook) {
      try {
        const wait = DISCORD_MIN_GAP_MS - (this.now() - this.lastDiscordAt);
        if (wait > 0) await new Promise((r) => setTimeout(r, wait));
        const where = entry.serverName || `join code ${code}`;
        const line = `**${entry.name}** is heading to **${where}**` +
          (entry.region ? ` (${entry.region})` : '') +
          `\nJoin code: \`${code}\`  -  in game: Deploy, Community, Join By ID`;
        const res = await this._send(s.webhook, { content: line, allowed_mentions: { parse: [] } });
        this.lastDiscordAt = this.now();
        if (res.status === 429) throw new Error('Discord asked us to slow down. The next announcement will work.');
        if (!res.ok && res.status !== 204) throw new Error(`Discord replied with an error (${res.status}). Check the webhook link.`);
        out.discord = true;
      } catch (err) {
        out.errors.push(err.message);
      }
    }

    if (out.api || out.discord) this.lastAnnounced = { code, at: this.now() };
    return out;
  }

  /** Who else is out there? Web API only; Discord can't be read back. */
  async getRoster(force) {
    const s = this.settings();
    if (!s.useApi || !s.apiUrl || !s.code || !s.key) return { members: [], off: true };
    if (!force && this.now() - this.roster.at < ROSTER_TTL_MS) return { members: this.roster.members, cached: true };

    const res = await this._send(s.apiUrl, { action: 'roster', squad: s.code, key: s.key });
    const body = await res.json().catch(() => null);
    if (res.status === 401 || res.status === 403) throw new Error('Your squad code or key was refused. Ask for a fresh invite line.');
    if (!res.ok || !body || body.ok !== true) throw new Error((body && body.error) || `Your squad website replied with an error (${res.status}).`);

    const nowMs = this.now();
    const members = (Array.isArray(body.members) ? body.members : []).slice(0, 100).map((m) => Squad.cleanMember(m, nowMs));
    this.roster = { members, at: nowMs };
    return { members };
  }

  /** Remove this player's entry (the "I'm done" button). */
  async leave() {
    const s = this.settings();
    if (!s.useApi || !s.apiUrl || !s.code || !s.key) return { ok: false };
    const res = await this._send(s.apiUrl, { action: 'leave', squad: s.code, key: s.key, name: s.name });
    this.roster.at = 0;
    this.lastAnnounced = { code: '', at: 0 };
    return { ok: res.ok };
  }
}

module.exports = { Squad, newSquad, makeInvite, readInvite, checkApiUrl, checkWebhook, cleanName, randomCode, INVITE_PREFIX };
