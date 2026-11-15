# Packaging electron-transplant apps

What a package (a PKGBUILD, a Nix derivation) needs from electron-transplant: the
list of inputs with their hashes, an offline build that takes them explicitly, and
a staged install in a system layout. The package still distributes nothing from a
vendor: it downloads the vendor's DMG from the vendor and builds it on the
user's machine.

## Inputs: `sources.json`

`sources.json` at the repository root lists every input per app and pinned version.
It is generated from `apps/*/app.cjs` (`pins`, `source`) and `pins/electron.json`
(`npm run sources`) and `npm test` fails if it drifts, so it always matches the
checkout. Read it as plain JSON (Nix: `builtins.fromJSON (builtins.readFile
./sources.json)`), or print it with `electron-transplant sources [<app>] --json`
(one app's entry when an app is given).

```jsonc
{
  "schema": 1,                       // bumped on incompatible changes
  "generated": "…",
  "apps": {
    "linear": {
      "name": "Linear",              // vendor's app name
      "bundleId": "com.linear",
      "installId": "linear-desktop", // directory, desktop file and icon name
      "command": "linear-desktop",   // launcher in <prefix>/bin
      "displayName": "Linear",       // desktop entry Name=
      "comment": "…",                // desktop entry Comment= (a package description)
      "helpers": [],                 // extra commands in <prefix>/bin (Superhuman has one)
      "downloadPage": "https://linear.app/download",
      "feed": { "type": "electron-builder", "url": "https://releases.linear.app/latest-mac.yml" },
      "pins": [                      // preferred first; build any one of them
        {
          "version": "1.32.8",
          "variant": "universal",    // universal or x86_64 (macOS architectures in the DMG)
          "dmg": {
            "file": "Linear-1.32.8-universal.dmg",
            "sha256": "08d42b91…",
            "url": "https://releases.linear.app/Linear-1.32.8-universal.dmg",  // null: none known
            "versioned": true,       // false: the URL serves the latest release
            "retention": "all"       // all | current-and-previous | unknown
          },
          "electron": {              // the official Linux build of the app's Electron
            "version": "44.9.1",
            "file": "electron-v44.9.1-linux-x64.zip",
            "url": "https://github.com/electron/electron/releases/download/v44.9.1/electron-v44.9.1-linux-x64.zip",
            "sha256": "994bc366…"
          },
          "npm": [                   // npm prebuilds the build copies in (Notion: better-sqlite3)
            // { "package", "version", "file", "url", "sha256", "integrity": "sha512-…" }
          ]
        }
      ]
    }
  }
}
```

Every URL is HTTPS. All four apps' DMG URLs are versioned. `retention` says how long
the vendor keeps a version downloadable: Figma serves only the current and previous
release (older ones return 403), so a Figma package's source URL stops working two
releases later; the hash is still right for a DMG obtained another way. With
`versioned: false` a hash mismatch means the vendor shipped a new release, which
needs pinning here first. The feed is information only (what the app's own updater
reads); nothing here polls it yet.

## Fetch

```sh
electron-transplant fetch <app> [--version V] [--variant NOTE] [--dest DIR] [--electron | --all]
```

Downloads the pin's DMG from `dmg.url` (HTTPS, redirects only to the app's allowed
hosts), verifies its SHA-256 and only then gives it its name. Default destination:
`~/.cache/electron-transplant/downloads/<app>/<sha256>/<file>`, where `build` and
`inspect` find it. `--electron` fetches the Electron zip instead, `--all` every input
an offline build needs; `--dest DIR` puts them in DIR under their `file` names. An
existing file is reused if it verifies and never overwritten if it doesn't. With no
URL it prints where to get the DMG and exits 1. Packages normally let their own
fetcher download the same URLs and hashes instead.

## Offline build

```sh
electron-transplant build <app> --offline --out DIR \
  --dmg PATH --electron-zip PATH [--npm-tarball PATH]... [--sevenzip PATH]
electron-transplant build <app> --offline --out DIR --inputs SRCDIR [--sevenzip PATH]
```

`--offline` uses only the given inputs: no network, and nothing read or written in
`~/Downloads`, the caches or `$HOME` (it runs with `HOME=/homeless-shelter`).
`--inputs DIR` finds the inputs by their `file` names (a PKGBUILD's `$srcdir`); npm
tarballs are matched by hash, so store paths with prefixes work. Each missing input is
named, with its URL and hash, before anything is extracted. All verification stays:
DMG pin, `app.asar` integrity against the bundle, Electron pin, the scan for foreign
binaries, exact-match patches. `--out` must be new or empty; the runtime is
`DIR/runtime` (the rest of DIR is intermediate, vendor-derived, not to be installed).

Build-time tools: Node.js 22.15+, Python 3, `unzip`, `tar` (npm prebuilds only) and
7-Zip (`7zz` or `7z` on PATH, or `--sevenzip`; Arch `7zip`, nixpkgs `_7zz`). The
build runs nothing from the DMG. `@electron/asar` comes from `npm ci --ignore-scripts`
in the checkout (one dependency, see `package-lock.json`).

Two builds of the same inputs give byte-identical files. `TRANSPLANT.json`'s
`builtAt` is `SOURCE_DATE_EPOCH` when set; file modification times are whatever the
packaging tool sets.

## Staged install

```sh
electron-transplant install <app> --from BUILD_DIR --layout package --prefix /usr --destdir "$pkgdir"
electron-transplant install <app> --from BUILD_DIR --layout package --prefix "$out"
```

`--from` takes the `--out` directory (or its `runtime/`). Files go to
`DESTDIR/PREFIX` (no `--destdir`: straight into the prefix, as with Nix's `$out`),
and every path written into them is the final `PREFIX` path. Linear under `/usr`:

```
usr/bin/linear-desktop                                launcher (bash)
usr/lib/linear-desktop/                               Electron + the app (electron, resources/app.asar, …)
usr/share/applications/linear-desktop.desktop         Exec=/usr/bin/linear-desktop -- %u, MimeType=x-scheme-handler/linear;
usr/share/icons/hicolor/512x512/apps/linear-desktop.png
usr/share/licenses/linear-desktop/                    LICENSE.electron, LICENSES.chromium.html, LICENSE.electron-transplant
```

Figma is the same with `figma-desktop` and `MimeType=x-scheme-handler/figma;x-scheme-handler/figma-desktop;`.
Apps with `install.share` and `install.helpers` (Superhuman) also get
`share/<installId>/` and a command and desktop entry per helper.

Package mode differs from the rootless `build --install`: no versioned
`opt/<id>/<version>` directories or `current` symlink (the package manager keeps
versions), the icon by theme name, no record of the checkout, and no side effects:
it never runs `update-desktop-database`, `gtk-update-icon-cache` or `xdg-mime`
(pacman hooks and Nix profiles do the first two) and writes nothing outside
DESTDIR. It never makes the app a URL scheme's default handler either; the desktop
entry lists the schemes the app handles (including ones `install.defaultSchemes`
keeps from becoming the default in a rootless install, such as Figma's `figma://` and
Superhuman's `mailto:`). The prefix must be an absolute path of plain characters
(`/usr`, `/nix/store/…`).

## Runtime notes

- The runtime is Electron's official Linux build: an `electron` binary needing glib2,
  gtk3, nss, nspr, at-spi2-core, cups, dbus, cairo, pango, libX11, libxcb,
  libXcomposite, libXdamage, libXext, libXfixes, libXrandr, libxkbcommon, mesa
  (libgbm), expat, systemd-libs (libudev) and alsa-lib, plus its bundled
  `libffmpeg.so`, `libvulkan.so.1` and SwiftShader. On Nix it needs the usual
  `autoPatchelfHook` treatment.
- Chromium's sandbox: launchers pass no sandbox-disabling switches (Linear refuses
  to start with them). It uses unprivileged user namespaces; `chrome-sandbox` is
  installed as in the zip, mode 0755, not setuid. Where user namespaces are
  disabled, the app won't start unless `chrome-sandbox` is setuid root.
- Launchers use `#!/usr/bin/env bash`, select Wayland or X11 at start
  (`<PREFIX>_USE_WAYLAND`), log to `$XDG_CACHE_HOME/<installId>/launcher.log` and
  honour `<PREFIX>_APP_DIR` to point at another runtime.
- The apps' own updaters are patched off; updates come from new pins here.
