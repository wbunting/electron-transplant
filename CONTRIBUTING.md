# Contributing

Thanks for helping. Most contributions are one of two kinds: updating an app to a
new vendor release, or adding an app. Both start from the vendor's DMG and end with
a pinned hash, so builds stay reproducible and verifiable.

## Setup

```sh
npm ci --ignore-scripts
npm run fetch-electron   # pinned Linux Electron builds, so the Electron tests run
npm test
```

`npm test` also builds every app whose pinned DMG is on your machine (see the README
for where each one goes). `ET_SMOKE=1 npm test` additionally launches each build
headless and checks that it starts without errors.

## Updating an app to a new version

Vendors ship often, so this is the most common change.

1. Download the new macOS DMG (Intel or universal) from the vendor into the app's
   download directory (README, "Getting the apps").
2. `electron-transplant inspect <app>` shows the version, its Electron version, any
   new native code, and whether each configured patch still matches.
3. Fix patches that no longer match. They are exact-match on purpose: a changed
   bundle fails the build instead of shipping half-patched. Find the same code in
   the new bundle and update `from`/`to` (and `count`).
4. `electron-transplant build <app> --accept-unpinned` prints the DMG's SHA-256 and,
   for a new Electron version, the hashes to pin.
5. Check the build:
   - `ET_SMOKE=1 npm test` for a headless launch;
   - run it with a throwaway profile (the build prints the command), sign in if you
     can, and use it for a bit;
   - `electron-transplant report <app>` lists the Mac-only APIs it hit at runtime.
6. Pin it:
   - add `{ sha256, version, electron, note }` to the app's `pins`, with a comment
     giving the vendor URL you downloaded it from;
   - for a new Electron version, add its hashes to `pins/electron.json` and commit
     `compat/platform-apis/electron-<version>.json` from
     `~/.cache/electron-transplant/platform-apis/`.
7. `npm test`, then open a pull request saying what you checked and what you didn't.

## Adding an app

See "Adding an app" in the README. Each app lives in `apps/<id>/` with an `app.cjs`
and whatever shims, notes (`NATIVE.md`) and helper files it needs.

## Rules

- **No vendor code or binaries in the repository**: no DMGs, extracted bundles,
  built runtimes or Mach-O files. Patches quote the smallest snippet that matches
  uniquely; a short comment explains why the patch exists.
- **No private data**: no screenshots or logs with account data, and never a real
  sign-in callback URL (they carry authorization codes). Test fixtures are synthetic.
- **Keep the sandbox**: launchers and patches must not disable Chromium's sandbox.
- **Fail loudly**: prefer a patch that fails on a changed bundle over one that
  silently does nothing. Set `count` when a snippet should match more than once.
- **Linux-only changes**: guard behaviour changes with `process.platform === 'linux'`
  so the patched code still reads as what the vendor wrote for macOS.
- Add tests for new build, install or compat behaviour (`tests/`).

## Reporting problems

Use the issue templates: they ask for `inspect` or `report` output, which is what
it takes to diagnose most problems. Security issues: see [SECURITY.md](SECURITY.md).
