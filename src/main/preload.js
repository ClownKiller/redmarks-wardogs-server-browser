'use strict';
/*
 * RedMarks Wardogs Server Browser - preload bridge
 *
 * The screen (renderer) has no direct access to the internet, files or
 * Node.js. It can only ask the main process to do the jobs listed here.
 */

const { contextBridge, ipcRenderer } = require('electron');

const call = (channel) => (arg) => ipcRenderer.invoke(channel, arg);

contextBridge.exposeInMainWorld('rm', {
  appInfo: call('app:info'),

  server: call('api:server'),          // { key } or { code }
  leaderboard: call('api:leaderboard'),
  detail: call('api:detail'),          // { key | id, window }
  totals: call('api:totals'),          // { window }
  regions: call('api:regions'),        // { window }
  builds: call('api:builds'),

  pingRegion: call('ping:region'),     // { region }

  favList: call('fav:list'),
  favAdd: call('fav:add'),             // { key, name, region, official }
  favRemove: call('fav:remove'),       // { key }
  favTouch: call('fav:touch'),         // { key, name, region }

  settingsGet: call('settings:get'),
  settingsSave: call('settings:save'),

  join: call('game:join'),             // { code } -> copies code, starts WARDOGS via Steam
  copy: call('clipboard:write'),       // { text }
  openLink: call('link:open'),         // { url }

  minimize: call('window:minimize'),
  maximize: call('window:maximize'),
  close: call('window:close'),
  onWindowState: (fn) => ipcRenderer.on('window:state', (_e, s) => fn(s)),
});
