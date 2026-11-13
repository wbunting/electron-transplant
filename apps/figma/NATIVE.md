# Figma 126.11.9 (macOS) on Linux

Source: `https://desktop.figma.com/mac/Figma.dmg` (Intel build), downloaded into its own
directory, `~/Downloads/figma-desktop-mac/`, and renamed `Figma-126.11.9.dmg`
(sha256 `e908f72f…0ee9`, pinned in `app.cjs`). `mac/RELEASE.json` names the same
version; there is also a `Figma-<version>.zip`, but the DMG fits the existing
pipeline. Nothing from it is executed: 7-Zip extracts `Info.plist`, `Resources/` and
the Electron framework's `Info.plist`.

- Bundle `com.figma.Desktop`, Electron **44.11.2**, URL scheme `figma`, icon `electron.icns`.
- `app.asar` (9.8 MB, `ElectronAsarIntegrity` verified) has an invalid placeholder
  entry, `/.codesign` (size −1000, offset 0). Electron never reads it, but
  `@electron/asar` rejects the whole header. `asar.dropInvalidEntries` leaves out
  exactly that entry; the integrity hash is of the header as stored.
- Code: `main.js` (1.5 MB esbuild bundle), `desktop_shell.js` (local tab bar React
  app), `*_binding_renderer.js` preloads, `bindings_worker.js` (font utility
  process), `lazy/external/*.js` (MCP server, push, sandbox runtime, proxy agent),
  `node_modules/` (chokidar and deps only).

## Native code

| File | What it is | macOS APIs | Linux |
| --- | --- | --- | --- |
| `bindings.node` (Swift/ObjC, x86_64) | Grab-bag of desktop integrations: spelling (`CheckSpelling`, `AddWord`…), eyedropper sessions and screen capture permission, cursor tracking and custom cursors, `launchApp`/`getAppPathForProtocol`/`getBundleVersion`/code-signing status (installer and agent management), `getActiveNSScreens`, P3 colour-space check, haptics, menu shortcuts, memory-pressure listener, window accessibility/animation tweaks, Apple Intelligence status, Vision background removal and subject masks, Windows-only GPU stats and file-type registration | AppKit, CoreGraphics, ScreenCaptureKit/TCC, NSSpellChecker, Vision | **Never loaded.** `main.js` has `DC = process.platform === "linux"`, and uses its own JS object (`Qtt()`: every function a no-op, `""`, `[]` or `false`) instead. Removed (`nativeFiles`). |
| `desktop_rust.node` (Rust, x86_64) | Font library: `getFonts`, `getModifiedFonts`, `getFontsModifiedAt` (CoreText enumeration with a `font_cache.json`), `getFontPreview` (runs the bundled `figma_agent` to render an SVG sample), `getMacOsGpuData` | CoreText, IOKit | Figma's Linux path substitutes empty fonts. **Replaced by `linux/fonts.cjs`** (fontconfig + `linux/sfnt.cjs` for variable-font axes), same JSON shape as the addon's `FontInfo`/`FontVariationAxisInfo` structs. |
| `node_modules/fsevents/fsevents.node` (universal) | macOS file-system events for chokidar | FSEvents | chokidar only requires it on darwin, in `try/catch`; `fsevents.js` throws off macOS first. Removed. |
| `Contents/Library/FigmaAgent.app` (not extracted) | `figma_agent`: the local font helper browsers use on `127.0.0.1:44950`, and the font-preview renderer | | Figma's agent code returns "Unsupported platform: linux" and is skipped. Not needed by the desktop app itself (it gets fonts through `getFonts`). Browsers on this host can use figma-agent-linux. |
| `Contents/Library/Figma Desktop.app` (`figma_universal_links`) | Universal Links helper app | | Not extracted; darwin-only. |
| `Contents/Library/QuickLook/Figma.qlgenerator` | Finder previews | QuickLook | Not extracted. |

## What Figma's own Linux path already does

`main.js` has real Linux branches: it skips the updater (`process.platform === "linux"`),
the font agent and enterprise policy, parses argv for URLs and files, and on Linux
renders its non-macOS tab bar with its own app menu, minimise, maximise and close
buttons (the Windows layout). Mac-only behaviour is mostly gated on `se = darwin`.

## Patches and Linux behaviour (`app.cjs`)

- **Fonts** (`fonts-worker-linux`, `fonts-utility-process-on-linux`,
  `fonts-direct-linux`): fontconfig fonts in Figma's font utility process, as on
  macOS. Figma itself serves the files (`getFontFileToken` → `desktop-file:`) and only
  for listed paths. Previews are `""`, as in Figma's own Linux stub; the font menu
  shows plain names.
- **Window** (`main-window-frame-on-linux`): Figma's main window is frameless with its
  own buttons in the tab bar. It keeps a normal frame on Linux (the compositor draws
  none) and auto-hides the menu bar a framed window would otherwise show (Alt shows
  it). `FIGMA_DESKTOP_FRAMELESS=1` restores frameless. No emulated traffic lights.
- **argv** (`argv-double-dash`): Figma's Linux parser treated `--` as a flag taking
  the next argument, so the desktop entry's `figma-desktop -- %u` dropped the URL.
- **figma:// stays with figma-linux-next**: Figma calls `setAsDefaultProtocolClient`
  at every start (on Linux: `xdg-settings set default-url-scheme-handler`); the compat
  entry declines it (`compat.defaultProtocolClient: false`), and the install lists
  `figma` in the desktop entry without making it default (`install.defaultSchemes`).
- **Sign-in** (`auth-scheme-request`, `auth-scheme-links`): "Log in with browser" opens
  `https://www.figma.com/app_auth/<id>/grant?desktop_protocol=…`, and figma.com's
  "Open the desktop app" button sends the browser to
  `` `${desktop_protocol || "figma"}://app_auth/redeem?g_secret=…` `` (its auth
  bundle; only VS Code/Cursor protocols are special-cased). On Linux the app asks for
  `figma-desktop`, a scheme only it registers (and is the default for), and maps
  `figma-desktop://…` onto `https://www.figma.com/…` exactly as Figma maps `figma://…`.
  The link reaches the running app through Figma's own single-instance handoff, and
  Figma redeems it only for the sign-in it started. Unverified: whether figma.com's
  signed-in grant page restricts `desktop_protocol` (signed out, it passes any value
  through its login redirect; Figma's own PR builds use arbitrary `figma-*` schemes).
- **MCP** (`linux/hooks.cjs`): Figma's Dev Mode MCP server runs on Linux. The web app
  asks for port 3845; figma-linux-next serves its own MCP server there. Figma silently
  ignores `EADDRINUSE`; here it is recorded (`report`), and a dialog names the process
  holding the port and how to resolve it. `FIGMA_DESKTOP_MCP_PORT=<port>` serves on
  another port so both can run (MCP clients then use `http://127.0.0.1:<port>/mcp`).

## Mac-only APIs still hit (`electron-transplant report figma`)

All harmless reads with Linux fallbacks: `app.runningUnderARM64Translation` (×3 call
sites: analytics, startup, ARM translation dialog), `app.isAccessibilitySupportEnabled`
(screen reader focus), `Tray.setIgnoreDoubleClickEvents` (darwin tray). Plus
`declined-call app.setAsDefaultProtocolClient` (intended, above). No failed native
loads, missing executables or IPC handler errors at startup.

Not ported (darwin-gated in Figma, so absent rather than broken): global eyedropper
outside the window, overlay windows, haptics, Apple Vision background removal,
`getActiveNSScreens`, Finder QuickLook, the browser font agent.
