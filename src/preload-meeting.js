'use strict';
// Runs inside the meeting view (Teams / Zoom / Meet web client). Does what a person in the room would do:
// "Continue on this browser", type the screen's name, click Join, join computer audio — then watches for the
// meeting ending and tells the app. It only ever reads the page and clicks / types; it never sends page data
// anywhere but the app's own log. Vendors change their join screens now and then: every lookup has a
// data-attribute first choice and a visible-text fallback, and a miss just means someone clicks Join on the TV.
//
// Events to the app (ipc 'meeting:event'): 'content' (the page shows something — the app reveals the view),
// 'launcher' / 'named' / 'joined' / 'audio' (steps taken), 'incall' (the call's Leave button is up — really in),
// 'left' (the meeting ended), and for the log only: 'text:<snippet>' every few seconds until joined, 'why:<text>'
// (what made us decide the meeting ended), 'dismissed:<text>' (a pop-up we closed), 'needs:<text>' (a pop-up that
// wants a person, e.g. explicit recording consent — left alone).
const { ipcRenderer } = require('electron');

let screenName = 'Conference room';
ipcRenderer.invoke('meeting:config').then((c) => { if (c && c.name) screenName = String(c.name).slice(0, 80); }).catch(() => undefined);
const report = (ev) => { try { ipcRenderer.send('meeting:event', ev); } catch { /* view closing */ } };

// ---------------------------------------------------------------- DOM helpers
const visible = (el) => !!el && el.offsetParent !== null && !el.disabled && el.getAttribute('aria-disabled') !== 'true';
const text = (el) => ((el.innerText || el.textContent || el.value || '') + ' ' + (el.getAttribute('aria-label') || '')).replace(/\s+/g, ' ').trim();
const lastClick = {};
// Join-type buttons may be visible before they work (Teams shows "Join now" greyed while "Connecting…"), so a
// click may repeat every few seconds until the page moves on; the app de-duplicates the events.
// Clicks and typing are REAL input sent by the app (realInput.js via 'meeting:click' / 'meeting:type-name'), not
// element.click() / a value setter — script events read as a bot to Teams (v0.1.7). If the app can't (an old app,
// an error) the script way is the fallback, so a join never stalls on it. 'retry' = the view was still the hidden
// 2×2 dot or the element off-screen: the next tick measures again.
let acting = false;
function centreOf(el) {
  try { el.scrollIntoView({ block: 'nearest', inline: 'nearest' }); } catch { /* fine */ }
  const r = el.getBoundingClientRect();
  return r.width && r.height ? { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) } : null;
}
async function realInput(channel, el) {
  const p = centreOf(el);
  try { return await ipcRenderer.invoke(channel, p || { x: -1, y: -1 }); } catch { return 'error'; }
}
function clickEvery(el, key, ms) {
  if (!el || acting) return false;
  const now = Date.now();
  if (lastClick[key] && now - lastClick[key] < ms) return false;
  lastClick[key] = now;
  acting = true;
  realInput('meeting:click', el).then((r) => {
    if (r === 'ok') report(key);
    else if (r === 'retry' || r === 'busy') delete lastClick[key];
    else { try { el.click(); report(key); } catch { /* gone */ } }
  }).finally(() => { acting = false; });
  return true;
}
function setValue(input, value) {
  const proto = input.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;     // React listens to the native setter + input event
  input.focus();
  setter.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
}
const $ = (sel) => { try { return [...document.querySelectorAll(sel)].find(visible) || null; } catch { return null; } };
const byText = (sel, re) => { try { return [...document.querySelectorAll(sel)].find((el) => visible(el) && re.test(text(el))) || null; } catch { return null; } };
const nameInput = () =>
  [...document.querySelectorAll('input:not([type]), input[type="text"], input[type="search"]')]
    .find((i) => visible(i) && /name/i.test([i.placeholder, i.getAttribute('aria-label'), i.id, i.name, i.getAttribute('data-tid')].join(' ')));
// each label of a control on its own (the visible text, aria-label, title), so anchored patterns work
const labels = (el) => [el.innerText || el.textContent || '', el.getAttribute('aria-label') || '', el.getAttribute('title') || '']
  .map((x) => x.replace(/\s+/g, ' ').trim()).filter(Boolean);
const labelled = (el, re) => labels(el).some((l) => re.test(l));
const leaveButton = () => {
  const direct = $('#hangup-button, button[data-tid="hangup-main-btn"], button[data-tid="call-hangup"], button[data-tid="hangup-button"], button.footer__leave-btn, button[aria-label^="Leave call" i]');
  if (direct) return direct;
  try { return [...document.querySelectorAll('button')].find((b) => visible(b) && labelled(b, LEAVE_LABEL_RE)) || null; } catch { return null; }
};
const bodyText = () => { try { return (document.body && document.body.innerText || '').replace(/\s+/g, ' ').trim(); } catch { return ''; } };
const visibleButtons = () => { try { return [...document.querySelectorAll('button')].filter(visible).length; } catch { return 0; } };

let named = false;
function typeName(input) {
  if (!input || named || acting) return false;
  if ((input.value || '').trim() === screenName) { named = true; return false; }
  acting = true;
  realInput('meeting:type-name', input).then((r) => {
    if (r === 'retry' || r === 'busy') return;
    if (r !== 'ok' || (input.value || '').trim() !== screenName) setValue(input, screenName);   // fallback
    named = true;
    report('named');
  }).finally(() => { acting = false; });
  return true;
}

const JOIN_RE = /^(join now|join|join meeting|ask to join|join anyway)$/i;
const AUDIO_RE = /join audio by computer|join with computer audio|computer audio/i;
// What a meeting's OWN end screen says. Only phrases about this TV ("you …", "the meeting has ended") — never
// "<someone> left the call" or a chat's "Meeting ended: 21m" banner, which the old pattern matched mid-meeting and
// so closed the meeting on the TV (Training room, 2026-11-11: 12 Teams joins in 30 min, each "left" after 15 s–5 min).
// And it only counts once the call's Leave button is gone (leaveButton() below) — a live call always shows one.
const ENDED_RE = /you(’|')?ve left the (meeting|call)|you left the (meeting|call)|you(’|')?ve been removed|you have been removed|removed you from (the|this) (meeting|call)|(the|this) (meeting|call) has (been )?ended|the host (has )?ended (the|this) meeting|ended the meeting for everyone|meeting (was )?ended by (the )?host|thanks for joining|how was the (audio and video|call quality)|rate (the|your) call quality/i;
// The call's Leave / Hang up button — present for the whole call (Teams top bar, Zoom footer, Meet bottom bar).
const LEAVE_LABEL_RE = /^(leave|leave (call|meeting)|hang ?up|end call)\b/i;
// A pop-up's "close it" button. Anything else in a pop-up (Agree, Accept, Leave, Join audio …) is left for a person.
const DISMISS_RE = /^(dismiss|close|close (banner|notification|message|toast|dialog)|dismiss (banner|notification|message|all)|got it|no thanks|not now|maybe later)$/i;
const NEEDS_PERSON_RE = /^(agree|accept|i agree|allow|leave|end|hang ?up|join|join now|join audio|join audio by computer|continue|admit|record|stop recording)\b/i;

// ---------------------------------------------------------------- per-site steps
function teams() {
  // launcher.html: "Continue on this browser" (new and old markup)
  clickEvery($('button[data-tid="joinOnWeb"]') || byText('button, a', /continue on this browser|use the web app instead|join on the web/i), 'launcher', 5_000);
  // pre-join: name + Join
  typeName($('input[data-tid="prejoin-display-name-input"]') || $('#username') || nameInput());
  if (named) clickEvery($('button[data-tid="prejoin-join-button"]') || byText('button', JOIN_RE), 'joined', 4_000);
  // no camera / mic on this PC yet → Teams offers to continue without
  clickEvery(byText('button', /continue without (audio|video|devices)|join without/i), 'joined', 4_000);
}
function zoom() {
  // zoom.us/j/<id> (unrewritten): the in-browser client link
  clickEvery(byText('a, button', /join from your browser/i), 'launcher', 5_000);
  typeName($('#input-for-name') || $('input[placeholder*="name" i]') || nameInput());
  if (named) clickEvery($('button.preview-join-button') || $('#joinBtn') || byText('button', JOIN_RE), 'joined', 4_000);
  clickEvery($('button.join-audio-by-voip__join-btn') || byText('button', AUDIO_RE), 'audio', 4_000);
  // "I agree" to Zoom's terms, shown to anonymous web participants
  clickEvery(byText('button', /^i agree$/i), 'launcher', 5_000);
}
function meet() {
  typeName($('input[aria-label*="name" i]') || nameInput());
  if (named) clickEvery(byText('button', /^(ask to join|join now)$/i), 'joined', 4_000);
  clickEvery(byText('button', /continue without (microphone|camera)/i), 'joined', 4_000);
}
function generic() {
  typeName(nameInput());
  if (named) clickEvery(byText('button', JOIN_RE), 'joined', 4_000);
}

function site() {
  const h = location.hostname;
  if (/(^|\.)teams\.(microsoft|live)\.com$|(^|\.)cloud\.microsoft$/i.test(h)) return teams;
  if (/(^|\.)zoom\.(us|com)$/i.test(h)) return zoom;
  if (/(^|\.)meet\.google\.com$/i.test(h)) return meet;
  return generic;
}

// ---------------------------------------------------------------- loop
let leftSaid = false;
let inCall = false;
let endedTicks = 0;
let lastHref = '';
let armedUntil = 0;
let contentSaid = false;
let lastText = '';
let lastTextAt = 0;
function tick() {
  if (location.href !== lastHref) {                     // every navigation (SPA or real) re-arms the join steps
    lastHref = location.href;
    named = false;
    contentSaid = false;
    armedUntil = Date.now() + 4 * 60_000;
    if (/\/wc\/leave|postattendee|\/leave\b/i.test(location.href)) sayLeft(`left page: ${location.pathname}`);
  }
  const t = bodyText();
  if (!contentSaid && (visibleButtons() > 0 || t.length > 40)) { contentSaid = true; report('content'); }
  if (Date.now() < armedUntil) { try { site()(); } catch { /* page mid-render */ } }
  const leave = leaveButton();
  if (leave && !inCall) { inCall = true; report('incall'); }
  // ended = the vendor's end screen is up AND the Leave button is gone, two ticks in a row (a re-render can drop
  // the button for a frame)
  const m = leave ? null : t.slice(0, 20000).match(ENDED_RE);
  if (m) { endedTicks += 1; if (endedTicks >= 2) sayLeft(`end screen: "${m[0]}"`); } else endedTicks = 0;
  if (inCall) dismissPopups(leave);
  // what the page says, every 5 s while it changes (until the join steps are done) — for the app's log
  const snippet = t.slice(0, 160);
  if (Date.now() - lastTextAt > 5_000 && snippet !== lastText && !lastClick.joined) {
    lastText = snippet; lastTextAt = Date.now();
    report(`text:${snippet || '(empty page)'}`);
  }
}
function sayLeft(why) { if (leftSaid) return; leftSaid = true; report(`why:${why}`); report('left'); }

// ---------------------------------------------------------------- pop-ups nobody in the room can close
// "Recording has started", "Transcription has started", "Your camera is turned off", tips, toasts … The TV has no
// mouse, so a banner would sit over the meeting for good (Evan 2026-11-11). Once in the call, a pop-up whose only
// job is to be closed is closed after it has been up 8 s (long enough for the room to read it). A pop-up that asks
// for a decision — explicit recording consent (Agree), Leave / End, Join audio — is never clicked; it is logged once.
const POPUP_SEL = '[role="alert"], [role="status"], [role="dialog"], [role="alertdialog"], [aria-live], [data-tid*="banner" i], [data-tid*="notification" i], [data-tid*="toast" i], [class*="toast" i], [class*="banner" i], [class*="notification" i], [class*="callout" i], [class*="message-bar" i], [class*="MessageBar"]';
const firstSeen = new WeakMap();
const noted = new WeakSet();
function dismissPopups(leave) {
  let buttons;
  try { buttons = [...document.querySelectorAll('button, [role="button"]')].filter(visible); } catch { return; }
  const now = Date.now();
  for (const b of buttons) {
    if (!labelled(b, DISMISS_RE)) continue;
    const box = b.closest(POPUP_SEL);
    if (!box || box === document.body || (leave && box.contains(leave))) continue;     // not a pop-up / the call bar
    if (!firstSeen.has(box)) { firstSeen.set(box, now); continue; }
    if (now - firstSeen.get(box) < 8_000) continue;
    const what = (box.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 120) || labels(b)[0] || 'pop-up';
    const asks = [...box.querySelectorAll('button, [role="button"]')].some((o) => o !== b && visible(o) && labelled(o, NEEDS_PERSON_RE));
    if (asks) { if (!noted.has(box)) { noted.add(box); report(`needs:${what}`); } continue; }
    try { b.click(); } catch { continue; }
    firstSeen.delete(box);
    report(`dismissed:${what}`);
  }
}

document.addEventListener('DOMContentLoaded', () => { tick(); setInterval(tick, 800); });
