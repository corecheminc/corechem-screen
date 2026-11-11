'use strict';
// Runs in the Hub's /display page inside the CoreChem Screen app. Exposes window.coreChemScreen — the Hub page
// checks for it and, when present, opens meetings through the app instead of window.open(). Everything here is a
// thin, typed bridge to main.js; the page never gets Node or Electron objects (contextIsolation + sandbox).
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('coreChemScreen', {
  /** bump when the shape of this API changes; the Hub page can feature-test on it (2 = onLog / logTail,
   *  3 = screenToken / saveScreenToken) */
  version: 3,
  /** the screen's pairing token, kept by the app in a file — '' when none yet. Synchronous: the page needs it
   *  before its first request. Why: the page's localStorage alone lost the pairing on app restarts (2026-11-11). */
  screenToken: () => { try { return String(ipcRenderer.sendSync('screen:token-get') || ''); } catch { return ''; } },
  /** keep this token for the next start (the page minted it or found it in localStorage) */
  saveScreenToken: (t) => { try { return !!ipcRenderer.sendSync('screen:token-set', String(t == null ? '' : t)); } catch { return false; } },
  /** the paired screen's name — used as the display name in meetings */
  setScreenName: (name) => ipcRenderer.send('screen:name', String(name == null ? '' : name)),
  /** a share or meeting is live on the page (postpones a quiet app update) */
  setBusy: (busy) => ipcRenderer.send('screen:busy', !!busy),
  /** open a Teams / Zoom / Meet link in the app's own view; resolves true when it was accepted */
  openMeeting: (session, url, name) =>
    ipcRenderer.invoke('screen:open-meeting', { session: String(session == null ? '' : session), url: String(url), name: String(name == null ? '' : name) }),
  /** take the meeting view down (always works — the app owns it) */
  closeMeeting: () => ipcRenderer.invoke('screen:close-meeting'),
  /** { state: 'opened' | 'launcher' | 'named' | 'joined' | 'left' | 'ended' | 'error', reason, session } */
  onMeetingState: (cb) => {
    const handler = (_e, s) => { try { cb(s); } catch { /* page's problem */ } };
    ipcRenderer.on('screen:meeting-state', handler);
    return () => ipcRenderer.removeListener('screen:meeting-state', handler);
  },
  /** restart the app / reboot the PC (Screens → Control; the page decides who may ask) */
  restartApp: () => ipcRenderer.invoke('screen:restart'),
  rebootPc: () => ipcRenderer.invoke('screen:reboot'),
  /** { app, version, hub } */
  info: () => ipcRenderer.invoke('screen:info'),
  /** every line the app logs, as it happens — the page ships them to the relay (Screens → Control → Log) */
  onLog: (cb) => {
    const handler = (_e, line) => { try { cb(String(line)); } catch { /* page's problem */ } };
    ipcRenderer.on('screen:log', handler);
    return () => ipcRenderer.removeListener('screen:log', handler);
  },
  /** the last `bytes` of the app's log file (≤ 64 KB) — what happened before this page loaded */
  logTail: (bytes) => ipcRenderer.invoke('screen:log-tail', Number(bytes) || 12000),
});
