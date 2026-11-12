// Page side of the Linux traffic lights (session preload, isolated world).
// Apps whose web UI only lays out around the buttons on macOS (Linear, for one, checks
// navigator.platform) put controls where the buttons sit. This finds the
// title-bar row under the buttons, shifts its contents clear of them, and reports
// the row's centre so the buttons line up with it. Main decides which pages
// take part; elsewhere this does nothing.
'use strict';
(() => {
  const { ipcRenderer, webFrame } = require('electron');
  if (window.top !== window) return;
  const CHANNEL = 'linux-compat:chrome';
  // Title-bar band, in CSS px at zoom 1 (Linear treats double-clicks above 60px as the title bar).
  const BAND = 60;
  const STEP = 6;
  const INTERACTIVE = 'button, a[href], [role="button"], [role="tab"], input, textarea, select, [contenteditable="true"]';
  const MARK = 'data-linux-compat-clear';

  let zone = null;
  let row = null;
  let original = null;
  let lastReport = '';
  let timer = null;

  function release() {
    if (!row) return;
    if (original.value) row.style.setProperty('padding-left', original.value, original.priority);
    else row.style.removeProperty('padding-left');
    row.removeAttribute(MARK);
    row = null;
    original = null;
  }

  function hitsInZone(zoom) {
    const right = zone.clearRight / zoom;
    const hits = new Set();
    for (let y = STEP / 2; y < BAND; y += STEP) {
      for (let x = zone.x / zoom; x < right; x += STEP) {
        for (const element of document.elementsFromPoint(x, y)) {
          const hit = element.closest(INTERACTIVE);
          if (hit) { hits.add(hit); break; }
        }
      }
    }
    return [...hits];
  }

  // Nearest horizontal flex container that spans well beyond the control.
  function rowOf(control) {
    const width = control.getBoundingClientRect().width;
    for (let element = control.parentElement; element && element !== document.body; element = element.parentElement) {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      if (rect.height > BAND + 8) return null;
      if (style.display.endsWith('flex') && !style.flexDirection.startsWith('column') && rect.width >= width * 3) return element;
    }
    return null;
  }

  function leftmostControl(container) {
    let best = null;
    for (const element of container.querySelectorAll(INTERACTIVE)) {
      const rect = element.getBoundingClientRect();
      if (rect.width && rect.height && (!best || rect.left < best.left)) best = { element, left: rect.left };
    }
    return best;
  }

  function clear(target, zoom) {
    if (target !== row) {
      release();
      row = target;
      original = { value: row.style.getPropertyValue('padding-left'), priority: row.style.getPropertyPriority('padding-left') };
      row.setAttribute(MARK, getComputedStyle(row).paddingLeft);
    }
    const base = parseFloat(row.getAttribute(MARK)) || 0;
    const current = parseFloat(getComputedStyle(row).paddingLeft) || 0;
    const first = leftmostControl(row);
    if (!first) return;
    const leftWithoutUs = first.left - (current - base);
    const padding = base + Math.max(0, zone.clearRight / zoom - leftWithoutUs);
    if (Math.abs(padding - current) > 0.5) row.style.setProperty('padding-left', `${padding}px`, 'important');
  }

  function layout() {
    timer = null;
    if (!zone?.lit) {
      release();
      report(null);
      return;
    }
    const zoom = webFrame.getZoomFactor() || 1;
    if (row && (!row.isConnected || row.getBoundingClientRect().top > BAND)) release();
    // Our own shift empties the zone, so new hits mean a different row now overlaps.
    // Rows below the one we hold (a content header, say) never reach the buttons.
    const held = row?.getBoundingClientRect();
    const hits = hitsInZone(zoom)
      .filter((hit) => !row?.contains(hit))
      .map((hit) => ({ hit, rect: hit.getBoundingClientRect() }))
      .filter(({ rect }) => !held || rect.top < held.bottom);
    if (hits.length) {
      // The title bar is the topmost row; leftmost breaks ties.
      hits.sort((a, b) => a.rect.top - b.rect.top || a.rect.left - b.rect.left);
      const target = rowOf(hits[0].hit);
      if (target) clear(target, zoom);
    } else if (row) {
      clear(row, zoom);
    }
    if (!row) { report(null); return; }
    const rect = row.getBoundingClientRect();
    report((rect.top + rect.height / 2) * zoom);
  }

  function report(centerY) {
    const layout = { centerY: centerY === null ? null : Math.round(centerY), dark: document.documentElement.classList.contains('dark') };
    const key = JSON.stringify(layout);
    if (key === lastReport) return;
    lastReport = key;
    ipcRenderer.send(`${CHANNEL}:layout`, layout);
  }

  function schedule() {
    if (zone && !timer) timer = setTimeout(() => requestAnimationFrame(layout), 120);
  }

  function apply(state) {
    zone = state && typeof state === 'object' ? state : null;
    lastReport = '';
    if (!zone) { release(); return; }
    schedule();
  }

  ipcRenderer.on(`${CHANNEL}:state`, (_event, state) => apply(state));
  ipcRenderer.on(`${CHANNEL}:request`, () => { lastReport = ''; schedule(); });
  window.addEventListener('DOMContentLoaded', () => {
    new MutationObserver(schedule).observe(document.documentElement, { childList: true, subtree: true });
    // Theme switches toggle the root's `dark` class (a second observe() on one observer would replace the first).
    new MutationObserver(schedule).observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    new ResizeObserver(schedule).observe(document.documentElement);
    window.addEventListener('resize', schedule);
    ipcRenderer.invoke(`${CHANNEL}:hello`).then(apply, () => {});
  });
})();
