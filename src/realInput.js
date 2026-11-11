'use strict';
// Real input for the meeting view: the app moves the mouse, clicks and types into the meeting page the way a person
// at the TV would (Electron's webContents.sendInputEvent → the page sees isTrusted events, with a pointer that moved
// there first and keys pressed one at a time). v0.1.6 clicked Join with element.click() and set the name through the
// input's value setter — script events Teams' 2026 bot detection reads as an automated join, so the TV landed in the
// lobby flagged as a "suspected bot" (Evan 2026-11-11: "the screens are being added as bots to the meeting").
// Coordinates are CSS pixels inside the view (getBoundingClientRect), which is what sendInputEvent takes at zoom 1.

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const between = (a, b) => a + Math.floor(Math.random() * (b - a));

// sendInputEvent key codes are accelerator names: letters / digits as themselves, a few named keys
const KEY_NAMES = { ' ': 'Space', '+': 'Plus' };
const keyName = (ch) => KEY_NAMES[ch] || ch;

async function click(wc, x, y) {
  // arrive from a little to the side, like a mouse would
  wc.sendInputEvent({ type: 'mouseMove', x: Math.max(0, x - between(20, 60)), y: Math.max(0, y - between(5, 25)) });
  await wait(between(40, 90));
  wc.sendInputEvent({ type: 'mouseMove', x, y });
  await wait(between(60, 140));
  wc.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
  await wait(between(50, 110));
  wc.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
  await wait(between(80, 160));
}

// replaces whatever the focused field holds with `text`, one key at a time
async function type(wc, text) {
  wc.selectAll();
  await wait(between(80, 150));
  for (const ch of String(text).replace(/[\u0000-\u001f\u007f]/g, '')) {
    if (!/^[\x20-\x7e]$/.test(ch)) {                        // é, ñ, emoji …: no single key — insert it (still trusted)
      await wc.insertText(ch);
      await wait(between(55, 140));
      continue;
    }
    const k = keyName(ch);
    wc.sendInputEvent({ type: 'keyDown', keyCode: k });
    wc.sendInputEvent({ type: 'char', keyCode: ch });
    wc.sendInputEvent({ type: 'keyUp', keyCode: k });
    await wait(between(55, 140));
  }
  await wait(between(100, 200));
}

module.exports = { click, type };
