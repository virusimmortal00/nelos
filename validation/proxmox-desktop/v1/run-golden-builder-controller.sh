#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
PATH=/usr/sbin:/usr/bin:/sbin:/bin
export PATH

die() { printf 'error: %s\n' "$*" >&2; exit 70; }
[[ $# -eq 0 ]] || die "arguments are disabled; sealed environment paths are required"
[[ ${EUID} -eq 0 ]] || die "builder controller must run as root inside the disposable VM"
[[ $(uname -s) == Linux && $(uname -m) == x86_64 ]] || die "builder controller must be Linux x86_64"
[[ ! -e /etc/pve ]] || die "builder controller must not be a Proxmox node"
. /etc/os-release
[[ ${ID:-} == ubuntu && ${VERSION_ID:-} == 24.04 ]] || die "builder controller must be Ubuntu 24.04"
[[ $(dpkg --print-architecture) == amd64 ]] || die "builder controller architecture is not amd64"
for command in flock jq python3 realpath stat sync; do command -v "$command" >/dev/null || die "required controller command is unavailable: ${command}"; done

required=(
  NELOS_GOLDEN_BUILDER_BUNDLE NELOS_GOLDEN_CONTROLLER_IDENTITY NELOS_GOLDEN_SOURCE_ROOT NELOS_GOLDEN_NODE_ARCHIVE NELOS_GOLDEN_PACKER_ARCHIVE
  NELOS_GOLDEN_PLUGIN_ARCHIVE NELOS_GOLDEN_BUILD_TOKEN_FILE NELOS_GOLDEN_ATTEST_TOKEN_FILE NELOS_GOLDEN_TLS_CA_FILE
  NELOS_GOLDEN_VOLUME_KNOWN_HOSTS NELOS_GOLDEN_VOLUME_IDENTITY_FILE NELOS_GOLDEN_STATE_DIR NELOS_GOLDEN_ATTESTATION_DIR
  NELOS_GOLDEN_TERMINAL_RECEIPT NELOS_GOLDEN_CLEANUP_RECEIPT NELOS_GOLDEN_OPERATION
)
for name in "${required[@]}"; do [[ -n ${!name:-} ]] || die "${name} is required"; done
for name in "${!NELOS_GOLDEN_@}"; do
  [[ " ${required[*]} " == *" ${name} "* ]] || die "unsupported ${name} override"
done
for name in PACKER_LOG PACKER_LOG_PATH PROXMOX_PASSWORD PROXMOX_URL PROXMOX_USERNAME PROXMOX_TOKEN HTTP_PROXY HTTPS_PROXY ALL_PROXY http_proxy https_proxy all_proxy NODE_OPTIONS NODE_PATH SSH_AGENT_PID SSH_AUTH_SOCK; do
  printenv "$name" >/dev/null 2>&1 && die "ambient ${name} is forbidden"
done

canonical_file() {
  local input path
  input="$1"
  path="$(realpath "$1")"
  [[ $path == "$input" && $path == /* && -f $path && ! -L $path && $(stat -c '%h:%u:%g' "$path") == 1:0:0 ]] || die "$2 is not one root-owned canonical regular file"
  (( (8#$(stat -c '%a' "$path") & 8#022) == 0 )) || die "$2 is writable by group or world"
  printf '%s\n' "$path"
}

canonical_dir() {
  local input path
  input="$1"
  path="$(realpath "$1")"
  [[ $path == "$input" && $path == /* && $path != / && -d $path && ! -L $path && $(stat -c '%a:%u:%g' "$path") == 700:0:0 ]] || die "$2 is not a private root-owned canonical directory"
  printf '%s\n' "$path"
}

bundle="$(canonical_file "$NELOS_GOLDEN_BUILDER_BUNDLE" "builder bundle")"
controller_identity="$(canonical_file "$NELOS_GOLDEN_CONTROLLER_IDENTITY" "controller identity")"
source_root="$(canonical_dir "$NELOS_GOLDEN_SOURCE_ROOT" "source checkout")"
node_archive="$(canonical_file "$NELOS_GOLDEN_NODE_ARCHIVE" "Node archive")"
packer_archive="$(canonical_file "$NELOS_GOLDEN_PACKER_ARCHIVE" "Packer archive")"
plugin_archive="$(canonical_file "$NELOS_GOLDEN_PLUGIN_ARCHIVE" "Packer plugin archive")"
state_root="$(canonical_dir "$NELOS_GOLDEN_STATE_DIR" "state root")"
attestation_root="$(canonical_dir "$NELOS_GOLDEN_ATTESTATION_DIR" "attestation root")"
terminal_parent="$(canonical_dir "$(dirname "$NELOS_GOLDEN_TERMINAL_RECEIPT")" "terminal receipt root")"
terminal_receipt="${terminal_parent}/$(basename "$NELOS_GOLDEN_TERMINAL_RECEIPT")"
[[ $terminal_receipt == "$NELOS_GOLDEN_TERMINAL_RECEIPT" && $(basename "$terminal_receipt") =~ ^[0-9a-f]{64}\.json$ ]] || die "terminal receipt path is not canonical"
cleanup_receipt="${terminal_parent}/$(basename "$NELOS_GOLDEN_CLEANUP_RECEIPT")"
[[ $cleanup_receipt == "$NELOS_GOLDEN_CLEANUP_RECEIPT" && $(basename "$cleanup_receipt") =~ ^[0-9a-f]{64}\.cleanup\.json$ ]] || die "cleanup receipt path is not canonical"
[[ $NELOS_GOLDEN_OPERATION == run || $NELOS_GOLDEN_OPERATION == cleanup ]] || die "controller operation must be run or cleanup"

exec 9<"$state_root"
flock -n 9 || die "the exact guest controller is already running; reconcile it instead of replaying"

jq -e 'keys == ["hostId","identityDigest","kind","mac","name","ownership","packetDigest","providerId","schemaVersion","sshHostFingerprint","vmId"] and .schemaVersion == 1 and .kind == "nelos-golden-builder-controller-identity"' "$controller_identity" >/dev/null || die "controller identity contract is invalid"
identity_unsigned="$(jq -cS 'del(.identityDigest)' "$controller_identity")"
[[ $(jq -er '.identityDigest' "$controller_identity") == "sha256:$(printf '%s' "$identity_unsigned" | sha256sum | cut -d' ' -f1)" ]] || die "controller identity digest differs"
jq -e --slurpfile identity "$controller_identity" '
  $identity[0].vmId == 9026 and .reservation.sourceTemplate.vmId == 9024 and .reservation.outputTemplate.vmId == 9027 and
  .builderPacket.sourceTemplateVmId == 9024 and .builderPacket.outputTemplateVmId == 9027 and
  .builderPacket.packetDigest == $identity[0].packetDigest and .builderPacket.providerId == $identity[0].providerId and
  .builderPacket.hostId == $identity[0].hostId and .builderPacket.builderVm.vmId == $identity[0].vmId and
  .builderPacket.builderVm.name == $identity[0].name and .builderPacket.builderVm.mac == $identity[0].mac and
  .builderPacket.builderVm.ownership == $identity[0].ownership and .builderPacket.builderVm.sshHostFingerprint == $identity[0].sshHostFingerprint
' "$bundle" >/dev/null || die "controller identity differs from the sealed builder packet"
packet_digest="$(jq -er '.builderPacket.packetDigest' "$bundle")"
reservation_digest="$(jq -er '.builderPacket.reservationDigest' "$bundle")"
ready_marker="$(canonical_file "${state_root}/controller-ready" "controller ready marker")"
[[ $(stat -c '%a' "$ready_marker") == 400 && $(cat "$ready_marker") == "$packet_digest" ]] || die "controller ready marker differs from the sealed packet"
sync -f "$ready_marker"
sync -f "$state_root"
[[ $(hostname -s) == "$(jq -er '.name' "$controller_identity")" ]] || die "builder hostname differs from the sealed identity"
local_host_fingerprint="$(ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub -E sha256 | awk 'NR == 1 {print $2}')"
[[ $local_host_fingerprint == "$(jq -er '.sshHostFingerprint' "$controller_identity")" ]] || die "builder SSH host key differs from the sealed identity"
expected_mac="$(jq -er '.mac | ascii_downcase' "$controller_identity")"
find /sys/class/net -mindepth 1 -maxdepth 1 -type l -exec cat {}/address \; 2>/dev/null | grep -Fxq "$expected_mac" || die "builder NIC MAC differs from the sealed identity"

terminal_is_valid() {
  [[ -f $terminal_receipt && ! -L $terminal_receipt && $(stat -c '%h:%u:%g:%a' "$terminal_receipt") == 1:0:0:400 ]] || return 1
  jq -e --arg packet "$packet_digest" --arg reservation "$reservation_digest" '
    keys == ["attestationDigest","completedAt","goldenImageDigest","kind","packetDigest","reservationDigest","result","schemaVersion","terminalDigest"] and
    .schemaVersion == 1 and .kind == "nelos-golden-builder-terminal" and .result == "committed" and
    .packetDigest == $packet and .reservationDigest == $reservation and
    (.attestationDigest | test("^sha256:[0-9a-f]{64}$")) and (.goldenImageDigest | test("^sha256:[0-9a-f]{64}$")) and
    (.terminalDigest | test("^sha256:[0-9a-f]{64}$")) and (.completedAt | test("^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\\.[0-9]{3}Z$"))
  ' "$terminal_receipt" >/dev/null || return 1
  terminal_unsigned="$(jq -cS 'del(.terminalDigest)' "$terminal_receipt")"
  [[ $(jq -er '.terminalDigest' "$terminal_receipt") == "sha256:$(printf '%s' "$terminal_unsigned" | sha256sum | cut -d' ' -f1)" &&
     $(cat "$terminal_receipt") == "$(jq -cS . "$terminal_receipt")" ]]
}

cleanup_is_valid() {
  [[ -f $cleanup_receipt && ! -L $cleanup_receipt && $(stat -c '%h:%u:%g:%a' "$cleanup_receipt") == 1:0:0:400 ]] || return 1
  jq -e --arg packet "$packet_digest" --arg reservation "$reservation_digest" '
    keys == ["cleanupDigest","completedAt","kind","packetDigest","reservationDigest","result","schemaVersion"] and
    .schemaVersion == 1 and .kind == "nelos-golden-builder-cleanup-terminal" and .result == "cleaned" and
    .packetDigest == $packet and .reservationDigest == $reservation and
    (.cleanupDigest | test("^sha256:[0-9a-f]{64}$")) and (.completedAt | test("^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\\.[0-9]{3}Z$"))
  ' "$cleanup_receipt" >/dev/null || return 1
  cleanup_unsigned="$(jq -cS 'del(.cleanupDigest)' "$cleanup_receipt")"
  [[ $(jq -er '.cleanupDigest' "$cleanup_receipt") == "sha256:$(printf '%s' "$cleanup_unsigned" | sha256sum | cut -d' ' -f1)" &&
     $(cat "$cleanup_receipt") == "$(jq -cS . "$cleanup_receipt")" ]]
}

if [[ -e $terminal_receipt || -L $terminal_receipt ]]; then
  if terminal_is_valid; then
    printf '%s\n' "$terminal_receipt"
    exit 0
  fi
  [[ -f $terminal_receipt && ! -L $terminal_receipt && $(stat -c '%h:%u:%g' "$terminal_receipt") == 1:0:0 &&
     $(stat -c '%a' "$terminal_receipt") =~ ^(400|600)$ && $(stat -c '%s' "$terminal_receipt") -le 65536 ]] || die "invalid terminal publication cannot be safely reconciled"
  rm -f -- "$terminal_receipt"
  sync -f "$terminal_parent"
fi
if [[ $NELOS_GOLDEN_OPERATION == cleanup && ( -e $cleanup_receipt || -L $cleanup_receipt ) ]]; then
  if cleanup_is_valid; then
    printf '%s\n' "$cleanup_receipt"
    exit 0
  fi
  [[ -f $cleanup_receipt && ! -L $cleanup_receipt && $(stat -c '%h:%u:%g' "$cleanup_receipt") == 1:0:0 &&
     $(stat -c '%a' "$cleanup_receipt") =~ ^(400|600)$ && $(stat -c '%s' "$cleanup_receipt") -le 65536 ]] || die "invalid cleanup publication cannot be safely reconciled"
  rm -f -- "$cleanup_receipt"
  sync -f "$terminal_parent"
fi

toolchain_lock="${source_root}/validation/proxmox/toolchain.lock.json"
builder_module="${source_root}/validation/proxmox-desktop/v1/prepare-golden-builder.mjs"
wrapper="${source_root}/validation/proxmox-desktop/v1/build-golden-image.mjs"
for path in "$toolchain_lock" "$builder_module" "$wrapper"; do [[ -f $path && ! -L $path ]] || die "committed builder source is incomplete"; done

source_commit="$(jq -er '.builderPacket.sourceCommit' "$bundle")"
[[ $(git -C "$source_root" rev-parse --verify HEAD^{commit}) == "$source_commit" ]] || die "source checkout commit differs from the builder packet"
[[ -z $(git -C "$source_root" status --porcelain=v1 --untracked-files=all) ]] || die "source checkout is dirty"
printf '%s  %s\n' "$(jq -er '.builderPacket.toolchainLockDigest | sub("^sha256:"; "")' "$bundle")" "$toolchain_lock" | sha256sum --check --status || die "toolchain lock differs from the builder packet"
for tuple in \
  "packer:$packer_archive" \
  "packerProxmoxPlugin:$plugin_archive" \
  "node:$node_archive"; do
  artifact="${tuple%%:*}"; path="${tuple#*:}"
  printf '%s  %s\n' "$(jq -er --arg artifact "$artifact" '.artifacts[$artifact].sha256' "$toolchain_lock")" "$path" | sha256sum --check --status || die "${artifact} archive differs from the toolchain lock"
done

node_root="$(mktemp -d "${state_root}/node-toolchain.XXXXXXXX")"
chmod 0700 "$node_root"
cleanup() {
  find "$node_root" -depth -delete 2>/dev/null || true
  [[ -z ${wrapper_stdout:-} || $wrapper_stdout != "${state_root}/"* ]] || rm -f -- "$wrapper_stdout"
  [[ -z ${reservation_temporary:-} || $reservation_temporary != "${state_root}/"* ]] || rm -f -- "$reservation_temporary"
  [[ -z ${terminal_temporary:-} || $terminal_temporary != "${terminal_parent}/"* ]] || rm -f -- "$terminal_temporary"
  [[ -z ${cleanup_temporary:-} || $cleanup_temporary != "${terminal_parent}/"* ]] || rm -f -- "$cleanup_temporary"
}
trap cleanup EXIT HUP INT TERM
tar --extract --xz --file "$node_archive" --directory "$node_root" --no-same-owner --no-same-permissions
node_bin="${node_root}/node-v$(jq -er '.artifacts.node.version' "$toolchain_lock")-linux-x64/bin/node"
[[ -f $node_bin && ! -L $node_bin && -x $node_bin && $($node_bin --version) == v24.18.0 ]] || die "exact Node 24.18.0 runtime is unavailable"

"$node_bin" "$builder_module" --validate-bundle --request "$bundle" >/dev/null
reservation_file="${state_root}/reservation.$(jq -er '.builderPacket.reservationDigest | sub("^sha256:"; "")' "$bundle").json"
reservation_value="$(jq -cS '.reservation' "$bundle")"
if [[ -e $reservation_file || -L $reservation_file ]]; then
  [[ -f $reservation_file && ! -L $reservation_file && $(stat -c '%h:%u:%g:%a' "$reservation_file") == 1:0:0:400 &&
     $(cat "$reservation_file") == "$reservation_value" ]] || die "existing derived reservation differs from the sealed bundle"
else
  reservation_temporary="$(mktemp "${state_root}/.reservation.XXXXXXXX.tmp")"
  printf '%s\n' "$reservation_value" > "$reservation_temporary"
  chmod 0400 "$reservation_temporary"
  sync -f "$reservation_temporary"
  mv -T "$reservation_temporary" "$reservation_file"
  sync -f "$state_root"
fi

wrapper_stdout="$(mktemp "${state_root}/wrapper-result.XXXXXXXX.json")"
chmod 0600 "$wrapper_stdout"
set +e
cleanup_wrapper_env=()
if [[ $NELOS_GOLDEN_OPERATION == cleanup ]]; then cleanup_wrapper_env+=(NELOS_GOLDEN_CLEANUP_ONLY=1); fi
/usr/bin/env -i \
  PATH=/usr/bin:/bin LC_ALL=C \
  NELOS_GOLDEN_RESERVATION_FILE="$reservation_file" \
  NELOS_GOLDEN_BUILD_TOKEN_FILE="$NELOS_GOLDEN_BUILD_TOKEN_FILE" \
  NELOS_GOLDEN_ATTEST_TOKEN_FILE="$NELOS_GOLDEN_ATTEST_TOKEN_FILE" \
  NELOS_GOLDEN_STATE_DIR="$state_root" \
  NELOS_GOLDEN_ATTESTATION_DIR="$attestation_root" \
  NELOS_GOLDEN_PACKER_ARCHIVE="$packer_archive" \
  NELOS_GOLDEN_PLUGIN_ARCHIVE="$plugin_archive" \
  NELOS_GOLDEN_TLS_CA_FILE="$NELOS_GOLDEN_TLS_CA_FILE" \
  NELOS_GOLDEN_VOLUME_KNOWN_HOSTS="$NELOS_GOLDEN_VOLUME_KNOWN_HOSTS" \
  NELOS_GOLDEN_VOLUME_IDENTITY_FILE="$NELOS_GOLDEN_VOLUME_IDENTITY_FILE" \
  "${cleanup_wrapper_env[@]}" \
  "$node_bin" "$wrapper" >"$wrapper_stdout"
wrapper_status=$?
set -e
(( wrapper_status == 0 )) || die "guarded golden-image wrapper did not commit a terminal receipt; inspect only the sealed journal"

if [[ $NELOS_GOLDEN_OPERATION == cleanup ]] && jq -e 'keys == ["retryAllowed","schemaVersion","state"] and .schemaVersion == 1 and .state == "cleaned" and .retryAllowed == false' "$wrapper_stdout" >/dev/null; then
  completed_at="$(date --utc +%Y-%m-%dT%H:%M:%S.000Z)"
  cleanup_unsigned="$(jq -cnS --arg packetDigest "$packet_digest" --arg reservationDigest "$reservation_digest" --arg completedAt "$completed_at" \
    '{schemaVersion:1,kind:"nelos-golden-builder-cleanup-terminal",result:"cleaned",packetDigest:$packetDigest,reservationDigest:$reservationDigest,completedAt:$completedAt}')"
  cleanup_digest="sha256:$(printf '%s' "$cleanup_unsigned" | sha256sum | cut -d' ' -f1)"
  cleanup_temporary="$(mktemp "${terminal_parent}/.$(basename "$cleanup_receipt").XXXXXXXX.tmp")"
  jq -cnS --argjson unsigned "$cleanup_unsigned" --arg cleanupDigest "$cleanup_digest" '$unsigned + {cleanupDigest:$cleanupDigest}' > "$cleanup_temporary"
  chmod 0400 "$cleanup_temporary"
  /usr/bin/python3 - "$cleanup_temporary" "$cleanup_receipt" "$terminal_parent" <<'PY' || die "cleanup receipt exclusive atomic publication failed"
import ctypes, os, sys
source, target, parent = sys.argv[1:]
source_fd = os.open(source, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
try:
    os.fsync(source_fd)
finally:
    os.close(source_fd)
libc = ctypes.CDLL(None, use_errno=True)
renameat2 = libc.renameat2
renameat2.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
renameat2.restype = ctypes.c_int
if renameat2(-100, os.fsencode(source), -100, os.fsencode(target), 1) != 0:
    error = ctypes.get_errno()
    raise OSError(error, os.strerror(error), target)
directory_fd = os.open(parent, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
try:
    os.fsync(directory_fd)
finally:
    os.close(directory_fd)
PY
  cleanup_temporary=""
  cleanup_is_valid || die "published cleanup receipt failed its exact identity check"
  printf '%s\n' "$cleanup_receipt"
  exit 0
fi

jq -e 'keys == ["attestationDigest","goldenImage","path"] and (.attestationDigest | test("^sha256:[0-9a-f]{64}$")) and (.goldenImage.digest | test("^sha256:[0-9a-f]{64}$"))' "$wrapper_stdout" >/dev/null || die "wrapper result is invalid"
attestation_digest="$(jq -er '.attestationDigest' "$wrapper_stdout")"
golden_digest="$(jq -er '.goldenImage.digest' "$wrapper_stdout")"
golden_receipt="$(jq -er '.path' "$wrapper_stdout")"
[[ $golden_receipt == "${attestation_root}/${attestation_digest#sha256:}.json" && -f $golden_receipt && ! -L $golden_receipt && $(stat -c '%a' "$golden_receipt") == 400 ]] || die "golden receipt path, name, type, or mode differs"
jq -e --arg digest "$attestation_digest" '.schemaVersion == 2 and .kind == "nelos-proxmox-desktop-golden-image-v2" and .attestationDigest == $digest' "$golden_receipt" >/dev/null || die "golden receipt content differs"

completed_at="$(date --utc +%Y-%m-%dT%H:%M:%S.000Z)"
unsigned="$(jq -cnS \
  --arg packetDigest "$(jq -er '.builderPacket.packetDigest' "$bundle")" \
  --arg reservationDigest "$(jq -er '.builderPacket.reservationDigest' "$bundle")" \
  --arg attestationDigest "$attestation_digest" --arg goldenImageDigest "$golden_digest" --arg completedAt "$completed_at" \
  '{schemaVersion:1,kind:"nelos-golden-builder-terminal",result:"committed",packetDigest:$packetDigest,reservationDigest:$reservationDigest,attestationDigest:$attestationDigest,goldenImageDigest:$goldenImageDigest,completedAt:$completedAt}')"
terminal_digest="sha256:$(printf '%s' "$unsigned" | sha256sum | cut -d' ' -f1)"
terminal_temporary="$(mktemp "${terminal_parent}/.$(basename "$terminal_receipt").XXXXXXXX.tmp")"
jq -cnS --argjson unsigned "$unsigned" --arg terminalDigest "$terminal_digest" '$unsigned + {terminalDigest:$terminalDigest}' > "$terminal_temporary"
chmod 0400 "$terminal_temporary"
/usr/bin/python3 - "$terminal_temporary" "$terminal_receipt" "$terminal_parent" <<'PY' || die "terminal receipt exclusive atomic publication failed"
import ctypes, os, sys
source, target, parent = sys.argv[1:]
source_fd = os.open(source, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
try:
    os.fsync(source_fd)
finally:
    os.close(source_fd)
libc = ctypes.CDLL(None, use_errno=True)
renameat2 = libc.renameat2
renameat2.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
renameat2.restype = ctypes.c_int
if renameat2(-100, os.fsencode(source), -100, os.fsencode(target), 1) != 0:
    error = ctypes.get_errno()
    raise OSError(error, os.strerror(error), target)
directory_fd = os.open(parent, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
try:
    os.fsync(directory_fd)
finally:
    os.close(directory_fd)
PY
terminal_temporary=""
terminal_is_valid || die "published terminal receipt failed its exact identity check"
printf '%s\n' "$terminal_receipt"
