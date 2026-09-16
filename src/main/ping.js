'use strict';
/*
 * RedMarks Wardogs Server Browser - region ping estimate
 *
 * The public server data does not include server IP addresses, so a true
 * per-server ping is not possible. Instead we time how long it takes to
 * open a normal HTTPS connection (port 443) to a large public data centre
 * in the same part of the world. It is an ESTIMATE and the app labels it so.
 *
 * Nothing here contacts WARDOGS or Bulkhead. It is the same kind of
 * connection your web browser makes when it opens a website.
 */

const net = require('net');

// Public AWS regional endpoints used purely as a "which part of the world" yardstick.
const DATA_CENTRES = {
  'eu-west': 'dynamodb.eu-west-2.amazonaws.com',        // London
  'eu-central': 'dynamodb.eu-central-1.amazonaws.com',  // Frankfurt
  'eu-east': 'dynamodb.eu-north-1.amazonaws.com',       // Stockholm
  'eu-south': 'dynamodb.eu-south-1.amazonaws.com',      // Milan
  'na-west': 'dynamodb.us-west-1.amazonaws.com',        // California
  'na-central': 'dynamodb.us-east-2.amazonaws.com',     // Ohio
  'na-east': 'dynamodb.us-east-1.amazonaws.com',        // Virginia
  'na-north': 'dynamodb.ca-central-1.amazonaws.com',    // Montreal
  'sa': 'dynamodb.sa-east-1.amazonaws.com',             // Sao Paulo
  'asia-east': 'dynamodb.ap-northeast-1.amazonaws.com', // Tokyo
  'asia-southeast': 'dynamodb.ap-southeast-1.amazonaws.com', // Singapore
  'asia-west': 'dynamodb.ap-south-1.amazonaws.com',     // Mumbai
  'oce': 'dynamodb.ap-southeast-2.amazonaws.com',       // Sydney
};

// Region ids the server list actually uses (seen on wardogservers.com).
const EXACT = {
  'asia-east': 'asia-east', 'asia-southeast': 'asia-southeast', 'asia-west': 'asia-west',
  'eu-central': 'eu-central', 'eu-east': 'eu-east', 'eu-south': 'eu-south', 'eu-west': 'eu-west',
  'na-central': 'na-central', 'na-east': 'na-east', 'na-north': 'na-north', 'na-west': 'na-west',
  'oceania': 'oce', 'south-america': 'sa',
};

const CACHE_MS = 5 * 60 * 1000;
const cache = new Map(); // group -> { ms, at }

/**
 * Region codes from the API look like "eu-west". We have not seen every
 * code the API can return, so we match by the words inside the code and
 * fall back to "unknown" rather than guessing wildly.
 */
function regionGroup(code) {
  const c = String(code || '').toLowerCase();
  if (EXACT[c]) return EXACT[c];
  const has = (...words) => words.some((w) => c.includes(w));
  if (has('oce', 'au', 'nz', 'sydney')) return 'oce';
  if (has('sa', 'south-america', 'br', 'latam') && !has('asia', 'usa')) return 'sa';
  if (has('asia', 'as-', 'ap-', 'jp', 'sg', 'kr')) {
    if (has('southeast', 'sg')) return 'asia-southeast';
    if (has('west', 'south', 'in', 'me')) return 'asia-west';
    return 'asia-east';
  }
  if (has('eu')) {
    if (has('central')) return 'eu-central';
    if (has('east')) return 'eu-east';
    if (has('south')) return 'eu-south';
    return 'eu-west';
  }
  if (has('na', 'us', 'ca', 'north-america')) {
    if (has('west')) return 'na-west';
    if (has('central')) return 'na-central';
    if (has('north')) return 'na-north';
    return 'na-east';
  }
  return null;
}

function connectOnce(host, timeoutMs) {
  return new Promise((resolve) => {
    const start = process.hrtime.bigint();
    const sock = net.connect({ host, port: 443 });
    const done = (ms) => { sock.destroy(); resolve(ms); };
    sock.setTimeout(timeoutMs, () => done(null));
    sock.once('error', () => done(null));
    sock.once('connect', () => done(Number(process.hrtime.bigint() - start) / 1e6));
  });
}

/** Median of 3 connection times, in whole milliseconds, or null if unreachable. */
async function estimate(regionCode) {
  const group = regionGroup(regionCode);
  if (!group) return null;
  const hit = cache.get(group);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.ms;

  const host = DATA_CENTRES[group];
  await connectOnce(host, 3000); // warm-up: first try includes the DNS lookup
  const times = [];
  for (let i = 0; i < 3; i++) {
    const t = await connectOnce(host, 3000);
    if (t != null) times.push(t);
  }
  const ms = times.length ? Math.round(times.sort((a, b) => a - b)[Math.floor(times.length / 2)]) : null;
  cache.set(group, { ms, at: Date.now() });
  return ms;
}

module.exports = { estimate, regionGroup, DATA_CENTRES };
