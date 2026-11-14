// Isolated content script, only on the Superhuman login page. Never logs URLs.
(() => {
  'use strict';
  if (window.top !== window) return;
  const { nativeCallback } = globalThis.SuperhumanLinuxLogin;
  const attempted = new Set(); // memory only; gone when this document closes
  let panel;
  function forward() {
    const target = nativeCallback(location.href);
    if (target) {
      try { location.assign(target); } catch { /* the visible button remains */ }
    }
  }
  function update() {
    const target = nativeCallback(location.href);
    if (!target) { panel?.remove(); panel = null; return; }
    // Wait until the callback document is ready before opening another app;
    // document_start navigation can leave Chromium's initial page load pending.
    if (!document.documentElement || document.readyState === 'loading') return;
    if (!panel) {
      panel = document.createElement('div');
      panel.id = 'superhuman-linux-login';
      panel.style.cssText = 'position:fixed!important;inset:16px 16px auto auto!important;z-index:2147483647!important;max-width:380px!important;';
      const shadow = panel.attachShadow({ mode: 'closed' });
      const style = document.createElement('style');
      style.textContent = ':host{all:initial}section{font:15px/1.5 system-ui,sans-serif;color:#222;background:#fff;border:1px solid #bbb;border-radius:12px;padding:20px;box-shadow:0 6px 24px #0004}h2{font-size:18px;margin:0 0 8px}p{margin:8px 0}button{font:600 15px system-ui;cursor:pointer;background:#563c85;color:white;border:0;border-radius:8px;padding:12px 18px}';
      const section = document.createElement('section');
      section.setAttribute('role', 'region');
      section.setAttribute('aria-label', 'Superhuman Linux desktop sign-in');
      const heading = document.createElement('h2');
      heading.textContent = 'Finish signing in to Superhuman';
      const message = document.createElement('p');
      message.textContent = 'We tried opening the desktop app. If your browser asks, choose Open Superhuman. Otherwise use the button below.';
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = 'Open Superhuman';
      button.addEventListener('click', forward);
      const note = document.createElement('p');
      note.textContent = 'The website’s “expired” message can be a Linux redirect issue. A genuinely expired login still needs a fresh sign-in from the app.';
      section.append(heading, message, button, note);
      shadow.append(style, section);
      document.documentElement.append(panel);
    }
    if (!attempted.has(target)) {
      attempted.add(target);
      forward();
    }
  }
  window.addEventListener('hashchange', update);
  window.addEventListener('pageshow', update);
  document.addEventListener('DOMContentLoaded', update, { once: true });
  update();
})();
