# Security

## Reporting a vulnerability

Please report security problems privately through GitHub: the repository's
**Security** tab → **Report a vulnerability**. Don't open a public issue.

Problems in the apps themselves (Linear, Notion, Figma, Superhuman) belong with
their vendors, unless this project's changes cause them.

## What the build trusts, and how it checks

The vendor's DMG is untrusted input until verified:

- It is read with 7-Zip, never mounted, and nothing from it is executed at build time.
- Its SHA-256 must match a pin in `apps/<app>/app.cjs`. Apple's code signature is
  **not** checked (there's no Linux tooling for it), so the pins are the trust
  anchor: a pin should only be added for a DMG downloaded from the vendor.
- `app.asar`'s header hash must match the bundle's own `ElectronAsarIntegrity`.
- The Linux Electron build and its typings must match `pins/electron.json`;
  replacement native modules come from integrity-pinned npm tarballs.
- After assembly, every file is scanned: any Mach-O, Windows or non-x86_64 ELF
  binary fails the build.

`--accept-unpinned` takes Electron's hashes from its release `SHASUMS256.txt` and
builds an unpinned DMG for testing; it prints the hashes rather than trusting them
silently.

## At runtime

- Chromium's sandbox stays on; launchers pass no sandbox-disabling switches.
- The compatibility layer's recorder logs API names and stack frames into the app's
  bundle, never arguments, URLs or the home path.
- Sign-in helpers (Superhuman's browser extension and clipboard helper, Figma's
  `figma-desktop://` scheme) accept only narrowly validated callbacks for the app,
  pass them on unchanged, and log nothing from them. The app still validates the
  sign-in it started.
- Auto-updaters are disabled: they would try to install macOS releases.
  Updates come from rebuilding against a newer pinned DMG.
