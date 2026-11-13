# electron-transplant

Runs macOS-only Electron apps on Linux. Electron's JavaScript API is the same on
every platform, so an app's code can move from its macOS Electron onto the official
**Linux** build of the *same* Electron version. What breaks is the Mac-native part.
This tool handles that part per app and adds a compatibility layer for macOS-only
behaviour (currently: traffic-light window buttons).

Rootless, x86_64; built on Arch/Hyprland (Wayland, HiDPI). Apps: **Linear**, **Notion**, **Figma**.

```sh
cd ~/.local/src/electron-transplant
npm ci --ignore-scripts && npm test
ln -s "$PWD/bin/electron-transplant" ~/.local/bin/    # optional

electron-transplant apps                         # configured apps and pinned versions
electron-transplant inspect notion               # survey the DMG before (re)writing a config
electron-transplant build notion                 # newest ~/Downloads/Notion-*.dmg -> build/
electron-transplant build notion --install       # + install under ~/.local
electron-transplant report notion                # what Mac-only APIs it hit at runtime
```

`--install` puts the runtime in `~/.local/opt/<id>/<version>-local-<hash>/` behind an
atomic `current` symlink (old runtimes stay for rollback), plus a launcher in
`~/.local/bin`, a desktop entry registering the app's URL schemes, and the icon.
Profiles (`~/.config/Linear`, `~/.config/Notion`) are never touched.
The desktop entry names its icon by absolute path: Vicinae ignores
`~/.local/share/icons/hicolor` (no `index.theme`), so a theme name shows a placeholder
there. An existing `icon-theme.cache` in that directory is also regenerated for GTK.

| App | Launcher | Schemes | Native code |
| --- | --- | --- | --- |
| Linear 1.32.8 (Electron 44.9.1) | `linear-desktop` | `linear` | 3 trackpad addons → shims |
| Notion 7.43.0 (Electron 45.1.0) | `notion-desktop` | `notion`, `notion-agents` | `better-sqlite3` → official Node-API prebuild; 3 others stubbed/trimmed |
| Figma 126.11.9 (Electron 44.11.2) | `figma-desktop` | `figma-desktop`; `figma` registered, **not** default | none loaded on Linux (Figma's own JS path); fonts → fontconfig module |

(`linear` and `notion` are the CLIs, hence `-desktop`; `figma-desktop` sits beside
figma-linux-next, which stays the `figma://` handler. See `apps/figma/NATIVE.md`.)

## Pipeline (`lib/build.cjs`)

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

## Compatibility layer (`compat/`, runs in the app's main process)

- **Recorder** (`runtime.cjs`): observation only, behaviour unchanged. Records reads of
  macOS/Windows-only Electron members (listed per Electron version from its own
  `@platform` typings), calls to platform-tagged no-ops, failed native loads (with
  binary format), spawns of missing executables (`/usr/sbin/screencapture`…), throwing
  IPC handlers and uncaught errors, with stack frames into the app's bundle. Arguments,
  URLs and the home path are never logged. `electron-transplant report <app>`.
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

Figma only (`apps/figma/NATIVE.md`):

| Variable | Effect |
| --- | --- |
| `FIGMA_DESKTOP_MCP_PORT=N` | serve Figma's MCP server on N instead of 3845 (figma-linux-next uses 3845) |
| `FIGMA_DESKTOP_FRAMELESS=1` | frameless main window |

Launchers pass no sandbox-disabling switches (Chromium uses its user-namespace
sandbox), which Linear refuses to start with anyway.

## Adding an app

1. Put its DMG in `~/Downloads` (or its own subdirectory, `dmg.dir`, to keep the
   untrusted download apart), copy an `apps/<id>/app.cjs`, set `id`, `name`,
   `bundleId`, `envPrefix`, `dmg`, `install` (`install.name` for the launcher name,
   `install.schemes`/`install.defaultSchemes` for extra and default URL schemes).
2. `electron-transplant inspect <id>` lists its native code (handled or not), Mach-O
   resources, how it loads Electron, macOS window-chrome calls, platform checks and
   whether configured patches match.
3. Handle each native module and resource; read the bundle around its `darwin`
   window-chrome checks and add patches where its Linux branch should look like macOS.
4. `build <id> --accept-unpinned`, check it (below), then add the printed hashes.

## Checking a build without touching the desktop

`scripts/dev-snapshot.cjs RUNTIME OUT STEPS.json [-- APP_ARGS]` runs a throwaway copy
of a built runtime under Electron's headless platform with a throwaway profile
(`--user-data-dir` and `XDG_CONFIG_HOME`, for apps like Figma that pick their own) and a
step script (`bounds`, `wait`, `focus`, `hover`, `click`, `eval` (`at` or `in`: a
view by URL), `main` (main-process code), `state`, `snapshot`),
compositing every view into PNGs. Headless Electron ignores fullscreen, and native dialogs crash it.
`ET_SMOKE=1 npm test` does a headless launch of every built app.

## Tests

`npm test`: unit tests; real-Electron tests (recorder unchanged-behaviour on 44.9.1 and
45.1.0, facade via `require`/`electron/main`/`import`/ES main, traffic lights and page
adapter, glyph centring at 1×/1.5×/2×); install/launcher; and a full build of every
app whose pinned DMG is in its download directory. Electron tests skip when the pinned zip
isn't cached (`~/.cache/electron-transplant`).
