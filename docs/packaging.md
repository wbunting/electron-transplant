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

## Nix

`flake.nix` packages every app in `sources.json` for `x86_64-linux`. Each package
downloads the vendor's DMG from the vendor with `fetchurl` and builds it locally in
the Nix sandbox. No app is cached anywhere, and none of them is in nixpkgs.

| Output | What it is |
| --- | --- |
| `packages.x86_64-linux.{linear,figma,notion,superhuman}` | the apps (`linear-desktop-1.32.8`, …); `nix run` starts the launcher |
| `overlays.default` | `pkgs.linear-desktop`, `pkgs.figma-desktop`, `pkgs.notion-desktop`, `pkgs.superhuman-desktop` (nixpkgs already has `linear` and `notion`) |
| `lib.mkTransplantApp pkgs { app; version ? null; variant ? null; }` | any pin, e.g. `{ app = "notion"; variant = "x86_64"; }` (default: the first pin, as `build` picks it) |
| `checks`, `formatter`, `devShells.default` | evaluation of every pin, `npm test` in the sandbox, nixfmt; Node, Python, unzip and 7-Zip for working on this repository |

```sh
nix build github:wbunting/electron-transplant#linear      # ./result/bin/linear-desktop
nix profile add github:wbunting/electron-transplant#linear # `nix profile install` on older Nix
nix profile add github:wbunting/electron-transplant#figma
linear-desktop
```

On NixOS, or with Home Manager:

```nix
# flake inputs
inputs.electron-transplant.url = "github:wbunting/electron-transplant";
inputs.electron-transplant.inputs.nixpkgs.follows = "nixpkgs"; # optional: build with your nixpkgs

# NixOS: the overlay, with your own unfree settings
nixpkgs.overlays = [ inputs.electron-transplant.overlays.default ];
nixpkgs.config.allowUnfreePredicate = pkg: builtins.elem (lib.getName pkg) [ "linear-desktop" "figma-desktop" ];
environment.systemPackages = [ pkgs.linear-desktop pkgs.figma-desktop ];

# Home Manager: the flake's packages as they are
home.packages = [ inputs.electron-transplant.packages.${pkgs.stdenv.hostPlatform.system}.linear ];
```

**Unfree.** The apps are the vendors' (`meta.license` is `unfree`; electron-transplant's
own code in them is MIT). The flake's `packages` come from a nixpkgs that allows exactly
these four packages, because asking for one of them is already the choice to use that
vendor's app. The overlay builds with your nixpkgs, so your `allowUnfree` or
`allowUnfreePredicate` decides, as for any other unfree package.

**What the derivation does** (`nix/app.nix`): `fetchurl` the pin's DMG, Electron zip
and npm tarballs (URLs and hashes from `sources.json`); `electron-transplant build
--offline` with them and nixpkgs' `_7zz`; `install --layout package --prefix $out`;
then the treatment nixpkgs gives its own binary Electron: `autoPatchelfHook` on
`lib/<installId>` with the same libraries, nixpkgs' Vulkan loader in place of the
bundled one, and a launcher wrapped by `wrapGAppsHook3` (GSettings schemas,
`XDG_DATA_DIRS`) with `xdg-open`, `fc-list` (Figma's local fonts) and clipboard tools
(Superhuman's sign-in helper) after your own `PATH`. The vendor's and Electron's
files are not stripped or rewritten otherwise. `@electron/asar` comes from
`package-lock.json` through nixpkgs' `importNpmLock`, so there is no extra hash to keep
in sync. A pin bump here (`npm run sources`) needs no Nix change.

**A DMG that can't be downloaded any more.** Figma serves only its current and previous
release, so two Figma releases after a pin, `fetchurl` fails with HTTP 403. A copy of
the pinned DMG with the right hash still builds: add it to the store under its pinned
file name (`dmg.file`) and the build finds it there instead of downloading.

```sh
nix-store --add-fixed sha256 Figma-126.11.9.dmg   # the file must have the pinned name and hash
# or: nix-prefetch-url file:///path/to/Figma-126.11.9.dmg
nix build github:wbunting/electron-transplant#figma
```

The DMG isn't part of the built package, so `nix-collect-garbage` removes it again;
add it again before the next rebuild. A pin with no URL at all asks for the file the
same way (`requireFile`).

**Updates and rollback.** Nothing polls the vendors and the apps' own updaters are off:
a new version arrives when this repository pins it. Then `nix profile upgrade linear`
(or `--all`), or `nix flake update electron-transplant` in your own flake and a
rebuild, downloads the new DMG and builds it. `nix profile rollback` (`nix profile
history` lists generations), NixOS and Home Manager generations go back. An older
revision of this repository builds its own pins
(`nix build github:wbunting/electron-transplant/<rev>#linear`), as long as the vendor
still serves that DMG.

**Outside NixOS** (Arch, Fedora, … with Nix installed):

- Desktop entries and icons are in `~/.nix-profile/share` (`~/.local/state/nix/profile/share`
  with `use-xdg-base-directories`). The Nix installer's shell profile adds it to
  `XDG_DATA_DIRS`; check that your graphical session gets it too, or launchers won't
  list the apps. `Exec=` points into the store, so `PATH` doesn't matter. A rootless
  install (`build --install`) of the same app has a desktop entry in
  `~/.local/share/applications` with the same name, which wins: remove one of them.
- URL schemes: the desktop entries list them, but nothing becomes a default handler.
  `xdg-mime default linear-desktop.desktop x-scheme-handler/linear` makes it one.
- GPU: nixpkgs' OpenGL and Vulkan look for drivers only where NixOS puts them
  (`/run/opengl-driver`). Elsewhere Chromium falls back to software rendering, which
  works for these apps but costs CPU. [nixGL](https://github.com/nix-community/nixGL)
  (`nix run --impure github:nix-community/nixGL -- linear-desktop`, or Home Manager's
  `targets.genericLinux.nixGL`) provides the host's drivers.
- Fonts come from the system's fontconfig setup (`/etc/fonts`).
- The sandbox needs unprivileged user namespaces, which Arch and most distributions
  allow; `chrome-sandbox` can't be setuid in the store.
- The app's profile (`~/.config/Linear`, …) is the same one other installs use.
