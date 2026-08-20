#!/usr/bin/env bash
set -euo pipefail
umask 077
ulimit -c 0 || { echo "device-auth could not disable core dumps" >&2; exit 77; }
[[ $(ulimit -c) == 0 ]] || { echo "device-auth core-dump limit differs" >&2; exit 77; }

readonly auth_root="${NELOS_DEVICE_AUTH_ROOT:-/}"
readonly test_mode="${NELOS_DEVICE_AUTH_TEST_MODE:-0}"
path_at() { if [[ ${auth_root} == / ]]; then printf '%s' "$1"; else printf '%s%s' "${auth_root}" "$1"; fi; }
if [[ ${auth_root} == / ]]; then
  [[ ${EUID} -eq 0 ]] || { echo "device-auth requires root" >&2; exit 70; }
else
  [[ ${test_mode} == 1 && ${auth_root} == /* && ${auth_root} != / && -d ${auth_root} && ! -L ${auth_root} ]] || { echo "bounded device-auth test root is invalid" >&2; exit 70; }
fi
[[ $# -eq 1 ]] || { echo "device-auth requires one trusted bootstrap operation" >&2; exit 70; }
readonly operation="$1"
readonly binding_file="$(path_at /etc/nelos-desktop/run-binding.json)"
readonly auth_file="$(path_at /var/lib/nelos-desktop/device-auth.json)"
readonly automation_user=nelosauto
readonly automation_home="$(path_at /home/nelosauto)"
readonly codex_home="${automation_home}/.codex"
readonly codex_auth_file="${codex_home}/auth.json"
readonly bundled_node="$(path_at /usr/lib/chatgpt/resources/cua_node/bin/node)"
readonly controller="$(path_at /usr/libexec/nelos-device-auth-controller)"
readonly identity_helper="$(path_at /usr/libexec/nelos-desktop-identity)"
readonly credential_boundary="$(path_at /usr/libexec/nelos-credential-boundary)"
readonly readiness_helper="$(path_at /usr/libexec/nelos-check-gui-readiness)"
readonly runtime_auth_dir="$(path_at /run/nelos-desktop/auth)"
readonly challenge_file="${runtime_auth_dir}/challenge.json"
readonly complete_file="${runtime_auth_dir}/complete.json"
readonly environment_file="${runtime_auth_dir}/environment"

file_metadata() {
  if stat -c '%u:%g:%a:%h:%s' "$1" >/dev/null 2>&1; then
    stat -c '%u:%g:%a:%h:%s' "$1"
  else
    stat -f '%u:%g:%Lp:%l:%z' "$1"
  fi
}

[[ -f ${binding_file} && ! -L ${binding_file} ]] || exit 70
binding_metadata="$(file_metadata "${binding_file}")" || exit 70
IFS=: read -r binding_uid binding_gid binding_mode binding_links binding_size <<<"${binding_metadata}"
readonly expected_root_uid="$([[ ${auth_root} == / ]] && printf 0 || printf '%s' "${EUID}")"
readonly expected_root_gid="$([[ ${auth_root} == / ]] && printf 0 || id -g)"
[[ ${binding_uid} == "${expected_root_uid}" && ${binding_gid} == "${expected_root_gid}" && ${binding_mode} == 440 && ${binding_links} == 1 && ${binding_size} -gt 0 && ${binding_size} -le 16384 ]] || {
  echo "run binding metadata is unsafe" >&2
  exit 77
}
binding="$(jq -ce '
  select(
    keys == ["automationUser","fencingToken","gatewayId","hostId","imageId","leaseId","macAddress","networkId","networkPolicyDigest","providerId","runId","stateRoot","vmId"] and
    .automationUser == "nelosauto" and
    (.gatewayId | type == "string" and test("^[1-9][0-9]{2,8}$")) and .gatewayId != .vmId and
    (.macAddress | type == "string" and test("^02(:[0-9A-F]{2}){5}$")) and
    (.networkPolicyDigest | type == "string" and test("^sha256:[0-9a-f]{64}$")) and
    (.stateRoot == ("/var/lib/nelos-desktop/runs/" + .runId))
  )
' "${binding_file}")" || { echo "run binding is invalid" >&2; exit 77; }
readonly binding
if [[ ${auth_root} == / ]]; then uid="$(id -u "${automation_user}")"; gid="$(id -g "${automation_user}")"; else uid="${EUID}"; gid="$(id -g)"; fi
readonly uid gid

assert_no_developer_state() {
  local name home
  [[ ! -e "$(path_at /root/.codex)" ]] || { echo "developer Codex state is addressable" >&2; exit 77; }
  local passwd_file="$(path_at /etc/passwd)"
  [[ -f ${passwd_file} ]] || return 0
  while IFS=: read -r name _ _ _ _ home _; do
    [[ ${name} == "${automation_user}" ]] && continue
    if [[ ( ${home} == /home/* || ${home} == /root ) && -e "$(path_at "${home}/.codex")" ]]; then
      echo "non-automation Codex state is addressable" >&2
      exit 77
    fi
  done <"${passwd_file}"
}

trusted_credential_file() {
  [[ -f ${codex_auth_file} && ! -L ${codex_auth_file} ]] || return 1
  local metadata auth_uid auth_gid auth_mode auth_links auth_size
  metadata="$(file_metadata "${codex_auth_file}")" || return 1
  IFS=: read -r auth_uid auth_gid auth_mode auth_links auth_size <<<"${metadata}"
  [[ ${auth_uid} == "${uid}" && ${auth_gid} == "${gid}" && ${auth_links} == 1 && ${auth_size} -gt 0 && ${auth_size} -le 1048576 ]] || return 1
  (( (8#${auth_mode} & 8#077) == 0 ))
}

trusted_auth_receipt() {
  [[ -f ${auth_file} && ! -L ${auth_file} ]] || return 1
  local metadata receipt_uid receipt_gid receipt_mode receipt_links receipt_size
  metadata="$(file_metadata "${auth_file}")" || return 1
  IFS=: read -r receipt_uid receipt_gid receipt_mode receipt_links receipt_size <<<"${metadata}"
  [[ ${receipt_uid} == "${expected_root_uid}" && ${receipt_gid} == "${expected_root_gid}" && ${receipt_mode} == 440 && ${receipt_links} == 1 && ${receipt_size} -gt 0 && ${receipt_size} -le 16384 ]] || return 1
  trusted_credential_file || return 1
  jq -e --argjson expected "${binding}" '
    keys == ["accountBindingDigest","accountType","authMethod","authenticated","binding","credentialStore","developerSessionImported","schemaVersion"] and
    .schemaVersion == 1 and .authenticated == true and .accountType == "chatgpt" and
    (.accountBindingDigest | type == "string" and test("^sha256:[0-9a-f]{64}$")) and
    .authMethod == "chatgptDeviceCode" and .credentialStore == "file" and
    .developerSessionImported == false and .binding == $expected
  ' "${auth_file}" >/dev/null
}

trusted_challenge() {
  [[ -f ${challenge_file} && ! -L ${challenge_file} ]] || return 1
  local metadata size
  metadata="$(file_metadata "${challenge_file}")"
  IFS=: read -r challenge_uid challenge_gid challenge_mode challenge_links size <<<"${metadata}"
  [[ ${challenge_uid}:${challenge_gid}:${challenge_mode}:${challenge_links} == "${uid}:${gid}:600:1" && ${size} -gt 0 && ${size} -le 4096 ]] || return 1
  jq -e '
    keys == ["type","userCode","verificationUrl"] and
    .type == "chatgptDeviceCode" and
    (.userCode | type == "string" and test("^[A-Za-z0-9-]{4,32}$")) and
    (.verificationUrl | type == "string" and startswith("https://"))
  ' "${challenge_file}" >/dev/null
}

run_status_probe() {
  if [[ ${auth_root} == / ]]; then runuser -u "${automation_user}" -- env -i \
    HOME="${automation_home}" CODEX_HOME="${codex_home}" USER="${automation_user}" LOGNAME="${automation_user}" \
    PATH=/usr/bin:/bin LC_ALL=C NELOS_RUN_ID="$(jq -r .runId <<<"${binding}")" \
    "${bundled_node}" "${controller}" status; else env -i HOME="${automation_home}" CODEX_HOME="${codex_home}" USER="${automation_user}" LOGNAME="${automation_user}" PATH="${PATH}" LC_ALL=C NELOS_RUN_ID="$(jq -r .runId <<<"${binding}")" "${bundled_node}" "${controller}" status; fi
}

assert_volatile_credential_boundary() {
  [[ -f ${credential_boundary} && ! -L ${credential_boundary} && -x ${credential_boundary} ]] || {
    echo "credential boundary helper is unavailable" >&2
    exit 77
  }
  local observation
  observation="$(NELOS_CREDENTIAL_BOUNDARY_ROOT="${auth_root}" NELOS_CREDENTIAL_BOUNDARY_TEST_MODE="${test_mode}" "${credential_boundary}" attest)" || {
    echo "volatile credential boundary is not attested" >&2
    exit 77
  }
  jq -e --arg runId "$(jq -r .runId <<<"${binding}")" --arg fencingToken "$(jq -r .fencingToken <<<"${binding}")" --arg vmId "$(jq -r .vmId <<<"${binding}")" --arg imageId "$(jq -r .imageId <<<"${binding}")" '
    keys == ["attestationDigest","bootIdDigest","codexHome","fencingToken","filesystemType","imageId","mountOptions","runId","schemaVersion","secretBytesIncluded","swapActive","type","vmId","volatile"] and
    .schemaVersion == 1 and .type == "nelos.credential-volatility.v1" and .runId == $runId and .fencingToken == $fencingToken and .vmId == $vmId and .imageId == $imageId and
    .codexHome == "/home/nelosauto/.codex" and .filesystemType == "tmpfs" and .mountOptions == ["nodev","noexec","nosuid","rw"] and
    .swapActive == false and .volatile == true and .secretBytesIncluded == false and
    (.bootIdDigest | test("^sha256:[0-9a-f]{64}$")) and (.attestationDigest | test("^sha256:[0-9a-f]{64}$"))
  ' <<<"${observation}" >/dev/null || { echo "volatile credential boundary attestation is invalid" >&2; exit 77; }
}

prepare_volatile_credential_boundary() {
  [[ -f ${credential_boundary} && ! -L ${credential_boundary} && -x ${credential_boundary} ]] || {
    echo "credential boundary helper is unavailable" >&2
    exit 77
  }
  NELOS_CREDENTIAL_BOUNDARY_ROOT="${auth_root}" NELOS_CREDENTIAL_BOUNDARY_TEST_MODE="${test_mode}" "${credential_boundary}" prepare >/dev/null
  assert_volatile_credential_boundary
}

start_desktop_after_auth() {
  assert_volatile_credential_boundary
  if [[ ${auth_root} == / ]]; then runuser -u "${automation_user}" -- env -i \
    HOME="${automation_home}" CODEX_HOME="${codex_home}" USER="${automation_user}" LOGNAME="${automation_user}" \
    XDG_RUNTIME_DIR="/run/user/${uid}" DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/${uid}/bus" PATH=/usr/bin:/bin \
    systemctl --user start nelos-codex-desktop.service; else systemctl --user start nelos-codex-desktop.service; fi
  systemctl --no-block restart nelos-desktop-session.service
}

assert_installed_identity() {
  [[ -f ${identity_helper} && ! -L ${identity_helper} ]] || { echo "installed Desktop identity helper is unavailable" >&2; exit 77; }
  "${identity_helper}" >/dev/null
}

assert_no_core_policy() {
  [[ -f ${readiness_helper} && ! -L ${readiness_helper} && -x ${readiness_helper} ]] || {
    echo "no-core readiness helper is unavailable" >&2
    exit 77
  }
  NELOS_READINESS_ROOT="${auth_root}" NELOS_READINESS_TEST_MODE="${test_mode}" NELOS_READINESS_ATTEMPTS=1 NELOS_READINESS_NO_CORE_ONLY=1 "${readiness_helper}" || {
    echo "global no-core policy is unavailable or drifted" >&2
    exit 77
  }
}

case "${operation}" in
  start)
    assert_no_core_policy
    assert_installed_identity
    assert_no_developer_state
    prepare_volatile_credential_boundary
    if trusted_auth_receipt; then
      start_desktop_after_auth
      jq -cn '{status:"authenticated",accountType:"chatgpt",credentialStore:"file"}'
      exit 0
    fi
    if ! systemctl is-active --quiet nelos-device-auth.service; then
      if [[ -e ${auth_file} || -L ${auth_file} ]]; then
        trusted_auth_receipt && { echo "authenticated receipt unexpectedly survived its credential" >&2; exit 77; }
        [[ -f ${auth_file} && ! -L ${auth_file} ]] || { echo "stale device-auth receipt is unsafe" >&2; exit 77; }
        unlink "${auth_file}"
      fi
      if [[ ${auth_root} == / ]]; then install -d -o "${automation_user}" -g "${automation_user}" -m 0700 "${runtime_auth_dir}"; else mkdir -p "${runtime_auth_dir}"; chmod 0700 "${runtime_auth_dir}"; fi
      printf 'NELOS_RUN_ID=%s\n' "$(jq -r .runId <<<"${binding}")" >"${environment_file}"
      [[ ${auth_root} != / ]] || chown "${automation_user}:${automation_user}" "${environment_file}"
      chmod 0400 "${environment_file}"
      unlink "${challenge_file}" 2>/dev/null || true
      unlink "${complete_file}" 2>/dev/null || true
      systemctl start nelos-device-auth.service
    fi
    for _attempt in $(seq 1 30); do
      if trusted_challenge; then
        jq -c '. + {status:"authorization_required"}' "${challenge_file}"
        exit 0
      fi
      systemctl is-failed --quiet nelos-device-auth.service && break
      sleep 1
    done
    echo "bounded device-auth challenge was not produced" >&2
    exit 75
    ;;
  status)
    assert_no_core_policy
    assert_installed_identity
    assert_no_developer_state
    assert_volatile_credential_boundary
    if trusted_auth_receipt; then
      start_desktop_after_auth
      jq -cn '{status:"authenticated",authenticated:true,accountType:"chatgpt",credentialStore:"file"}'
      exit 0
    fi
    [[ -d ${codex_home} && ! -L ${codex_home} ]] || { echo "volatile CODEX_HOME is unavailable" >&2; exit 77; }
    status="$(run_status_probe)" || { echo "pinned Codex account status failed" >&2; exit 70; }
    jq -e 'keys == ["accountBindingDigest","accountType","authenticated","credentialStore"] and .credentialStore == "file"' <<<"${status}" >/dev/null || exit 70
    if [[ $(jq -r .authenticated <<<"${status}") != true ]]; then
      jq -cn '{status:"pending",authenticated:false,accountType:null,credentialStore:"file"}'
      exit 0
    fi
    jq -e '.accountType == "chatgpt"' <<<"${status}" >/dev/null || exit 77
    trusted_credential_file || { echo "file credential store is unavailable or unsafe" >&2; exit 77; }
    jq -cn --argjson binding "${binding}" --arg accountBindingDigest "$(jq -r .accountBindingDigest <<<"${status}")" '{
      schemaVersion:1,
      binding:$binding,
      authenticated:true,
      accountType:"chatgpt",
      accountBindingDigest:$accountBindingDigest,
      authMethod:"chatgptDeviceCode",
      credentialStore:"file",
      developerSessionImported:false
    }' >"${auth_file}.new"
    [[ ${auth_root} != / ]] || chown root:root "${auth_file}.new"
    chmod 0440 "${auth_file}.new"
    mv -f "${auth_file}.new" "${auth_file}"
    systemctl stop nelos-device-auth.service >/dev/null 2>&1 || true
    start_desktop_after_auth
    jq -cn '{status:"authenticated",authenticated:true,accountType:"chatgpt",credentialStore:"file"}'
    ;;
  cancel)
    systemctl stop nelos-device-auth.service >/dev/null 2>&1 || true
    unlink "${challenge_file}" 2>/dev/null || true
    unlink "${complete_file}" 2>/dev/null || true
    scrub="$(NELOS_CREDENTIAL_BOUNDARY_ROOT="${auth_root}" NELOS_CREDENTIAL_BOUNDARY_TEST_MODE="${test_mode}" "${credential_boundary}" scrub)" || {
      echo "credential scrub was not attested" >&2
      exit 77
    }
    jq -e 'keys == ["attestationDigest","codexHome","credentialState","fencingToken","reusableCredentialsAbsent","runId","schemaVersion","secretBytesIncluded","type","unmounted","vmId"] and
      .schemaVersion == 1 and .type == "nelos.credential-scrub.v1" and .credentialState == "absent" and .unmounted == true and
      .reusableCredentialsAbsent == true and .secretBytesIncluded == false and (.attestationDigest | test("^sha256:[0-9a-f]{64}$"))' <<<"${scrub}" >/dev/null || exit 77
    jq -cn --arg attestationDigest "$(jq -r .attestationDigest <<<"${scrub}")" '{status:"cancelled",credentialState:"absent",attestationDigest:$attestationDigest}'
    ;;
  *)
    echo "unsupported device-auth operation" >&2
    exit 64
    ;;
esac
