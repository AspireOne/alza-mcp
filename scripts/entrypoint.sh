#!/bin/sh
set -eu
rm -f /tmp/.X99-lock /tmp/.X11-unix/X99
Xvfb :99 -screen 0 1280x900x24 -nolisten tcp -ac &
export DISPLAY=:99
attempt=0
while [ ! -S /tmp/.X11-unix/X99 ]; do
  attempt=$((attempt + 1))
  if [ "$attempt" -gt 100 ]; then
    echo 'Xvfb did not become ready.' >&2
    exit 1
  fi
  sleep 0.05
done
# Keep Node as tini's direct child so SIGTERM waits for its graceful shutdown.
exec node /app/dist/index.js "$@"
