#!/bin/bash
# Kept for old instructions: the installer now lives at the top of the repo.
exec "$(cd "$(dirname "$0")/.." && pwd)/install.sh" "$@"
