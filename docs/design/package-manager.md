# Design: electron-transplant as a small package manager

Status: partly implemented. The rest is still a proposal.

## Where this stands (v0.2.1)

Shipped:

- **`source` in every recipe** (download page, feed URL, DMG URL per pin, allowed
  hosts, how long old versions stay downloadable) and **`sources.json`**, which
  lists every input with its URL and SHA-256 ([packaging.md](../packaging.md)).
  No `teamId` yet.
- **`fetch <app>`** for pinned versions: HTTPS only, redirects kept on the
  recipe's hosts, into the download cache described below. `build` and `inspect`
  look there. No `--latest`.
- **Distribution packages** instead of the phase 4 AUR package: PKGBUILDs in
  `packaging/arch/` and a Nix flake, both building from the vendor's DMG on the
  user's machine. Nothing is published to the AUR.

Not built yet:

- Reading the feeds, and `outdated`.
- Phase 2: the per-file asar check and Apple signature verification, and so
  `--latest` and the vendor-signed tier.
- `install`, `list`, `update`, `remove` and `rollback` as user commands. The name
  `install` is taken by `install <app> --from BUILD_DIR`, which installs an
  existing build; the proposed `install <app>` would extend it.
- The scheduled check for feeds moving past the newest pin, and Windows
  installers.

Goal: `electron-transplant install linear` downloads the vendor's macOS build,
verifies it, builds it and installs it, with `list`, `outdated`, `update` and
`remove` around it. The repository still distributes nothing from any vendor.

## What the vendors publish (checked 2026-11-15)

Every app's own updater config, read from its bundle (`Resources/app-update.yml`, or
the updater code in `app.asar` for Figma), points at a public feed:

| App | Feed | Latest | Hash in feed | Versioned DMG URL | Old versions kept |
| --- | --- | --- | --- | --- | --- |
| Linear | `https://releases.linear.app/latest-mac.yml` (electron-builder) | 1.32.8 (= pin) | SHA-512 per file; matches our pinned DMG | `Linear-<v>-universal.dmg` | yes (1.30.0 from April still served) |
| Notion | `https://desktop-release.notion-static.com/latest-mac.yml` (electron-builder) | **7.43.2** (pin: 7.43.0) | SHA-512 for `Notion-<v>.dmg` (x86_64) only | `Notion-<v>.dmg`, `-universal.dmg`, `-arm64.dmg` | yes (7.40.0 still served) |
| Superhuman | `https://storage.googleapis.com/download.superhuman.com/native-update/latest-mac.yml` (electron-builder) | 1045.0.0 (= pin), `stagingPercentage: 5` | SHA-512 per file; matches our pinned DMG | `Superhuman-<v>-latest.dmg` | unknown (a guessed older version 404s) |
| Figma | `https://desktop.figma.com/mac/RELEASE.json` (own format) | 126.11.9 (= pin) | **none** | `https://desktop.figma.com/mac/Figma-<v>.dmg` (same object as `Figma.dmg`) | current and previous only (older: 403) |

Notes:
- Linear's updater sends a `Linear-User-Segment` header and Superhuman's feed has a
  staging percentage: "latest" can be a staged rollout. We read the feed without
  segment headers and show the staging percentage, nothing more.
- Notion's feed names the x86_64 DMG, which is the build we already pin.
- Figma's feed gives a version and a zip URL but no hash. The Mac updater relies on
  Apple's code signature, which leads to the next section.

## Trust model

Today the only trust anchor is the repo pin (DMG SHA-256), because Apple code
signatures are not checked on Linux (SECURITY.md). A feed hash alone does not
change that: the feed and the DMG come from the same origin over the same TLS, so
it proves the download is intact, not that it is authentic or that it works.

### Apple code signatures can be checked on Linux

A short probe showed that `openssl` alone verifies the signature chain for all four
apps' current DMGs:

```
Apple Root CA (fingerprint pinned in the repo)
 └ Developer ID Certification Authority          (in the signature's CMS)
    └ Developer ID Application: <vendor> (<Team ID>)
       └ CMS signature over the main executable's CodeDirectory (x86_64 slice)
          └ special slot 1 = SHA-256 of Contents/Info.plist
             └ ElectronAsarIntegrity = SHA-256 of app.asar's header
                └ per-file SHA-256 (and block hashes) of every file in app.asar
```

- `openssl cms -verify -binary -content <CodeDirectory> -CAfile <Apple Root CA>
  -purpose any -ignore_critical` succeeds on the genuine CodeDirectory, fails on a
  one-byte change, and fails against another root. `-ignore_critical` is needed
  because Developer ID leaf certificates carry Apple's critical marker extension
  `1.2.840.113635.100.6.1.13`; we check that marker (and the intermediate's
  `…100.6.2.6`) ourselves instead.
- Team IDs: Linear `7VZ2S3V9RV`, Notion `LBQJ96FQ8D`, Figma `T8RA8NE3B7`,
  Superhuman `6XHFYUTQGX`. The CodeDirectory's identifier equals each app's
  `bundleId`.
- Resources outside `app.asar` that the build copies (icons, Notion's resources,
  Figma's files) are covered by `_CodeSignature/CodeResources`, whose hash is
  special slot 3; checking them is the same pattern.
- Gap to close first: the build checks the asar *header* hash but not each file's
  hash against the header. Today the DMG SHA-256 covers that; with the signature as
  anchor it must be checked file by file.
- Limits: certificate validity is checked at the current time (fine for current
  releases; old releases after the certificate expires fall back to pins), and
  revocation is not checked unless we add OCSP against Apple.

### Three tiers

| Tier | Accepted when | Default? | Recorded as |
| --- | --- | --- | --- |
| **pinned** | DMG SHA-256 is in `apps/<id>/app.cjs` | yes: `install`, `update` | `pinned` |
| **vendor-signed** (new) | not pinned, but: feed hash and size match, Developer ID chain to the pinned Apple root, Team ID equals the recipe's `teamId`, identifier equals `bundleId`, Info.plist, asar header, every asar file and copied resources all verified, and every patch applies exactly | only with `--latest` | `vendor-signed, untested` |
| manual | `--dmg PATH --accept-unpinned` (today's escape hatch) | no | `unpinned` (gets the signature check too once it exists, and says so) |

The exact-match patches stay the compatibility gate in every tier: a vendor
release the recipe doesn't fit fails the build, as now. A new Electron version for
a `--latest` build still needs `pins/electron.json` or falls back to the release's
`SHASUMS256.txt` as `--accept-unpinned` does today, printed loudly.

Without the signature check (i.e. before phase 2), unpinned vendor versions are
only reported by `outdated`, never installed automatically.

New repo-side trust inputs: each recipe's feed URL, allowed download hosts and
Team ID. They are reviewed like pins. Downloads are HTTPS only and every redirect
must stay on the recipe's allowed hosts.

## Recipe additions (`apps/<id>/app.cjs`)

```js
source: {
  // electron-builder latest-mac.yml, or Figma's RELEASE.json
  feed: { type: 'electron-builder', url: 'https://releases.linear.app/latest-mac.yml' },
  // the build we pin, by version; checked against the feed's file list
  dmg: 'https://releases.linear.app/Linear-{version}-universal.dmg',
  hosts: ['releases.linear.app'],
  teamId: '7VZ2S3V9RV',
},
```

`pins` stay as they are; a pin's download URL comes from `source.dmg`. The `dmg`
block (`glob`, `dir`, `app`) keeps working for `--dmg` and `~/Downloads`.

## Commands

| Command | Does |
| --- | --- |
| `fetch <app> [--version V] [--latest]` | Download the pinned (default: newest pinned) or latest DMG into the cache, verify it, print its path. No build. |
| `install <app> [--version V] [--latest] [--prefix DIR]` | `fetch` + `build` + install. Same as today's `build --install`, plus the download. |
| `list [--prefix DIR]` | Installed apps from `<prefix>/opt/<install.id>/current/TRANSPLANT.json`: version, tier, older runtimes kept. No new state file. |
| `outdated [<app>…]` | Installed, newest pinned in this checkout, vendor latest from the feed (with staging %). Read-only, network. |
| `update [<app>…] [--latest]` | Reinstall where a newer pinned (or with `--latest`, vendor-signed) version exists. |
| `remove <app> [--prefix DIR]` | Remove launcher, helpers, desktop entries, icon, share dir and `opt/<install.id>`. Never the profile; print where it is. |
| `rollback <app>` (later) | Point `current` at the previous runtime (already kept). |

`build`, `inspect`, `report` and `apps` keep working unchanged. `build` and
`inspect` also find DMGs in the download cache.

Recipes are updated with `git pull` (or a package, below); the checkout is the
package index.

### Download cache

`~/.cache/electron-transplant/downloads/<app>/<sha256>/<vendor file name>`, mode
0700. Each download goes into its own new empty directory as `<name>.partial`, is
verified (feed size and SHA-512 when present, pin SHA-256 when pinned), then renamed.
Nothing in it is ever executed; 7-Zip only reads it.

## Phases

1. **`fetch` (first slice).** `source` for the four recipes and its validation; a
   strict parser for electron-builder's `latest-mac.yml` subset and Figma's
   `RELEASE.json`; downloads with the host allowlist; pinned versions only;
   `build`/`inspect` look in the cache. Also `outdated` in its read-only form,
   since it is mostly the same code. Tests with synthetic feeds and a local server.
2. **Signature verification.** Per-file asar integrity check (useful on its own),
   Mach-O code-signature parsing, CMS check with openssl against a pinned Apple
   root, Team ID in recipes, CodeResources for copied resources. Then `--latest`.
3. **`install`, `list`, `update`, `remove`**, `rollback` later.
4. **Later.** A scheduled CI job that opens an issue when a feed moves past the
   newest pin; an AUR package per app whose PKGBUILD lists the vendor DMG URL and
   pinned hash in `source=()`/`sha256sums=()` and runs the build (still distributing
   nothing); Windows installers as a second source (Authenticode, separate design).

## Open questions

1. Is the vendor-signed tier acceptable, behind `--latest` and labelled untested?
   The alternative is pins only, with `outdated` just reporting newer versions.
2. ~~Download cache under `~/.cache/electron-transplant/downloads` (proposed) or
   `~/Downloads/<dir>` as today?~~ Decided: the cache, as proposed. `build` and
   `inspect` still find DMGs in `~/Downloads` too.
3. Should `outdated`/`update` run a check for recipe updates (a `git fetch` of the
   checkout), or leave that to the user?
