# CoreChem Screen — the office-TV app

The Windows app that runs on the mini PC behind each office TV. It replaces "Chrome in kiosk mode" from the first
version of the screen setup (Hub repo: `public/screen-setup/CoreChemScreen-Setup.cmd`, spec `docs/screens-present-spec.md`).

## Why an app

The TV page (`/display`) is a web page. Boards, the present code and screen sharing work fine in a browser — but a
**meeting** (Teams / Zoom / Meet) is another website, and a web page has almost no say over another site's window:
it can't type the room's name, can't click Join, and Chrome may refuse to close it (first mini PC test, 2026-11-09:
"Close meeting" from Screens → Control reached the TV and the Teams window stayed up). Wireless-presentation boxes
(Airtame, Airecast, …) solve this by shipping their own app with a browser engine inside, which owns the meeting
window. This is that app for the Hub, as small as it can be.

## What it does

- Opens `<hub>/display` full-screen (kiosk) — the same page as before; boards, present code, screen share unchanged.
- Exposes `window.coreChemScreen` to that page (`src/preload-display.js`). When the page gets a `meeting_open`
  command it calls `openMeeting(session, url, screenName)`; the app loads the vendor's **web** client in a view it
  owns (`WebContentsView`) on top of the boards. No second window, no Teams app needed.
- `src/preload-meeting.js` does what a person would: "Continue on this browser", types the **screen's name**, clicks
  **Join** / "Join audio by computer", and reports `left` when the meeting ends so the page tells the Hub.
  "Ended" means the vendor's own end screen ("You left the meeting", "The meeting has ended", removed …) **and** the
  call's Leave button gone — never just a phrase somewhere on the page (v0.1.7: v0.1.6 matched "<someone> left the
  call" / a chat's "Meeting ended" banner mid-call and closed the meeting; training room 2026-11-11). The log says
  which text ended it (`meeting ended because …`).
- The join steps use **real input** (`src/realInput.js`): the app moves the mouse to the button and clicks, and types
  the name one key at a time, through Electron's `sendInputEvent` — the page sees trusted events, as from a person.
  v0.1.6 used `element.click()` and a value setter (script events), and Teams' bot detection put the TVs in the lobby
  as suspected bots (2026-11-11). The script way is only a fallback if the app can't send input.
- Once in the call, pop-ups nobody in the room can close ("Recording has started", tips, toasts) are closed after 8 s
  (`meeting pop-up closed: "Recording has started"` in the log — a known banner's name or `(other pop-up)`, never the pop-up's text: a chat toast holds the sender and a message preview). A pop-up asking for a decision (explicit recording consent → Agree, Leave,
  Join audio) is never clicked — it is logged once as `meeting pop-up needs a person: …`.
- The view stays a 2×2 px dot until the page shows something (Teams paints nothing for 15–20 s while it "gets things
  ready"), then fills the screen; the Hub page says "Opening Teams… joining as <screen>" meanwhile. What the page says
  is logged every few seconds until joined.
- The meeting view runs in its own in-memory session, wiped before every meeting: nothing a meeting site stores
  (cookies, a service worker and its cached app shell) carries over, and the Hub page's storage is never shared with it.
- `closeMeeting()` destroys the view. It cannot be refused.
- Camera / mic are granted only to the Hub and the meeting hosts; the meeting view may only navigate the meeting
  hosts and their sign-in pages; the main window may only show the Hub. The app holds **no secrets** — a screen gets
  its token when its pairing code is entered in the Hub, exactly as before.
- Allows SharedArrayBuffer app-wide (`--enable-features=SharedArrayBuffer`): Teams' call engine needs it for its audio
  decoder and gets it in Chrome through an origin trial Electron doesn't honour.
- Presents a plain Chrome user agent (Teams and Meet turn an "Electron/…" one away with a blank page) and writes
  `%LOCALAPPDATA%\CoreChemScreen\app.log` — where the meeting page went and what it complained about; paste it
  when a meeting misbehaves.
- Keeps the display awake, restarts its page on a crash, shows "Waiting for the network…" until the Hub loads after a
  reboot, F12 opens DevTools for whoever is on site.
- Updates arrive by themselves: the setup script's **CoreChem Screen update** task (Windows, SYSTEM, every 15 min)
  installs a newer release silently when nothing is live (the app keeps `%LOCALAPPDATA%\CoreChemScreen\busy` fresh
  during a share / meeting) and the launcher restarts the app. The app itself only looks for updates and logs them —
  installing from the user session would raise an admin prompt on a per-machine install.
- **Nobody visits a TV for an update** (since 0.1.8). The PC side of updating ships *in the release*:
  `screen-host/update-screen.ps1` is the canonical updater, and every install runs `screen-host/post-install.ps1`
  (via `build/installer.nsh`), which copies it to `C:\ProgramData\CoreChemScreen\`, re-creates the task if it is
  missing, and sets its 60-min limit. So a broken updater is fixed by releasing the app. The updater also sets a
  wrong PC clock from GitHub's `Date` header, and the app forwards new `update.log` lines into its own log, so they
  show up in the Hub (Screens → Control → Log, `updater:`). Why: 0.1.7 (2026-11-11) never installed itself on any TV.
  The setup-era updater downloaded the 100 MB installer with PowerShell 5.1's slow `Invoke-WebRequest`, inside a
  20-min task limit, and fixing that meant re-running setup at every TV.

## Page API (`window.coreChemScreen`, version 1)

| Call | What |
|---|---|
| `setScreenName(name)` | the paired screen's name → the display name in meetings |
| `setBusy(bool)` | a share / meeting is live (postpones a quiet update) |
| `openMeeting(session, url, name) → Promise<boolean>` | open a Teams / Zoom / Meet link in the owned view |
| `closeMeeting() → Promise<boolean>` | take it down |
| `onMeetingState(cb) → unsubscribe` | `{state: opened · launcher · named · joined · incall · left · ended · error, reason, session}` (`incall` = the call's Leave button is up) |
| `restartApp()`, `rebootPc()` | for Screens → Control (the page decides who may ask) |
| `info() → {app, version, hub}` | shown in Screens |
| `onLog(cb) → unsubscribe`, `logTail(bytes)` | (v2) every log line as it happens, and the file's tail at start — the page ships them to the relay's `/display/log`; Screens → Control shows the last lines |
| `screenToken() → string`, `saveScreenToken(t) → boolean` | (v3, synchronous) the pairing token, kept in `%LOCALAPPDATA%\CoreChemScreen\screen-token-<hub host>` (one per Hub; never in a log — don't send this file with app.log) — the page prefers it over its localStorage. Why: Pause and the update task end the app with a hard kill, and localStorage written shortly before a hard kill is lost (reproduced in Electron 38: killed 1.5 s after the write → gone; 40 s → kept) — the training TV came back with a pairing code after every Pause (2026-11-11). The file is written to a temp name, fsynced and renamed. |

The Hub page keeps working in a plain browser: it feature-tests `window.coreChemScreen` and falls back to the popup.

## Config

`C:\ProgramData\CoreChemScreen\config.json` → `{ "hub": "https://app.corecheminc.com" }` (written by the setup
script; the test site is the only other value accepted). `--hub=<url>` overrides it for development.

## Build and release

This app lives in its own **public** repo, `corecheminc/corechem-screen` (the Hub itself is private). Public on
purpose: the mini PCs download the installer with no login, `electron-updater` checks the same place, and the build
publishes with GitHub's own `GITHUB_TOKEN` — no long-lived access token anywhere. There is nothing secret in here:
the Hub's public addresses, the meeting hosts, and the join-screen automation.

`.github/workflows/release.yml` builds a **web installer** (`nsis-web`, since 0.1.8) on `windows-latest`. Bump
`version` in `package.json`, commit, and push a tag `v<version>`. The release then gets `CoreChemScreen-Setup.exe`
(a ~1 MB stub), `corechem-screen-<version>-x64.nsis.7z` (the app, which the stub downloads from the release) and
`latest.yml`. A small installer means any updater, even the old slow one, fetches it in seconds.
`.github/workflows/test-install.yml` (every PR) runs the whole path on a Windows runner: a 0.1.7 PC with the OLD
updater as a SYSTEM task installs the build, gets the new updater, and has its clock corrected. The Hub's setup
script installs from `https://github.com/corecheminc/corechem-screen/releases/latest/download/CoreChemScreen-Setup.exe`
(silent `/S`, per machine). A manual run of the workflow builds without publishing (workflow artifact).

The installer is not code-signed (SmartScreen warns once on a double-click; the setup script's PowerShell download
carries no mark-of-the-web, so it doesn't). Signing (~$200–400/yr) is the one improvement worth buying later.

The Hub side of this (the page bridge `src/lib/screenApp.ts`, `DisplayPage.tsx`, the setup script, spec §7) is in
the private Hub repo `corecheminc/corecheminc-hub`.

## Develop

```
cd screen-app && npm install
npm start            # opens the TEST Hub (--hub=https://corecheminc-hub.vercel.app)
npm run check        # syntax check of the three JS files
npm run dist         # local Windows build (on Windows)
```

Vendors change their join screens now and then. Every lookup in `preload-meeting.js` has a data-attribute first
choice and a visible-text fallback; a miss means someone clicks Join on the TV, nothing worse. Bump `version` in
`package.json`, tag `v…`, done.
