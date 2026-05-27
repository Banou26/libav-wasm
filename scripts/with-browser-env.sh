#!/usr/bin/env bash
# Sets the env vars playwright needs to find/run its bundled browsers, then exec's its args.
# Mostly NixOS-specific: the bundled Firefox/Chromium expect /usr/lib paths that aren't there.
# On other distros this is a no-op. Use as: ./scripts/with-browser-env.sh npx playwright test
set -e

if [ -e /etc/NIXOS ]; then
  # NixOS often pre-sets PLAYWRIGHT_BROWSERS_PATH to a read-only /nix/store path with
  # SKIP_BROWSER_DOWNLOAD=1, expecting the system's nixpkgs-managed browsers. We do our own
  # `playwright install` into the user cache, so override.
  export PLAYWRIGHT_BROWSERS_PATH="$HOME/.cache/ms-playwright"
  unset PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD

  # Bake in lib paths from the system Firefox's nix closure, covering every GTK/freetype/etc
  # the bundled playwright Firefox needs. Filter out store paths without a lib/ dir to keep
  # the loader from choking on garbage paths.
  SYS_FF=$(readlink -f "$(command -v firefox 2>/dev/null)" 2>/dev/null || true)
  if [ -n "$SYS_FF" ] && [[ "$SYS_FF" == /nix/store/* ]]; then
    ROOT=$(dirname "$(dirname "$SYS_FF")")
    LIBS=""
    for p in $(nix-store -qR "$ROOT" 2>/dev/null); do
      [ -d "$p/lib" ] && LIBS="$LIBS$p/lib:"
    done
    export LD_LIBRARY_PATH="${LIBS%:}"
  fi
fi

exec "$@"
