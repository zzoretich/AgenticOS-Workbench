#!/bin/sh
# Stand-in for npm in tests: records args; `install` links a prepared node_modules into the cwd
# (the installer runs `npm install --omit=dev` in the vendored runtime; no lockfile is involved).
echo "$*" >> "${FAKE_NPM_LOG:-/dev/null}"
case "$1" in
  install)
    if [ -n "${FAKE_NPM_NODE_MODULES:-}" ] && [ ! -e node_modules ]; then ln -s "$FAKE_NPM_NODE_MODULES" node_modules; fi ;;
esac
exit 0
