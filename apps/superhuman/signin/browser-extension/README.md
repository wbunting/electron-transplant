# Superhuman Linux Login (Chromium-based browsers)

Superhuman's desktop sign-in finishes in your browser, on a page that hands the
result back to the app. That page only does so for Windows and macOS browsers; on
Linux it reports "login attempt expired" instead. This extension does the hand-off.

One-time setup in the browser you sign in with:

1. Open `chrome://extensions` (Chromium, Chrome, Helium, Brave…).
2. Enable **Developer mode**.
3. Choose **Load unpacked** and select the installed directory, by full path:
   `~/.local/share/superhuman-desktop/browser-extension`
4. Start a fresh sign-in from the desktop app. Approve the browser's
   **Open Superhuman** prompt. If automatic opening is blocked, use the
   extension's **Open Superhuman** button on the callback page.

Only the exact HTTPS `mail.superhuman.com/~login` path (optional trailing slash)
is accepted, with a native-app authorization code and exactly one Google or
Microsoft login identity. Regular web logins, lookalike hosts, missing or
duplicate identities and invalid callbacks are ignored. Responses stay
byte-for-byte unchanged; the app still validates its own pending OAuth state.
No analytics, network requests, cookies, clipboard access, storage, background
service or browser permissions. Nothing is logged. The callback URL is still in
the original browser tab; close it after login.

The manifest match pattern needs a path wildcard for callback changes; the script
checks the exact path before doing anything. The extension does not suppress
Superhuman's own error or claim that forwarding completed a login.

This is a locally loaded extension, not a store release. Keep the installed folder
in place. After a reinstall, click Reload on `chrome://extensions` and start a new
login. Remove it from `chrome://extensions` to uninstall. The installer never
modifies a browser profile or policy. Firefox packaging is not included.

Without the extension: copy the callback tab's full URL, then run
**Superhuman Desktop — Finish browser sign-in** from your app launcher (or
`superhuman-desktop-finish-login` in a terminal). It forwards the URL to the app
and clears the clipboard. Never share a real callback URL: it contains an
authorization code.
