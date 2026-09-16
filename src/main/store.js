'use strict';
/*
 * RedMarks Wardogs Server Browser - saved data
 *
 * Favourites and settings live in the app's own folder:
 *   %APPDATA%\RedMarks Wardogs Server Browser\
 * Nothing is written anywhere near the game's files.
 */

const fs = require('fs');
const path = require('path');

const MAX_FAVOURITES = 40; // keeps a full refresh well under the API rate limit

const DEFAULT_SETTINGS = {
  homeRegion: '',          // '' = not chosen yet
  refreshMinutes: 5,       // 5, 10 or 15 - never faster than 5
  hidePassworded: false,
  onlyWithSpace: false,
  launchGame: true,        // Join button also starts WARDOGS through Steam
};

class JsonFile {
  constructor(file, fallback) {
    this.file = file;
    this.fallback = fallback;
  }

  read() {
    try {
      return JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch (err) {
      return structuredClone(this.fallback);
    }
  }

  write(value) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8');
    fs.renameSync(tmp, this.file); // swap in whole, so a crash never leaves half a file
  }
}

class Store {
  constructor(dir) {
    this.favFile = new JsonFile(path.join(dir, 'favourites.json'), []);
    this.setFile = new JsonFile(path.join(dir, 'settings.json'), DEFAULT_SETTINGS);
  }

  // ----- favourites -----

  listFavourites() {
    const list = this.favFile.read();
    return Array.isArray(list) ? list.filter((f) => f && typeof f.key === 'string') : [];
  }

  addFavourite({ key, name, region, official }) {
    if (typeof key !== 'string' || !key || key.length > 200) throw new Error('That server has no usable key.');
    const list = this.listFavourites();
    if (list.some((f) => f.key === key)) return list;
    if (list.length >= MAX_FAVOURITES) {
      throw new Error(`You can keep up to ${MAX_FAVOURITES} favourites. Remove one to add another.`);
    }
    list.push({
      key,
      name: String(name || '').slice(0, 120),
      region: String(region || '').slice(0, 40),
      official: Boolean(official),
      addedAt: Date.now(),
    });
    this.favFile.write(list);
    return list;
  }

  removeFavourite(key) {
    const list = this.listFavourites().filter((f) => f.key !== key);
    this.favFile.write(list);
    return list;
  }

  /** Keep the saved name current, so offline favourites still show a name. */
  touchFavourite(key, name, region) {
    const list = this.listFavourites();
    const fav = list.find((f) => f.key === key);
    if (!fav) return;
    const n = String(name || '').slice(0, 120);
    const r = String(region || '').slice(0, 40);
    if ((n && fav.name !== n) || (r && fav.region !== r)) {
      if (n) fav.name = n;
      if (r) fav.region = r;
      this.favFile.write(list);
    }
  }

  // ----- settings -----

  getSettings() {
    const s = { ...DEFAULT_SETTINGS, ...this.setFile.read() };
    s.refreshMinutes = [5, 10, 15].includes(Number(s.refreshMinutes)) ? Number(s.refreshMinutes) : 5;
    s.homeRegion = typeof s.homeRegion === 'string' ? s.homeRegion.slice(0, 40) : '';
    s.hidePassworded = Boolean(s.hidePassworded);
    s.onlyWithSpace = Boolean(s.onlyWithSpace);
    s.launchGame = Boolean(s.launchGame);
    return s;
  }

  saveSettings(patch) {
    const next = { ...this.getSettings() };
    for (const k of Object.keys(DEFAULT_SETTINGS)) {
      if (patch && Object.prototype.hasOwnProperty.call(patch, k)) next[k] = patch[k];
    }
    this.setFile.write(next);
    return this.getSettings();
  }
}

module.exports = { Store, MAX_FAVOURITES, DEFAULT_SETTINGS };
