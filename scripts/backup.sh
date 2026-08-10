#!/bin/sh
set -eu

project_directory=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
compose_file="$project_directory/deploy/docker-compose.yml"
environment_file=${HARNESS_COMPOSE_ENV_FILE:-"$project_directory/deploy/.env"}
destination=${1:-"$project_directory/free-ai-harness-$(date -u +%Y%m%dT%H%M%SZ).db"}

if [ ! -f "$environment_file" ]; then
  printf 'Compose environment file not found: %s\n' "$environment_file" >&2
  exit 66
fi
if [ -e "$destination" ] || [ -e "$destination.sha256" ]; then
  printf 'Refusing to overwrite existing backup: %s\n' "$destination" >&2
  exit 73
fi

umask 077
temporary=$(mktemp "${destination}.tmp.XXXXXX")
trap 'rm -f -- "$temporary"' EXIT HUP INT TERM
HARNESS_ENV_FILE="$environment_file" docker compose --env-file "$environment_file" -f "$compose_file" exec -T harness node scripts/sqlite-backup.mjs > "$temporary"
if [ ! -s "$temporary" ]; then
  printf 'Backup command produced an empty file.\n' >&2
  exit 74
fi
if [ -e "$destination" ] || [ -e "$destination.sha256" ]; then
  printf 'Refusing to overwrite backup created concurrently: %s\n' "$destination" >&2
  exit 73
fi
ln "$temporary" "$destination"
rm -f -- "$temporary"
trap - EXIT HUP INT TERM

if command -v sha256sum >/dev/null 2>&1; then
  set -C
  sha256sum "$destination" > "$destination.sha256"
fi
printf 'Backup written to %s\n' "$destination"
printf 'Store this file together with the HARNESS_VAULT_KEY; neither is useful alone.\n'
