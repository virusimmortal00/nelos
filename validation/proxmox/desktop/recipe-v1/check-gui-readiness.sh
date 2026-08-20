#!/usr/bin/env bash
set -euo pipefail
ulimit -c 0 || exit 77
[[ $(ulimit -c) == 0 ]] || exit 77
readonly readiness_root="${NELOS_READINESS_ROOT:-/}"
readonly readiness_attempts="${NELOS_READINESS_ATTEMPTS:-120}"
readonly no_core_only="${NELOS_READINESS_NO_CORE_ONLY:-0}"
readonly readiness_test_mode="${NELOS_READINESS_TEST_MODE:-0}"
path_at() { if [[ ${readiness_root} == / ]]; then printf '%s' "$1"; else printf '%s%s' "${readiness_root}" "$1"; fi; }
file_metadata() {
  if stat -c '%u:%g:%a:%h' "$1" >/dev/null 2>&1; then stat -c '%u:%g:%a:%h' "$1"; else stat -f '%u:%g:%Lp:%l' "$1"; fi
}
policy_file_is_exact() {
  local path=$1 expected=$2
  [[ -f ${path} && ! -L ${path} && $(file_metadata "${path}") == "${policy_uid}:${policy_gid}:644:1" && $(cat "${path}") == "${expected}" ]]
}
assert_no_core_policy() {
  policy_file_is_exact "$(path_at /etc/security/limits.d/99-nelos-no-core.conf)" $'* soft core 0\n* hard core 0\nroot soft core 0\nroot hard core 0' || return 1
  policy_file_is_exact "$(path_at /etc/systemd/system.conf.d/99-nelos-no-core.conf)" $'[Manager]\nDefaultLimitCORE=0' || return 1
  policy_file_is_exact "$(path_at /etc/systemd/user.conf.d/99-nelos-no-core.conf)" $'[Manager]\nDefaultLimitCORE=0' || return 1
  policy_file_is_exact "$(path_at /etc/systemd/coredump.conf.d/99-nelos-no-core.conf)" $'[Coredump]\nStorage=none\nProcessSizeMax=0\nExternalSizeMax=0' || return 1
  policy_file_is_exact "$(path_at /etc/sysctl.d/99-nelos-no-core.conf)" $'fs.suid_dumpable = 0\nkernel.core_pattern = /dev/null' || return 1
  policy_file_is_exact "$(path_at /etc/default/apport)" 'enabled=0' || return 1
  [[ $(cat "$(path_at /proc/sys/fs/suid_dumpable)" 2>/dev/null) == 0 && $(cat "$(path_at /proc/sys/kernel/core_pattern)" 2>/dev/null) == /dev/null ]] || return 1
  [[ $(systemctl show --property DefaultLimitCORE --value 2>/dev/null) == 0 ]] || return 1
  local unit
  for unit in apport.service apport-autoreport.path apport-autoreport.service systemd-coredump.socket 'systemd-coredump@.service'; do
    [[ -L $(path_at "/etc/systemd/system/${unit}") && $(readlink "$(path_at "/etc/systemd/system/${unit}")") == /dev/null ]] || return 1
  done
}
[[ ${no_core_only} == 0 || ${no_core_only} == 1 ]] || exit 77
if [[ ${readiness_root} == / ]]; then
  [[ ${EUID} == 0 && ${readiness_test_mode} == 0 ]] || exit 77
  readonly policy_uid=0 policy_gid=0
else
  [[ ${readiness_test_mode} == 1 && ${readiness_root} == /* && ${readiness_root} != / && -d ${readiness_root} && ! -L ${readiness_root} ]] || exit 77
  IFS=: read -r root_uid root_gid root_mode root_links <<<"$(file_metadata "${readiness_root}")"
  [[ ${root_uid} == "${EUID}" && ${root_mode} == 700 && ${root_links} -ge 1 ]] || exit 77
  readonly policy_uid="${root_uid}" policy_gid="${root_gid}"
fi
assert_no_core_policy || exit 77
[[ ${no_core_only} == 0 ]] || exit 0
for _attempt in $(seq 1 "${readiness_attempts}"); do
  uid="$(id -u nelosauto 2>/dev/null || true)"
  [[ -n ${uid} ]] || { sleep 1; continue; }
  sid="$(loginctl list-sessions --no-legend | awk -v expected_uid="${uid}" '$2 == expected_uid { print $1; exit }')"
  runtime_dir="$(path_at "/run/user/${uid}")"
  binding_file="$(path_at /etc/nelos-desktop/run-binding.json)"
  auth_file="$(path_at /var/lib/nelos-desktop/device-auth.json)"
  boundary_file="$(path_at /var/lib/nelos-desktop/credential-boundary.json)"
  ready_file="$(path_at /var/lib/nelos-desktop/gui-ready.json)"
  binding="$(jq -cS . "${binding_file}" 2>/dev/null || true)"
  auth_binding="$(jq -cS '.binding' "${auth_file}" 2>/dev/null || true)"
  auth_ready="$(jq -r '
    keys == ["accountBindingDigest","accountType","authMethod","authenticated","binding","credentialStore","developerSessionImported","schemaVersion"] and
    .schemaVersion == 1 and .authenticated == true and .accountType == "chatgpt" and
    (.accountBindingDigest | type == "string" and test("^sha256:[0-9a-f]{64}$")) and
    .authMethod == "chatgptDeviceCode" and .credentialStore == "file" and .developerSessionImported == false
  ' "${auth_file}" 2>/dev/null || true)"
  boundary_ready="$(jq -r --arg runId "$(jq -r .runId <<<"${binding}" 2>/dev/null || true)" --arg fencingToken "$(jq -r .fencingToken <<<"${binding}" 2>/dev/null || true)" --arg vmId "$(jq -r .vmId <<<"${binding}" 2>/dev/null || true)" --arg imageId "$(jq -r .imageId <<<"${binding}" 2>/dev/null || true)" '
    keys == ["attestationDigest","bootIdDigest","codexHome","fencingToken","filesystemType","imageId","mountOptions","runId","schemaVersion","secretBytesIncluded","swapActive","type","vmId","volatile"] and
    .schemaVersion == 1 and .type == "nelos.credential-volatility.v1" and .runId == $runId and .fencingToken == $fencingToken and .vmId == $vmId and .imageId == $imageId and
    .codexHome == "/home/nelosauto/.codex" and .filesystemType == "tmpfs" and .mountOptions == ["nodev","noexec","nosuid","rw"] and
    .swapActive == false and .volatile == true and .secretBytesIncluded == false and
    (.bootIdDigest | test("^sha256:[0-9a-f]{64}$")) and (.attestationDigest | test("^sha256:[0-9a-f]{64}$"))
  ' "${boundary_file}" 2>/dev/null || true)"
  if [[ -n ${sid} && -n ${binding} && ${binding} == "${auth_binding}" && ${auth_ready} == true && ${boundary_ready} == true ]] &&
     [[ $(findmnt --noheadings --output FSTYPE --target "$(path_at /home/nelosauto/.codex)" 2>/dev/null) == tmpfs ]] &&
     [[ -z $(swapon --noheadings --show=NAME 2>/dev/null) ]] &&
     [[ $(loginctl show-session "${sid}" -p Type --value) == x11 ]] &&
     [[ $(loginctl show-session "${sid}" -p State --value) == active ]] &&
     [[ -S ${runtime_dir}/bus && -f ${runtime_dir}/nelos-accessibility-ready ]] &&
     [[ $(findmnt -n -o FSTYPE -T "${runtime_dir}" 2>/dev/null) == tmpfs ]] &&
     systemctl --user --machine="nelosauto@" is-active --quiet nelos-codex-desktop.service &&
     command -v scrot >/dev/null && command -v convert >/dev/null && command -v identify >/dev/null && command -v import >/dev/null &&
     runuser -u nelosauto -- env MAGICK_MEMORY_LIMIT=16MiB MAGICK_MAP_LIMIT=0 MAGICK_DISK_LIMIT=0 MAGICK_TMPDIR="${runtime_dir}" \
       convert -limit memory 16MiB -limit map 0 -limit disk 0 -size 1x1 xc:black null:; then
    mkdir -p "$(dirname "${ready_file}")"
    jq -n --argjson binding "${binding}" '{schemaVersion:1,binding:$binding,ready:true,accessibilityBus:true,captureReady:true,sessionUser:"nelosauto"}' >"${ready_file}.new"
    if [[ ${readiness_root} == / ]]; then chown root:root "${ready_file}.new"; fi
    chmod 0440 "${ready_file}.new"
    mv "${ready_file}.new" "${ready_file}"
    exit 0
  fi
  sleep 1
done
exit 1
