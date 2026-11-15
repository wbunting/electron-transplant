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
      "envPrefix": "LINEAR",         // <PREFIX> of the app's environment variables
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

## Arch Linux (pacman)

`packaging/arch/<app>/` holds a PKGBUILD and `.SRCINFO` for each app's preferred pin:

```sh
git clone https://github.com/wbunting/electron-transplant
cd electron-transplant/packaging/arch/linear
makepkg -si
```

makepkg downloads the vendor's DMG from the vendor, the Linux Electron zip from
GitHub, electron-transplant at its release tag and `@electron/asar`'s tarballs from
npm, and checks every one against `sha256sums`. `build()` is the offline build and
`package()` the staged install above. `-s` installs missing dependencies and `-i`
the package, with pacman (both ask for sudo). Or build without installing and
install the file yourself: `makepkg -s`, then `sudo pacman -U linear-transplant-*.pkg.tar.zst`.

| App | Package | Command | `conflicts=` |
| --- | --- | --- | --- |
| Linear | `linear-transplant` | `linear-desktop` | `linear-bin` (AUR; ships `/usr/bin/linear-desktop` and `/usr/lib/linear-desktop`) |
| Figma | `figma-transplant` | `figma-desktop` | |
| Notion | `notion-transplant` | `notion-desktop` | `notion-desktop` (Omarchy's package, and the AUR's `notion-desktop-git`, which provides it; both ship `/usr/bin/notion-desktop`) |
| Superhuman | `superhuman-transplant` | `superhuman-desktop` | |

Package names end in `-transplant` so they collide with nothing: the AUR has
`linear-bin`, `linear-desktop-bin`, `linear-electron`, `figma-linux`,
`notion-app-electron`, `superhuman` and more, packaging other builds of these apps.
`conflicts=` (the app config's `install.conflicts`) lists the packages that install
the same files. The packages `provide` nothing: no other package name describes
them accurately.

### What the PKGBUILD does

- `source=`: the DMG (as `<pinned file>::<vendor URL>`), the Electron zip, npm
  prebuilds (Notion), electron-transplant (`git+https://…#tag=v<version>`) and
  `package-lock.json`'s tarballs. Every file has its sha256; only the git source is
  `SKIP`, as for any git source (the tag or commit pins it). Archives are in
  `noextract=`: the build reads them by name. The npm tarballs' sha256s are in
  `packaging/arch/npm-sources.json`, derived from tarballs verified against the
  lockfile's sha512.
- `prepare()` unpacks `@electron/asar` and its dependencies where
  `npm ci --ignore-scripts` would; no npm, no network.
- `build()`: `electron-transplant build <app> --offline --inputs "$srcdir" --dmg … --sevenzip /usr/lib/7zip/7z`.
- `package()`: `electron-transplant install <app> --layout package --prefix /usr --destdir "$pkgdir"`,
  and `/usr/share/licenses/<pkgname>` links to the licence directory.
- `options=('!strip' '!debug')`: Electron's binaries stay exactly as Electron ships them.
- `license=('LicenseRef-proprietary' 'MIT' 'BSD-3-Clause')`: the vendor's app (its
  own terms), Electron and electron-transplant, Chromium (`LICENSES.chromium.html`
  lists the rest).
- `pkgver` is the vendor's version (characters pacman doesn't allow become `_`), `pkgrel` 1.
- `depends=` are the Electron binary's libraries (namcap finds no missing ones),
  bash and `hicolor-icon-theme`; `optdepends=` libnotify, libsecret and xdg-utils,
  which Electron loads or runs when present.
- No install scriptlet: pacman's hooks (desktop-file-utils, gtk-update-icon-cache)
  refresh the desktop database and icon cache. The desktop entry lists the app's URL
  schemes; it doesn't become their default handler (`xdg-mime default
  linear-desktop.desktop x-scheme-handler/linear` makes it one).

### Generating PKGBUILDs

```sh
electron-transplant pkgbuild <app> [--version V] [--variant NOTE] [--commit SHA | --local]
                             [--pkgrel N] [--maintainer 'NAME <EMAIL>'] [--out DIR] [--build]
```

Prints the PKGBUILD for a pin (default: the app's first), or with `--out DIR` writes
it and its `.SRCINFO` (as `makepkg --printsrcinfo` writes it; makepkg isn't needed).
electron-transplant itself comes from:

- the release tag `v<version>` of `package.json` (default; what `packaging/arch/` uses);
- `--commit SHA`: a commit already pushed to GitHub, pinned with `#commit=`;
- `--local`: a tarball of this checkout as it is (uncommitted changes and new files,
  not ignored ones), written beside the PKGBUILD with its sha256. For trying a
  change before it is pushed; never publish one.

The build checks the DMG against the pins of the electron-transplant it runs, so a
tag or commit must pin the same DMG; the command checks that in your checkout and
refuses otherwise. `--build` also runs `makepkg --cleanbuild --force --syncdeps` in
DIR (default `~/.cache/electron-transplant/pkgbuild/<app>`, so downloads are
reused) and prints the package to install with `sudo pacman -U`.
`electron-transplant pkgbuild --write` regenerates `packaging/arch/` (`--refresh-npm`
after `package-lock.json` changes); `npm test` fails when it drifts.

### Release tags

A committed PKGBUILD can't name the commit that contains it, so `packaging/arch/`
pins the release tag `v<version>` instead. A change to anything a build needs (a
pin, a patch, the build itself) is released by bumping `package.json`'s version,
regenerating, merging, and then tagging the merge commit `v<version>` and pushing
the tag. Until the tag is pushed, the committed PKGBUILDs can't fetch
electron-transplant: generate one with `--commit` or `--local` instead.
`pkgbuild --write` fails if the tag exists locally with different pins.

### Updates

1. A new vendor release is pinned here (CONTRIBUTING.md), with a version bump and
   regenerated PKGBUILDs, and tagged once merged.
2. Its `pkgver` is the new vendor version, so pacman sees an upgrade.
3. `git pull`, then `makepkg -si` in `packaging/arch/<app>` again (or the AUR
   helper's upgrade, for a package published there). A fix to electron-transplant
   alone, with the same vendor version, needs `--pkgrel 2` and so on.

The apps never update themselves (their updaters are patched off). Figma keeps only
its current and previous release downloadable: its DMG URL stops working once Figma
has shipped two newer releases. The hash still matches the same DMG obtained another
way: put it in the PKGBUILD's directory (or `SRCDEST`) under its pinned file name.

### Publishing to the AUR

Nothing here publishes anything. To publish a package, a maintainer would check the
name is still free (`https://aur.archlinux.org/rpc/v5/info?arg[]=linear-transplant`),
then:

```sh
electron-transplant pkgbuild linear --commit "$(git rev-parse v0.2.0^{commit})" \
  --maintainer 'Name <email>' --out /tmp/aur-linear
cd /tmp/aur-linear && makepkg -s && namcap PKGBUILD *.pkg.tar.zst
git clone ssh://aur@aur.archlinux.org/linear-transplant.git && cp PKGBUILD .SRCINFO linear-transplant/
cd linear-transplant && git add PKGBUILD .SRCINFO && git commit -m 'linear-transplant 1.32.8-1' && git push
```

The package is a build recipe: it downloads the vendor's DMG from the vendor and
distributes nothing of theirs, as the AUR requires. Keep Figma's package current:
its source URL lasts for one more Figma release.
