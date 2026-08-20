#!/usr/bin/env bash
set -euo pipefail
readonly readiness_root="${NELOS_READINESS_ROOT:-/}"
readonly readiness_attempts="${NELOS_READINESS_ATTEMPTS:-120}"
path_at() { if [[ ${readiness_root} == / ]]; then printf '%s' "$1"; else printf '%s%s' "${readiness_root}" "$1"; fi; }
for _attempt in $(seq 1 "${readiness_attempts}"); do
  uid="$(id -u nelosauto)"
  sid="$(loginctl list-sessions --no-legend | awk -v expected_uid="${uid}" '$2 == expected_uid { print $1; exit }')"
  runtime_dir="$(path_at "/run/user/${uid}")"
  binding_file="$(path_at /etc/nelos-desktop/run-binding.json)"
  ready_file="$(path_at /var/lib/nelos-desktop/gui-ready.json)"
  run_id="$(jq -r .runId "${binding_file}" 2>/dev/null || true)"
  if [[ -n ${sid} && -n ${run_id} ]] &&
     [[ $(loginctl show-session "${sid}" -p Type --value) == x11 ]] &&
     [[ $(loginctl show-session "${sid}" -p State --value) == active ]] &&
     [[ -S ${runtime_dir}/bus && -f ${runtime_dir}/nelos-accessibility-ready ]] &&
     systemctl --user --machine="nelosauto@" is-active --quiet nelos-codex-desktop.service &&
     command -v scrot >/dev/null && command -v convert >/dev/null; then
    mkdir -p "$(dirname "${ready_file}")"
    jq -n --arg runId "${run_id}" '{ready:true,accessibilityBus:true,captureReady:true,sessionUser:"nelosauto",runId:$runId}' >"${ready_file}.new"
    if [[ ${readiness_root} == / ]]; then chown root:root "${ready_file}.new"; fi
    chmod 0440 "${ready_file}.new"
    mv "${ready_file}.new" "${ready_file}"
    exit 0
  fi
  sleep 1
done
exit 1
