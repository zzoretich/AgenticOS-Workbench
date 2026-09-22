#!/bin/sh
# Stand-in for the `ollama` binary in tests and the CI rehearsal. The install gate only asks whether
# the binary exists (mandatory-prereqs D1); it is never spawned for anything but --version.
case "$1" in
  --version|-v) echo "ollama version is 0.0.0-fake" ;;
  *) exit 0 ;;
esac
