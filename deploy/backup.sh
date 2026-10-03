#!/bin/sh
set -eu
cd "$(dirname "$0")"
umask 077
mkdir -p backups
archive="minidrama-$(date -u +%Y%m%dT%H%M%SZ).tar.gz"
# Stop the writer so the SQLite WAL, keys and media are captured consistently.
docker compose stop app
trap 'docker compose start app' EXIT HUP INT TERM
docker compose --profile maintenance run --rm --no-deps backup -czf "/backups/$archive" -C /data .
gzip -t "backups/$archive"
sha256sum "backups/$archive" > "backups/$archive.sha256"
printf 'Backup created: %s\n' "backups/$archive"
