#!/usr/bin/env bash
# Rootless 7-Zip for DMG/HFS+ extraction on Arch: download the repo package,
# verify its signature against the system pacman keyring, unpack into the cache.
# Prints the path of the 7z binary. No sudo, no system package changes.
set -euo pipefail
cache="${XDG_CACHE_HOME:-$HOME/.cache}/electron-transplant/tools"
for command in pacman pacman-key bsdtar curl; do
  command -v "$command" >/dev/null || {
    echo "No 7-Zip found. Install your distribution's 7zip package (it provides 7zz or 7z), or set SEVENZIP=/path/to/7z." >&2
    echo "(The rootless fallback only works on Arch: it needs $command.)" >&2
    exit 1
  }
done
version=$(LC_ALL=C pacman -Si extra/7zip | awk -F': ' '/^Version/ {print $2; exit}')
[[ -n "$version" ]] || { echo 'Could not resolve the extra/7zip version from the local sync database.' >&2; exit 1; }
package="7zip-$version-x86_64.pkg.tar.zst"
binary="$cache/7zip-$version/usr/lib/7zip/7z"
if [[ -x "$binary" ]]; then printf '%s\n' "$binary"; exit 0; fi
mkdir -p "$cache"
mirror=$(awk -F' = ' '/^Server/ {print $2; exit}' /etc/pacman.d/mirrorlist)
[[ -n "$mirror" ]] || { echo 'No Server in /etc/pacman.d/mirrorlist.' >&2; exit 1; }
url="${mirror//\$repo/extra}"
url="${url//\$arch/x86_64}/$package"
# A stale local sync database names a version mirrors have dropped; the archive keeps it.
archive="https://archive.archlinux.org/packages/7/7zip/$package"
fetch() {
  curl --fail --location --retry 2 --silent --show-error --output "$cache/$package$2.partial" "$1$2"
}
for suffix in '' .sig; do
  fetch "$url" "$suffix" 2>/dev/null || fetch "$archive" "$suffix"
  mv "$cache/$package$suffix.partial" "$cache/$package$suffix"
done
pacman-key --verify "$cache/$package.sig" "$cache/$package" >&2 || {
  rm -f "$cache/$package" "$cache/$package.sig"
  echo 'Signature verification failed; deleted the download.' >&2; exit 1;
}
mkdir -p "$cache/7zip-$version"
bsdtar -xf "$cache/$package" -C "$cache/7zip-$version" usr/lib/7zip
printf '%s\n' "$binary"
