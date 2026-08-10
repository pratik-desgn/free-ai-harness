#!/bin/sh
set -eu

project_directory=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
output_directory=${1:-"$project_directory/release-artifacts"}
mkdir -p "$output_directory"

umask 022
cyclonedx_tmp=$(mktemp "$output_directory/free-ai-harness.cdx.json.tmp.XXXXXX")
spdx_tmp=$(mktemp "$output_directory/free-ai-harness.spdx.json.tmp.XXXXXX")
trap 'rm -f -- "$cyclonedx_tmp" "$spdx_tmp"' EXIT HUP INT TERM

(
  cd "$project_directory"
  npm sbom --package-lock-only --sbom-type application --sbom-format cyclonedx > "$cyclonedx_tmp"
  npm sbom --package-lock-only --sbom-type application --sbom-format spdx > "$spdx_tmp"
)

node -e 'for (const path of process.argv.slice(1)) { const value=JSON.parse(require("node:fs").readFileSync(path,"utf8")); if (!value || typeof value!=="object") process.exit(1) }' "$cyclonedx_tmp" "$spdx_tmp"
mv "$cyclonedx_tmp" "$output_directory/free-ai-harness.cdx.json"
mv "$spdx_tmp" "$output_directory/free-ai-harness.spdx.json"
trap - EXIT HUP INT TERM

if command -v sha256sum >/dev/null 2>&1; then
  sha256sum "$output_directory/free-ai-harness.cdx.json" "$output_directory/free-ai-harness.spdx.json" > "$output_directory/SHA256SUMS"
fi
printf 'Dependency SBOMs written to %s\n' "$output_directory"
