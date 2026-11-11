'use strict';
// CoreChem Screen — the office-TV app (Windows mini PCs behind the TVs).
//
// One full-screen window on the Hub's /display page, exactly what Chrome kiosk showed — plus a MEETING VIEW the app
// owns. When Screens → Control (or /present) sends a Teams / Zoom / Meet link, the Hub page asks the app
// (window.coreChemScreen, see preload-display.js) to open it: the app loads the vendor's web client in a view on top
// of the boards, preload-meeting.js types the screen's name and clicks Join, and "Close meeting" destroys the view —
// no second browser window, no click on the TV, and a close that cannot be refused. Why an app: a web page has
// almost no say over another site's window (first mini PC test, 2026-11-09: Chrome kept a Teams window open after
// Close). docs: README.md here; Hub repo docs/screens-present-spec.md §7.
//
// Security: the app only ever shows the Hub (two known origins); the meeting view only navigates the meeting hosts
// (+ their sign-in redirects); camera / mic are granted to those origins only; nothing else gets any permission.
// It holds no secrets — a screen gets its token when its pairing code is entered in the Hub, as before.

const { app, BrowserWindow, WebContentsView, ipcMain, session, powerSaveBlocker } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { execFile } = require('node:child_process');

const DEFAULT_HUB = 'https://app.corecheminc.com';
const HUBS = new Set(['https://app.corecheminc.com', 'https://corecheminc-hub.vercel.app']);
// Same rule as dash_meeting_url_ok() in SQL and meetingUrlOk() in the Hub: what a meeting link may be.
const MEETING_HOST = /^https:\/\/([a-z0-9-]+\.)*(teams\.microsoft\.com|teams\.live\.com|zoom\.us|zoom\.com|meet\.google\.com)(\/|$)/i;
// Where an opened meeting may move on to (launcher pages, sign-in, the vendors' CDNs); anything else is refused.
const MEETING_NAV = /^https:\/\/([a-z0-9-]+\.)*(teams\.microsoft\.com|teams\.live\.com|cloud\.microsoft|teams\.cdn\.office\.net|microsoft\.com|microsoftonline\.com|msftauth\.net|msauth\.net|office\.com|office\.net|live\.com|skype\.com|sharepoint\.com|zoom\.us|zoom\.com|meet\.google\.com|google\.com|gstatic\.com|googleapis\.com|youtube\.com)(\/|$)/i;
const RTC_PORTS = { min: 50000, max: 50999 };   // matches the firewall rule the setup script writes
// The meeting view runs in its own in-memory session, wiped before every meeting: nothing a meeting site stores
// (cookies, IndexedDB, a service worker and its cached app shell) survives into the next one or into a restart,
// and the Hub page's own storage (the screen token) is never shared with Teams / Zoom / Meet. First mini PC test,
// 2026-11-09: after the first (Electron-UA) visit Teams kept serving its cached signed-in shell with a spinner
// forever, on every later version, because that state lived in the shared default session.
const MEETING_PARTITION = 'meeting';

// ---------------------------------------------------------------- config
function readConfig() {
  const arg = process.argv.find((a) => a.startsWith('--hub='));
  let hub = arg ? arg.slice('--hub='.length) : '';
  if (!hub) {
    // written by the setup script (CoreChemScreen-Setup.cmd): { "hub": "https://..." }
    const file = path.join(process.env.ProgramData || 'C:\\ProgramData', 'CoreChemScreen', 'config.json');
    try { hub = JSON.parse(fs.readFileSync(file, 'utf8')).hub || ''; } catch { /* no config yet → production */ }
  }
  hub = String(hub).trim().replace(/\/+$/, '');
  if (!HUBS.has(hub)) hub = DEFAULT_HUB;            // the app shows the Hub and nothing else
  return { hub };
}

// ---------------------------------------------------------------- Chromium switches (before ready)
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');          // boards' sound, shares, meetings
app.commandLine.appendSwitch('disable-features', 'WebRtcHideLocalIpsWithMdns');       // advertise the real LAN address:
                                                                                        // a presenter's laptop connects straight to this PC
// Teams' call engine needs SharedArrayBuffer for its audio decoder ("Decoder worklet initialization failed:
// SharedArrayBuffer is not defined" — the Training Room log, 2026-11-09, right after a successful auto-join). Chrome
// grants Teams that through a Chrome-only origin trial, which Electron does not honour, so allow it app-wide: the
// app only ever shows the Hub and the meeting hosts, in sandboxed renderers.
app.commandLine.appendSwitch('enable-features', 'SharedArrayBuffer,SharedArrayBufferOnDesktop');
// A plain Chrome identity. Teams and Meet turn an "Electron/…" user agent away with a blank page (first mini PC test,
// 2026-11-09: a Teams link opened white). Nothing else in the UA changes — same Chromium, same OS.
app.userAgentFallback = app.userAgentFallback
  .replace(/\(KHTML, like Gecko\)\s.*?\sChrome\//, '(KHTML, like Gecko) Chrome/')
  .replace(/\sElectron\/[\d.]+/, '');
if (!app.requestSingleInstanceLock()) app.quit();

const cfg = readConfig();
let win = null;             // the Hub page
let meeting = null;         // { session, url, view, startedAt }
let pendingOpen = null;     // an openMeeting() still wiping the meeting session
let screenName = '';        // the paired screen's name, from the Hub page (used as the meeting display name)
let pageBusy = false;       // a share or meeting is live on the page (postpones a quiet update)
let loadTimer = null;
let loadFails = 0;

// %LOCALAPPDATA%\CoreChemScreen\app.log — what the app and the meeting page did (2 MB, one rotation). Paste it when
// a meeting misbehaves; nothing in it is secret (URLs of meeting pages, console messages, state changes).
const LOG_DIR = path.join(process.env.LOCALAPPDATA || process.env.TEMP || '.', 'CoreChemScreen');
const LOG_FILE = path.join(LOG_DIR, 'app.log');
function log(...a) {
  const line = `${new Date().toISOString()} ${a.map((x) => (x instanceof Error ? x.message : String(x))).join(' ')}`;
  console.log(line);
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    try { if (fs.statSync(LOG_FILE).size > 2_000_000) fs.renameSync(LOG_FILE, `${LOG_FILE}.1`); } catch { /* no file yet */ }
    fs.appendFileSync(LOG_FILE, `${line}\n`);
  } catch { /* read-only profile — console only */ }
  // the Hub page ships every line to the relay (Screens → Control → Log), so nobody reads a log off a TV
  try { if (win && !win.isDestroyed()) win.webContents.send('screen:log', line); } catch { /* window going away */ }
}
// %LOCALAPPDATA%\CoreChemScreen\busy exists (and is touched every minute) while a share or meeting is live. The
// setup script's "CoreChem Screen update" task (SYSTEM, every 15 min) installs a newer release only when no such
// file is fresh, then the launcher restarts the app — no admin prompt on the TV, no update mid-meeting.
const BUSY_FILE = path.join(LOG_DIR, 'busy');
function updateBusyFlag() {
  const busy = pageBusy || !!meeting;
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    if (busy) fs.writeFileSync(BUSY_FILE, new Date().toISOString());
    else fs.rmSync(BUSY_FILE, { force: true });
  } catch { /* fine */ }
}
setInterval(updateBusyFlag, 60_000);

// the last part of the log file, for the page to ship once at start (what happened before this page loaded)
function logTail(bytes) {
  try {
    const fd = fs.openSync(LOG_FILE, 'r');
    try {
      const size = fs.fstatSync(fd).size;
      const n = Math.min(size, Math.max(0, Math.min(Number(bytes) || 0, 64_000)));
      const buf = Buffer.alloc(n);
      fs.readSync(fd, buf, 0, n, size - n);
      return buf.toString('utf8');
    } finally { fs.closeSync(fd); }
  } catch { return ''; }
}

// ---------------------------------------------------------------- permissions: Hub + meeting hosts only
// no 'display-capture': the TV is the receiver of shares, it never captures its own screen
const ALLOWED_PERMS = new Set(['media', 'fullscreen', 'notifications', 'speaker-selection', 'clipboard-read', 'clipboard-sanitized-write']);
function originOk(url) {
  try { const o = new URL(url).origin; return HUBS.has(o) || MEETING_HOST.test(o + '/'); } catch { return false; }
}
function setupSession(ses) {
  ses.setPermissionRequestHandler((wc, permission, callback, details) => {
    const url = (details && details.requestingUrl) || wc.getURL();
    callback(ALLOWED_PERMS.has(permission) && originOk(url));
  });
  ses.setPermissionCheckHandler((_wc, permission, origin) => ALLOWED_PERMS.has(permission) && originOk(origin + '/'));
}

// ---------------------------------------------------------------- the Hub page
function loadDisplay() {
  if (!win) return;
  win.loadURL(`${cfg.hub}/display`).catch(() => { /* did-fail-load handles it */ });
}
function retryLoad(now) {
  if (!win || loadTimer) return;
  loadFails += 1;
  const wait = now ? 1_000 : Math.min(60_000, 5_000 * Math.min(loadFails, 12));
  log('display load failed, retry in', wait, 'ms');
  loadTimer = setTimeout(() => { loadTimer = null; loadDisplay(); }, wait);
}

function createWindow() {
  win = new BrowserWindow({
    kiosk: true, fullscreen: true, frame: false, autoHideMenuBar: true, show: false,
    backgroundColor: '#0b1220', title: 'CoreChem Screen',
    webPreferences: {
      preload: path.join(__dirname, 'preload-display.js'),
      contextIsolation: true, sandbox: true, nodeIntegration: false,
      backgroundThrottling: false, spellcheck: false,
    },
  });
  win.removeMenu();
  win.once('ready-to-show', () => win.show());
  win.webContents.setWebRTCUDPPortRange(RTC_PORTS);
  // an older Hub page still calling window.open() for a meeting gets the owned view instead of a popup
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (MEETING_HOST.test(url)) void openMeeting({ session: '', url, name: screenName });
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => { if (!originOk(url) || !url.startsWith(cfg.hub)) e.preventDefault(); });
  win.webContents.on('did-fail-load', (_e, code, _desc, url, isMainFrame) => {
    if (!isMainFrame || code === -3 /* aborted by a newer load */) return;
    if (!String(url).startsWith('file:')) win.loadFile(path.join(__dirname, 'offline.html')).catch(() => undefined);
    retryLoad(false);
  });
  win.webContents.on('did-finish-load', () => { if (win.webContents.getURL().startsWith(cfg.hub)) loadFails = 0; });
  win.webContents.on('render-process-gone', (_e, d) => { log('page renderer gone', d.reason); closeMeeting('page restarted'); retryLoad(true); });
  win.webContents.on('before-input-event', (_e, input) => {        // F12 = DevTools for whoever is on site
    if (input.type === 'keyDown' && input.key === 'F12') {
      const wc = meeting ? meeting.view.webContents : win.webContents;
      wc.isDevToolsOpened() ? wc.closeDevTools() : wc.openDevTools({ mode: 'detach' });
    }
  });
  win.on('resize', layoutView);
  win.on('closed', () => { win = null; });
  loadDisplay();
}

// ---------------------------------------------------------------- the meeting view
function layoutView() {
  if (!meeting || !win) return;
  const [width, height] = win.getContentSize();
  if (meeting.revealed) meeting.view.setBounds({ x: 0, y: 0, width, height });
  else meeting.view.setBounds({ x: Math.max(0, width - 2), y: Math.max(0, height - 2), width: 2, height: 2 });
}
// Show the meeting view once its page has content (preload reports 'content' / 'named' / 'joined'), or after 40 s
// regardless. Until then it is a 2×2 dot — still "visible" to the page, so Teams keeps loading at full speed — and
// the boards stay up with the Hub page's "Opening Teams… joining as <screen>" line.
function revealMeeting(why) {
  if (!meeting || meeting.revealed) return;
  meeting.revealed = true;
  layoutView();
  log('meeting shown:', why);
  sendState('shown', why);
}
function sendState(state, reason, sess) {
  if (!win) return;
  win.webContents.send('screen:meeting-state', { state, reason: reason || null, session: sess || (meeting && meeting.session) || '' });
}

let meetingSessionReady = false;
async function freshMeetingSession() {
  const ses = session.fromPartition(MEETING_PARTITION);
  if (!meetingSessionReady) { setupSession(ses); meetingSessionReady = true; }
  try { await ses.clearStorageData(); } catch (err) { log('meeting session clear failed', err); }
  try { await ses.clearCache(); } catch { /* fine */ }
  return ses;
}

async function openMeeting({ session: sess, url, name }) {
  if (!win) return false;
  if (!MEETING_HOST.test(String(url))) { log('meeting refused (host)', String(url).slice(0, 80)); return false; }
  closeMeeting('replaced');
  const opening = { sess: String(sess || '') };
  pendingOpen = opening;
  await freshMeetingSession();
  if (pendingOpen !== opening || !win) return false;          // another open / close came in meanwhile
  pendingOpen = null;
  const session = opening.sess;
  const view = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, 'preload-meeting.js'),
      partition: MEETING_PARTITION,
      contextIsolation: true, sandbox: true, nodeIntegration: false,
      backgroundThrottling: false, spellcheck: false,
    },
  });
  meeting = { session: String(session || ''), url: String(url), name: String(name || screenName || ''), view, startedAt: Date.now(), revealed: false };
  const wc = view.webContents;
  wc.setWebRTCUDPPortRange(RTC_PORTS);
  try { view.setBackgroundColor('#0b1220'); } catch { /* older Electron */ }
  setTimeout(() => { if (meeting && meeting.view === view) revealMeeting('40 s passed'); }, 40_000);
  // Teams' launcher sometimes targets a new window for "continue on this browser" — keep it in this view
  wc.setWindowOpenHandler(({ url: u }) => { if (MEETING_NAV.test(u)) wc.loadURL(u).catch(() => undefined); return { action: 'deny' }; });
  wc.on('will-navigate', (e, u) => { if (!MEETING_NAV.test(u)) { log('meeting navigation refused', u.slice(0, 80)); e.preventDefault(); } });
  wc.on('did-fail-load', (_e, code, desc, _u, isMainFrame) => {
    if (!isMainFrame || code === -3) return;
    log('meeting load failed', code, desc);
    if (meeting && meeting.view === view) { closeMeeting(`load failed: ${desc}`); sendState('error', desc, meeting && meeting.session); }
  });
  wc.on('render-process-gone', (_e, d) => { log('meeting renderer gone', d.reason); if (meeting && meeting.view === view) closeMeeting('crashed'); });
  wc.on('page-title-updated', (e) => e.preventDefault());
  // diagnostics for the log file: where the meeting page went and what it complained about
  wc.on('did-navigate', (_e, u) => log('meeting at', String(u).slice(0, 200)));
  wc.on('did-navigate-in-page', (_e, u, isMainFrame) => { if (isMainFrame) log('meeting at (in-page)', String(u).slice(0, 200)); });
  wc.on('did-finish-load', () => log('meeting loaded', wc.getURL().slice(0, 200), '| title:', wc.getTitle().slice(0, 80)));
  wc.on('will-redirect', (_e, u) => log('meeting redirect', String(u).slice(0, 200)));
  wc.on('preload-error', (_e, p, err) => log('meeting preload error', p, err));
  wc.on('console-message', (e, ...rest) => {           // Electron ≥ 35 passes one event object; older ones (level, message, …)
    const d = e && typeof e === 'object' && 'message' in e ? e : { level: rest[0], message: rest[1] };
    const lvl = String(d.level);
    if (lvl === 'error' || lvl === 'warning' || lvl === '2' || lvl === '3') log('meeting console', lvl, String(d.message).slice(0, 300));
  });
  win.contentView.addChildView(view);
  layoutView();
  wc.loadURL(meeting.url).catch((err) => log('meeting loadURL rejected', err));
  log('meeting opened', meeting.url.slice(0, 60), 'as', meeting.name || '(no name)');
  sendState('opened');
  updateBusyFlag();
  return true;
}

function closeMeeting(reason) {
  pendingOpen = null;                                   // a close while still opening wins
  if (!meeting) return false;
  const m = meeting;
  meeting = null;
  try { if (win) win.contentView.removeChildView(m.view); } catch { /* window gone */ }
  try { m.view.webContents.close(); } catch { /* already gone */ }
  log('meeting closed:', reason);
  sendState('ended', reason, m.session);
  updateBusyFlag();
  return true;
}

// ---------------------------------------------------------------- IPC (only from the Hub page / the meeting view)
const fromDisplay = (e) => !!win && e.sender === win.webContents && originOk(e.senderFrame ? e.senderFrame.url : '');
const fromMeeting = (e) => !!meeting && e.sender === meeting.view.webContents;

ipcMain.handle('screen:info', (e) => (fromDisplay(e) ? { app: 'corechem-screen', version: app.getVersion(), hub: cfg.hub } : null));
ipcMain.handle('screen:log-tail', (e, bytes) => (fromDisplay(e) ? logTail(bytes) : ''));
ipcMain.on('screen:name', (e, name) => { if (fromDisplay(e)) screenName = String(name || '').slice(0, 80); });
ipcMain.on('screen:busy', (e, b) => { if (fromDisplay(e)) { pageBusy = !!b; updateBusyFlag(); } });
ipcMain.handle('screen:open-meeting', async (e, args) => fromDisplay(e) && !!args && openMeeting({ session: args.session, url: args.url, name: args.name }));
ipcMain.handle('screen:close-meeting', (e) => fromDisplay(e) && closeMeeting('closed from the Hub'));
ipcMain.handle('screen:restart', (e) => { if (!fromDisplay(e)) return false; app.relaunch(); app.exit(0); return true; });
ipcMain.handle('screen:reboot', (e) => {
  if (!fromDisplay(e)) return false;
  execFile('shutdown.exe', ['/r', '/t', '5', '/c', 'CoreChem screen: restart from the Hub'], () => undefined);
  return true;
});
ipcMain.handle('meeting:config', (e) => (fromMeeting(e) ? { name: meeting.name || screenName || 'Conference room' } : null));
ipcMain.on('meeting:event', (e, ev) => {
  if (!fromMeeting(e)) return;
  const kind = String(ev || '');
  if (kind.startsWith('text:')) {                        // what the page says right now — log + a hint for the Hub page
    log('meeting says:', kind.slice(5, 165));
    sendState('text', kind.slice(5, 165));
    return;
  }
  // log-only notes from the meeting page: why it decided the meeting ended, a pop-up it closed, one it left for a person
  const note = /^(why|dismissed|needs):/.exec(kind);
  if (note) {
    const label = { why: 'meeting ended because', dismissed: 'meeting pop-up closed:', needs: 'meeting pop-up needs a person:' }[note[1]];
    log(label, kind.slice(note[0].length, note[0].length + 160));
    return;
  }
  log('meeting event', kind);
  sendState(kind);
  if (kind === 'named' || kind === 'joined' || kind === 'audio' || kind === 'incall') revealMeeting(kind);
  else if (kind === 'content' && meeting && !meeting.revealed) {
    const v = meeting.view;
    setTimeout(() => { if (meeting && meeting.view === v) revealMeeting('content for 12 s'); }, 12_000);
  }
  if (kind === 'left') {                                 // the meeting ended on its side — take the view down shortly
    const v = meeting.view;
    setTimeout(() => { if (meeting && meeting.view === v) closeMeeting('left'); }, 4_000);
  }
});

// ---------------------------------------------------------------- updates
// The app only LOOKS for a newer release (and logs it). Installing is the setup script's "CoreChem Screen update"
// task: it runs as SYSTEM every 15 min, so a per-machine install updates with no admin prompt on the TV, and it
// waits while the busy flag above is fresh. (electron-updater installing from the user session would raise UAC.)
function setupUpdates() {
  if (!app.isPackaged) return;
  let autoUpdater;
  try { ({ autoUpdater } = require('electron-updater')); } catch { return; }
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.on('error', (err) => log('update check error', err && err.message));
  autoUpdater.on('update-available', (info) => log('update available:', info && info.version, '(the CoreChem Screen update task installs it within 15 min when nothing is live)'));
  autoUpdater.on('update-not-available', () => log('up to date', app.getVersion()));
  const check = () => autoUpdater.checkForUpdates().catch(() => undefined);
  setTimeout(check, 90_000);
  setInterval(check, 6 * 3600_000);
}

// ---------------------------------------------------------------- lifecycle
app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
app.on('window-all-closed', () => app.quit());        // the launcher (setup script) starts us again
app.whenReady().then(() => {
  setupSession(session.defaultSession);
  powerSaveBlocker.start('prevent-display-sleep');
  createWindow();
  setupUpdates();
  log('CoreChem Screen', app.getVersion(), '→', cfg.hub);
});
