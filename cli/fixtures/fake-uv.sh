#!/bin/sh
# Stand-in for `uv` in tests and the CI rehearsal (spec 2026-09-23-graphify §5). `uv tool install … graphifyy==X` drops
# fake-graphify.sh into $UV_TOOL_BIN_DIR as `graphify` and records X as the version it reports. No network.
# Knobs: FAKE_UV_LOG (one line of args per call), FAKE_UV_FAIL=1 (install fails), FAKE_UV_INSTALLS_VERSION (report
# this version instead of the requested one, to prove the post-install check).
[ -n "${FAKE_UV_LOG:-}" ] && echo "$*" >> "$FAKE_UV_LOG"
case "$1" in
  --version) echo "uv 0.0.0-fake" ;;
  tool)
    [ "$2" = install ] || exit 0
    if [ -n "${FAKE_UV_FAIL:-}" ]; then echo "error: fake uv install failure" >&2; exit 2; fi
    ver=""
    for a in "$@"; do case "$a" in graphifyy==*) ver="${a#graphifyy==}" ;; esac; done
    [ -n "${UV_TOOL_BIN_DIR:-}" ] || { echo "error: UV_TOOL_BIN_DIR is not set" >&2; exit 2; }
    mkdir -p "$UV_TOOL_BIN_DIR" "${UV_TOOL_DIR:-$UV_TOOL_BIN_DIR}"
    cp "$(dirname "$0")/fake-graphify.sh" "$UV_TOOL_BIN_DIR/graphify"
    chmod 755 "$UV_TOOL_BIN_DIR/graphify"
    printf '%s\n' "${FAKE_UV_INSTALLS_VERSION:-$ver}" > "$UV_TOOL_BIN_DIR/.fake-graphify-version"
    echo "Installed 1 executable: graphify"
    ;;
  *) exit 0 ;;
esac
