# How electron-transplant works

The [README](../README.md) has the overview. This is the detail: what the build does
to a DMG, what runs inside the app, and how to check a build.

## Pipeline (`lib/build.cjs`)

Inputs: the vendor DMG (`fetch` downloads it from the recipe's `source.dmg` URL into
`~/.cache/electron-transplant/downloads/<app>/<sha256>/`, over HTTPS on the recipe's
`source.hosts` only, verified before it is renamed into place; `build` also looks in
`~/Downloads`), the Linux Electron zip, npm prebuild tarballs and 7-Zip. All of them
can be passed explicitly; `--offline` then uses only those and never the network,
the caches or `$HOME` ([packaging.md](packaging.md)). `sources.json` lists them per
pin, generated from the recipes (`lib/sources.cjs`).

1. **Extract** with 7-Zip (UDIF → HFS+): only `Info.plist`, `Resources/` and the
   Electron framework's `Info.plist`, never HFS+ extended attributes. Nothing from
   the DMG is executed. The `.app` is found by listing the image (volume names vary).
   Without a system 7-Zip, `scripts/fetch-7zip.sh` fetches Arch's package and
   verifies it with `pacman-key`, rootless.
2. **Verify**: the DMG's SHA-256 against the app's pins; `app.asar`'s header hash
   against the bundle's `ElectronAsarIntegrity`; the Linux Electron zip and its
   `electron.d.ts` against `pins/electron.json`. Unpinned versions need
   `--accept-unpinned`, which takes hashes from the release's `SHASUMS256.txt` and
   prints what to pin. Apple's code signature itself is not checked (no Linux tooling);
   the pins are the trust anchor.
3. **Native code**: each module in the config is `shim`med (JS file), `stub`bed
   (generated: records the call, throws), `remove`d (when the module has its own Linux
   path) or replaced by an `npm-prebuild` from its integrity-pinned npm tarball.
   Addons outside packages (`nativeFiles`, e.g. Figma's `bindings.node`) can only be
   removed, with a reason. App-specific Linux code is copied in with `addFiles`. Then
   *every* file in the app and resources is scanned: any Mach-O, Windows or
   non-x86-64 ELF binary fails the build.
4. **Patch**: exact-match source patches, each with an expected match count, so a
   changed bundle fails instead of shipping half-patched.
5. **Compat entry**: `package.json` `main` → `linux-compat/entry.cjs` (original kept
   as `originalMain`), `desktopName` set so Wayland `app_id` and
   `setAsDefaultProtocolClient` match the installed desktop file.
6. **Assemble**: Linux Electron + repacked `app.asar` (`*.node` unpacked), resources
   minus Mac-only files, derived resources (e.g. Notion's Linux tray icons from its
   menu-bar template icon), icon from `CFBundleIconFile`, and `TRANSPLANT.json`
   recording what was done.

Extraction tolerates one kind of malformed archive: invalid placeholder entries an
app names in `asar.dropInvalidEntries` (Figma's `/.codesign`, size −1000) are left out
via a sanitised copy; the integrity check hashes the header as stored.

## Install layout (`lib/install.cjs`)

Two layouts. Packages use `install --layout package`: `<prefix>/lib/<id>`, final
paths baked in, staged into a DESTDIR, no side effects ([packaging.md](packaging.md)).
The rootless install, below, is for a checkout.

`--install` puts the runtime in `~/.local/opt/<id>/<version>-local-<hash>/` behind an
atomic `current` symlink (old runtimes stay for rollback), plus a launcher in
`~/.local/bin`, a desktop entry registering the app's URL schemes, and the icon.
Profiles (`~/.config/Linear`, `~/.config/Notion`) are never touched.
The desktop entry names its icon by absolute path: Vicinae ignores
`~/.local/share/icons/hicolor` (no `index.theme`), so a theme name shows a placeholder
there. An existing `icon-theme.cache` in that directory is also regenerated for GTK.

## Compatibility layer (`compat/`, runs in the app's main process)

- **Recorder** (`runtime.cjs`): observation only, behaviour unchanged. Records reads of
  macOS/Windows-only Electron members (listed per Electron version from its own
  `@platform` typings), calls to platform-tagged no-ops, failed native loads (with
  binary format), spawns of missing executables (`/usr/sbin/screencapture`…), throwing
  IPC handlers and uncaught errors, with stack frames into the app's bundle; child
  processes that die (renderers, GPU, utility processes such as an app's Node
  workers); and how each session ended. A session with no clean-exit record ended in
  a native crash, SIGKILL or power loss, and `report` lists it with any Crashpad
  minidumps in the app's `crashDumps` directory. Arguments, URLs and the home path are
  never logged. `electron-transplant report <app>`.
- **Facade** (`facade.cjs`): Electron's exports are read-only getters, so the app's own
  files get a modified `electron` module instead: `require('electron')` and
  `require('electron/main')` through `Module._load`, ES `import` through
  `module.registerHooks`. Unmodified exports forward lazily.
- **Window chrome** (`window-chrome.cjs`): windows created with `titleBarStyle`
  `hidden`/`hiddenInset`/`customButtonsOnHover` get macOS traffic lights in a small
  sandboxed overlay view kept above the app's views. `trafficLightPosition`,
  `setWindowButtonPosition`, `getWindowButtonPosition` and `setWindowButtonVisibility`
  work. Buttons follow focus, theme and fullscreen as on macOS; clicks don't take
  focus. `titleBarOverlay` is dropped: on Linux it would draw Windows-style buttons
  too. The window keeps its normal frame because Hyprland floats frameless
  (client-side-decorated) windows; `<PREFIX>_FRAMELESS=1` opts out.
  The overlay models each Electron button frame as 14×16 with a 12px circle, 20px apart
  (pre-Tahoe macOS). That is unverified against a real Mac.
- **Protocol client guard** (`compat.defaultProtocolClient: false`): the app's
  `app.setAsDefaultProtocolClient` is recorded and declined (on Linux it runs
  `xdg-settings`), for schemes another installed app keeps. `install.defaultSchemes`
  likewise limits which registered schemes the install makes default (`xdg-mime
  default`); the rest are only listed in the desktop entry.
  `<PREFIX>_DEFAULT_PROTOCOL_CLIENT=1` restores the call.
- **Hooks** (`compat.hooks`): app files (from `addFiles`) the entry loads before the
  app's main, given `electron`, the env reader and the recorder.
- **Page adapter** (`title-bar-page-adapter.cjs`, opt-in per app): for apps whose
  *remote* web UI only makes room for the buttons on macOS (Linear checks
  `navigator.platform`), it pads the title-bar row clear of the buttons and centres
  them on it. Apps with local UI (Notion's tab bar) are patched directly instead.

| Variable (`LINEAR_…`, `NOTION_…`) | Effect |
| --- | --- |
| `<PREFIX>_TRAFFIC_LIGHTS=0` | no emulated buttons; normal frame |
| `<PREFIX>_FRAMELESS=1` | frameless window as on macOS |
| `<PREFIX>_USE_WAYLAND=0` | XWayland instead of native Wayland |
| `<PREFIX>_COMPAT_LOG=FILE` | recorder log (default `~/.local/state/electron-transplant/<app>/compat-events.jsonl`) |
| `<PREFIX>_COMPAT_FACADE=0` | debugging only: no facade |

Launchers pass no sandbox-disabling switches (Chromium uses its user-namespace
sandbox), which Linear refuses to start with anyway.

## Checking a build without touching the desktop

`scripts/dev-snapshot.cjs RUNTIME OUT STEPS.json [-- APP_ARGS]` runs a throwaway copy
of a built runtime under Electron's headless platform with a throwaway profile
(`--user-data-dir` and `XDG_CONFIG_HOME`, for apps like Figma that pick their own) and a
step script (`bounds`, `wait`, `focus`, `hover`, `click`, `eval` (`at` or `in`: a
view by URL), `main` (main-process code), `state`, `snapshot`),
compositing every view into PNGs. Headless Electron ignores fullscreen, and native dialogs crash it.
`ET_SMOKE=1 npm test` does a headless launch of every built app.

## Tests

`npm test`: unit tests (including downloads against a fake server, offline input
checks, package staging and `sources.json` drift); real-Electron tests (recorder
unchanged-behaviour on 44.9.1 and 45.1.0, facade via `require`/`electron/main`/
`import`/ES main, traffic lights and page adapter, glyph centring at 1×/1.5×/2×);
install/launcher; and a full build of every app whose pinned DMG is in its download
directory or the download cache, run as a package build: offline, explicit inputs,
no `$HOME`, then staged for `/usr`. Electron tests skip when the pinned zip isn't
cached (`~/.cache/electron-transplant`); `npm run fetch-electron` downloads and
verifies every pinned version. CI runs everything except the DMG builds.
