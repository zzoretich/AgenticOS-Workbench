#!/bin/sh
# Stand-in for the `claude` CLI in tests and the CI rehearsal. Records every call, answers the
# read-only queries cli/aos.js makes, and exits 0 for everything else (install/uninstall/marketplace).
# Test knob: FAKE_CLAUDE_FAIL_INSTALL=1 makes `plugin install` print to stderr and exit 1, to
# exercise installPlugin()'s allowFail path without touching the network.
echo "$*" >> "${FAKE_CLAUDE_LOG:-/dev/null}"
case "$1 $2" in
  "--version ") echo "0.0.0-fake (Claude Code)" ;;
  "auth status") echo '{"loggedIn":true,"authMethod":"fake"}' ;;
  "plugin list")
    if [ -n "${FAKE_PLUGIN_PATH:-}" ]; then
      printf '[{"id":"agenticos@agenticos-workbench","version":"0.1.0","scope":"user","enabled":true,"installPath":"%s"}]\n' "$FAKE_PLUGIN_PATH"
    else
      echo '[]'
    fi ;;
  "plugin install")
    if [ "${FAKE_CLAUDE_FAIL_INSTALL:-}" = "1" ]; then
      echo "fake: install failed" >&2
      exit 1
    fi ;;
esac
exit 0
