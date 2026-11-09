'use strict';
// Runs inside the meeting view (Teams / Zoom / Meet web client). Does what a person in the room would do:
// "Continue on this browser", type the screen's name, click Join, join computer audio — then watches for the
// meeting ending and tells the app. It only ever reads the page and clicks / types; it never sends page data
// anywhere. Vendors change their join screens now and then: every lookup has a data-attribute first choice and a
// visible-text fallback, and a miss just means someone clicks Join on the TV (as before the app).
const { ipcRenderer } = require('electron');

let screenName = 'Conference room';
ipcRenderer.invoke('meeting:config').then((c) => { if (c && c.name) screenName = String(c.name).slice(0, 80); }).catch(() => undefined);
const report = (ev) => { try { ipcRenderer.send('meeting:event', ev); } catch { /* view closing */ } };

// ---------------------------------------------------------------- DOM helpers
const clicked = new WeakSet();
const visible = (el) => !!el && el.offsetParent !== null && !el.disabled && el.getAttribute('aria-disabled') !== 'true';
const text = (el) => ((el.innerText || el.textContent || el.value || '') + ' ' + (el.getAttribute('aria-label') || '')).replace(/\s+/g, ' ').trim();
function clickOnce(el, why) {
  if (!el || clicked.has(el)) return false;
  clicked.add(el);
  try { el.click(); } catch { return false; }
  report(why);
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

let named = false;
function typeName(input) {
  if (!input || named) return false;
  if ((input.value || '').trim() === screenName) { named = true; return false; }
  setValue(input, screenName);
  named = true;
  report('named');
  return true;
}

const JOIN_RE = /^(join now|join|join meeting|ask to join|join anyway)$/i;
const AUDIO_RE = /join audio by computer|join with computer audio|computer audio/i;
const LEFT_RE = /you(’|')?ve left|you left the (meeting|call)|the meeting has ended|has been ended|ended by host|removed you from|left the call|call ended|meeting ended|you have been removed/i;

// ---------------------------------------------------------------- per-site steps
function teams() {
  // launcher.html: "Continue on this browser" (new and old markup)
  clickOnce($('button[data-tid="joinOnWeb"]') || byText('button, a', /continue on this browser|use the web app instead|join on the web/i), 'launcher');
  // pre-join: name + Join
  typeName($('input[data-tid="prejoin-display-name-input"]') || $('#username') || nameInput());
  if (named) clickOnce($('button[data-tid="prejoin-join-button"]') || byText('button', JOIN_RE), 'joined');
  // no camera / mic on this PC yet → Teams offers to continue without
  clickOnce(byText('button', /continue without (audio|video|devices)|join without/i), 'joined');
}
function zoom() {
  // zoom.us/j/<id> (unrewritten): the in-browser client link
  clickOnce(byText('a, button', /join from your browser/i), 'launcher');
  typeName($('#input-for-name') || $('input[placeholder*="name" i]') || nameInput());
  if (named) clickOnce($('button.preview-join-button') || $('#joinBtn') || byText('button', JOIN_RE), 'joined');
  clickOnce($('button.join-audio-by-voip__join-btn') || byText('button', AUDIO_RE), 'audio');
  // "I agree" to Zoom's terms, shown to anonymous web participants
  clickOnce(byText('button', /^i agree$/i), 'launcher');
}
function meet() {
  typeName($('input[aria-label*="name" i]') || nameInput());
  if (named) clickOnce(byText('button', /^(ask to join|join now)$/i), 'joined');
  clickOnce(byText('button', /continue without (microphone|camera)/i), 'joined');
}
function generic() {
  typeName(nameInput());
  if (named) clickOnce(byText('button', JOIN_RE), 'joined');
}

function site() {
  const h = location.hostname;
  if (/(^|\.)teams\.(microsoft|live)\.com$/i.test(h)) return teams;
  if (/(^|\.)zoom\.(us|com)$/i.test(h)) return zoom;
  if (/(^|\.)meet\.google\.com$/i.test(h)) return meet;
  return generic;
}

// ---------------------------------------------------------------- loop
let leftSaid = false;
let lastHref = '';
let armedUntil = 0;
function tick() {
  if (location.href !== lastHref) {                     // every navigation (SPA or real) re-arms the join steps
    lastHref = location.href;
    named = false;
    armedUntil = Date.now() + 4 * 60_000;
    if (/\/wc\/leave|postattendee|\/leave\b/i.test(location.href)) sayLeft();
  }
  if (Date.now() < armedUntil) { try { site()(); } catch { /* page mid-render */ } }
  if (!leftSaid && document.body && LEFT_RE.test((document.body.innerText || '').slice(0, 20000))) sayLeft();
}
function sayLeft() { if (leftSaid) return; leftSaid = true; report('left'); }

document.addEventListener('DOMContentLoaded', () => { tick(); setInterval(tick, 800); });
