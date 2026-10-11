#!/bin/sh
# ./data is a bind mount that Docker creates as root; give it to the app user,
# then drop root and start the server.
set -e
mkdir -p /app/data
chown -R node:node /app/data
exec setpriv --reuid=node --regid=node --init-groups "$@"
