#!/usr/bin/env bash
# xdg-open first on the app's PATH when its launcher set up nixpkgs' Mesa
# (nix/gl-setup.sh): the browser or viewer it starts gets the host's own graphics
# setup, not that Mesa, and this directory leaves PATH. Then the next xdg-open on
# PATH (the user's own, or nixpkgs' after it) opens the link or file.
set -euo pipefail
here=$(dirname -- "$(readlink -f -- "${BASH_SOURCE[0]}")")
for var in ${ET_NIX_GL_VARS-}; do
  unset "$var"
done
unset ET_NIX_GL_VARS
dirs=()
IFS=: read -ra entries <<<"${PATH-}"
for dir in "${entries[@]}"; do
  if [[ -n $dir && $(readlink -f -- "$dir") != "$here" ]]; then
    dirs+=("$dir")
  fi
done
PATH=$(IFS=: && printf '%s' "${dirs[*]}")
export PATH
exec xdg-open "$@"
