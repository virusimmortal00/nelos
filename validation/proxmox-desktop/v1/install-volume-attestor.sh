#!/usr/bin/env bash
set -Eeuo pipefail
printf '%s\n' 'error: deprecated unsafe entrypoint; use nelos-volume-attestor-host-installer prepare/install with a sealed plan, authorization digest, journal, and receipt' >&2
exit 64
