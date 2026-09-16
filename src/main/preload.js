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

  snapshot: call('api:snapshot'),      // every server right now
  server: call('api:server'),          // { code } live detail
  history: call('api:history'),        // { code, window }
  series: call('api:series'),          // { group: 'type' | 'region' }
  find: call('api:find'),              // { code } server that may be offline
  cleanCode: call('code:clean'),       // { code } -> tidied join code

  pingRegion: call('ping:region'),     // { region }

  favList: call('fav:list'),
  favAdd: call('fav:add'),             // { key, name, region, official }
  favReplace: call('fav:replace'),     // { oldKey, key, name, region, official }
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
