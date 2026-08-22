#!/usr/bin/env bash
set -Eeuo pipefail
printf '%s\n' 'quarantined: deprecated unsafe entrypoint; use nelos-volume-attestor-host-installer remove/reconcile with the exact sealed plan, authorization digest, journal, and receipt' >&2
exit 64
