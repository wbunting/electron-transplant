// No storage, network, cookies or OAuth validation bypass. The app checks state.
(function (root) {
  'use strict';
  function nativeCallback(value) {
    try {
      if (typeof value !== 'string' || value.length > 65536 || /[\x00-\x20\x7f]/.test(value)) return null;
      const url = new URL(value);
      if (url.origin !== 'https://mail.superhuman.com' || url.username || url.password
          || !['/~login', '/~login/'].includes(url.pathname)) return null;
      const response = url.hash.slice(1).replace(/#app$/, '');
      if (!response || response.includes('#') || /%(?![0-9a-f]{2})/i.test(response)) return null;
      const fields = new URLSearchParams(response);
      const codes = fields.getAll('code'), states = fields.getAll('state');
      if (codes.length !== 1 || !codes[0] || states.length !== 1 || !states[0].startsWith('native-login:')) return null;
      if (/[\x00-\x1f\x7f\ufffd]/.test(codes[0] + states[0])) return null;
      const state = new URLSearchParams(states[0].slice('native-login:'.length));
      const providers = state.getAll('provider'), ids = state.getAll('loginUuid');
      if (providers.length !== 1 || !['google', 'microsoft'].includes(providers[0])
          || ids.length !== 1 || !ids[0] || /[\x00-\x1f\x7f\ufffd]/.test(ids[0])) return null;
      return 'superhuman://~login/' + response;
    } catch { return null; }
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = { nativeCallback };
  else root.SuperhumanLinuxLogin = Object.freeze({ nativeCallback });
})(globalThis);
