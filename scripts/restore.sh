#!/bin/sh
set -eu

if [ "$#" -ne 1 ]; then
  printf 'Usage: %s BACKUP.db\n' "$0" >&2
  exit 64
fi

backup_file=$1
if [ ! -f "$backup_file" ] || [ ! -s "$backup_file" ]; then
  printf 'Backup does not exist or is empty: %s\n' "$backup_file" >&2
  exit 66
fi

project_directory=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
compose_file="$project_directory/deploy/docker-compose.yml"
environment_file=${HARNESS_COMPOSE_ENV_FILE:-"$project_directory/deploy/.env"}

if [ ! -f "$environment_file" ]; then
  printf 'Compose environment file not found: %s\n' "$environment_file" >&2
  exit 66
fi

printf 'Stopping the harness before restore...\n'
HARNESS_ENV_FILE="$environment_file" docker compose --env-file "$environment_file" -f "$compose_file" stop harness
if ! HARNESS_ENV_FILE="$environment_file" docker compose --env-file "$environment_file" -f "$compose_file" run --rm -T --no-deps --entrypoint node harness scripts/sqlite-restore.mjs < "$backup_file"; then
  printf 'Restore failed; the harness remains stopped.\n' >&2
  exit 1
fi
HARNESS_ENV_FILE="$environment_file" docker compose --env-file "$environment_file" -f "$compose_file" up -d harness
printf 'Restore completed and the harness was restarted.\n'
