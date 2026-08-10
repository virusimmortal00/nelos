#!/usr/bin/env bash
# shellcheck disable=SC2154 # Required PKR_VAR_* values are supplied by the operator environment.
set -Eeuo pipefail
set +x
umask 077

die() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

require_env() {
  local name="$1"
  [[ -n ${!name:-} ]] || die "required environment variable ${name} is not set"
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || die "required command not found: $1"
}

without_proxmox_auth() {
  env \
    -u PROXMOX_URL \
    -u PROXMOX_USERNAME \
    -u PROXMOX_PASSWORD \
    -u PROXMOX_TOKEN \
    "$@"
}

(($# == 0)) || die "arguments are disabled because they could diverge from the sealed build inputs"
[[ $(uname -s) == "Linux" ]] || die "run this wrapper only on the dedicated Linux controller"
[[ $(uname -m) == "x86_64" ]] || die "run this wrapper only on an x86_64 controller"
[[ ! -e /etc/pve/local ]] || die "do not run this wrapper on a Proxmox hypervisor"

for name in PROXMOX_URL PROXMOX_USERNAME PROXMOX_TOKEN NELOS_PACKER_STATE_DIR; do
  require_env "$name"
done

for name in \
  NELOS_BASE_ATTESTATION_SSH_TARGET \
  NELOS_BASE_ATTESTATION_SSH_IDENTITY_FILE \
  NELOS_BASE_ATTESTATION_KNOWN_HOSTS_FILE \
  NELOS_BASE_ATTESTATION_BASELINE_FILE; do
  require_env "$name"
done

for name in \
  PKR_VAR_proxmox_node \
  PKR_VAR_base_template_vmid \
  PKR_VAR_base_template_name \
  PKR_VAR_output_template_vmid \
  PKR_VAR_output_template_name \
  PKR_VAR_cloud_init_storage; do
  require_env "$name"
done

for command in awk chmod curl dirname env find grep id install jq mktemp node realpath rm sha256sum sort stat uname unzip; do
  require_command "$command"
done
[[ -x /usr/bin/git ]] || die "required fixed Git executable not found: /usr/bin/git"
[[ -x /usr/bin/curl && -f /usr/bin/curl && ! -L /usr/bin/curl ]] || \
  die "required fixed curl executable not found: /usr/bin/curl"
[[ -x /usr/bin/env && -f /usr/bin/env && ! -L /usr/bin/env ]] || \
  die "required fixed env executable not found: /usr/bin/env"
[[ -x /usr/bin/perl && -f /usr/bin/perl && ! -L /usr/bin/perl ]] || \
  die "required fixed Perl executable not found: /usr/bin/perl"
[[ -x /usr/bin/ssh && -f /usr/bin/ssh && ! -L /usr/bin/ssh ]] || \
  die "required fixed SSH executable not found: /usr/bin/ssh"

[[ -z ${PROXMOX_PASSWORD:-} ]] || die "PROXMOX_PASSWORD must be unset; use a scoped API token"
for name in PACKER_LOG PACKER_LOG_PATH; do
  [[ -z ${!name:-} ]] || die "${name} must be unset so credentials cannot enter debug logs"
done
while IFS= read -r name; do
  die "ambient Packer variable ${name} must be unset; the wrapper supplies isolated state"
done < <(compgen -A variable PACKER_)
while IFS= read -r name; do
  die "ambient HCP variable ${name} must be unset for this local-only build"
done < <(compgen -A variable HCP_)
for name in HTTP_PROXY HTTPS_PROXY ALL_PROXY http_proxy https_proxy all_proxy; do
  [[ -z ${!name:-} ]] || die "${name} must be unset so the Proxmox token is not sent through a proxy"
done

while IFS= read -r name; do
  case "$name" in
    PKR_VAR_proxmox_node | \
      PKR_VAR_proxmox_pool | \
      PKR_VAR_base_template_vmid | \
      PKR_VAR_base_template_name | \
      PKR_VAR_output_template_vmid | \
      PKR_VAR_output_template_name | \
      PKR_VAR_cloud_init_storage) ;;
    *) die "unsupported Packer environment override: ${name}" ;;
  esac
done < <(compgen -A variable PKR_VAR_)

readonly BASE_TEMPLATE_VMID="${PKR_VAR_base_template_vmid}"
readonly BASE_TEMPLATE_NAME="${PKR_VAR_base_template_name}"
readonly OUTPUT_TEMPLATE_VMID="${PKR_VAR_output_template_vmid}"
readonly OUTPUT_TEMPLATE_NAME="${PKR_VAR_output_template_name}"
readonly PROXMOX_NODE="${PKR_VAR_proxmox_node}"
readonly PROXMOX_POOL="${PKR_VAR_proxmox_pool:-}"
readonly CLOUD_INIT_STORAGE="${PKR_VAR_cloud_init_storage}"
readonly BASE_ATTESTATION_SSH_TARGET="${NELOS_BASE_ATTESTATION_SSH_TARGET}"
readonly BASE_ATTESTATION_SSH_IDENTITY_FILE="${NELOS_BASE_ATTESTATION_SSH_IDENTITY_FILE}"
readonly BASE_ATTESTATION_KNOWN_HOSTS_FILE="${NELOS_BASE_ATTESTATION_KNOWN_HOSTS_FILE}"
readonly BASE_ATTESTATION_BASELINE_FILE="${NELOS_BASE_ATTESTATION_BASELINE_FILE}"

[[ ${PROXMOX_URL} =~ ^https://[A-Za-z0-9][A-Za-z0-9.-]*(:[0-9]{1,5})?/api2/json$ ]] || \
  die "PROXMOX_URL must be an HTTPS hostname URL ending in /api2/json"
[[ ${PROXMOX_USERNAME} =~ ^[A-Za-z0-9._-]+@[A-Za-z0-9._-]+\![A-Za-z0-9._-]+$ ]] || \
  die "PROXMOX_USERNAME must use the user@realm!token-id form"
[[ ${PROXMOX_TOKEN} =~ ^[A-Za-z0-9._~-]+$ ]] || die "PROXMOX_TOKEN contains an unsupported character"
[[ ${BASE_TEMPLATE_VMID} =~ ^[0-9]+$ ]] || die "PKR_VAR_base_template_vmid must be an integer"
[[ ${OUTPUT_TEMPLATE_VMID} =~ ^[0-9]+$ ]] || die "PKR_VAR_output_template_vmid must be an integer"
((BASE_TEMPLATE_VMID >= 100 && BASE_TEMPLATE_VMID <= 999999999)) || die "base template VMID is out of range"
((OUTPUT_TEMPLATE_VMID >= 100 && OUTPUT_TEMPLATE_VMID <= 999999999)) || die "output template VMID is out of range"
((BASE_TEMPLATE_VMID != OUTPUT_TEMPLATE_VMID)) || die "base and output VMIDs must differ"
[[ ${PROXMOX_NODE} =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]] || die "Proxmox node name is unsafe"
[[ ${BASE_TEMPLATE_NAME} =~ ^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?$ ]] || die "base template name must be a DNS-safe single label"
[[ ${OUTPUT_TEMPLATE_NAME} =~ ^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?$ ]] || die "output template name must be a DNS-safe single label"
[[ ${CLOUD_INIT_STORAGE} =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]] || die "Cloud-Init storage ID is unsafe"
[[ -z ${PROXMOX_POOL} || ${PROXMOX_POOL} =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]] || die "Proxmox pool name is unsafe"
[[ ${BASE_ATTESTATION_SSH_TARGET} =~ ^[a-z_][a-z0-9_-]*@([A-Za-z0-9][A-Za-z0-9.-]*|\[[A-Fa-f0-9:]+\])$ ]] || \
  die "NELOS_BASE_ATTESTATION_SSH_TARGET must be an exact user@host target without a port or options"

assert_controller_attestation_file() {
  local path="$1"
  local label="$2"
  local exact_mode="${3:-}"
  local canonical current owner mode link_count permission_bits controller_uid fixed_path

  [[ $path == /* && $path =~ ^/[A-Za-z0-9._/-]+$ ]] || die "${label} must be a specific absolute path without whitespace"
  [[ -f $path && ! -L $path ]] || die "${label} must be a regular non-symlink file"
  for fixed_path in /usr/bin/dirname /usr/bin/id /usr/bin/realpath /usr/bin/stat; do
    [[ -x $fixed_path && -f $fixed_path && ! -L $fixed_path ]] || die "required fixed executable is unavailable: ${fixed_path}"
  done
  canonical="$(/usr/bin/realpath -e -- "$path")" || die "could not resolve ${label}"
  [[ $canonical == "$path" ]] || die "${label} must use its canonical path"
  case "${canonical}/" in
    "${REPOSITORY_ROOT}/"*) die "${label} must be outside the source checkout" ;;
  esac
  controller_uid="$(/usr/bin/id -u)"
  owner="$(/usr/bin/stat -c '%u' -- "$path")" || die "could not inspect ${label} ownership"
  mode="$(/usr/bin/stat -c '%a' -- "$path")" || die "could not inspect ${label} permissions"
  link_count="$(/usr/bin/stat -c '%h' -- "$path")" || die "could not inspect ${label} link count"
  [[ $owner == "$controller_uid" && $mode =~ ^[0-7]{3,4}$ ]] || die "${label} must be owned by the controller user"
  [[ $link_count == 1 ]] || die "${label} must have exactly one hard link"
  permission_bits=$((8#$mode))
  (( (permission_bits & 0022) == 0 )) || die "${label} must not be group- or world-writable"
  [[ -z $exact_mode || $mode == "$exact_mode" ]] || die "${label} must have mode ${exact_mode}"

  current="$(/usr/bin/dirname -- "$canonical")"
  while true; do
    [[ -d $current && ! -L $current ]] || die "${label} ancestor must be a non-symlink directory: ${current}"
    owner="$(/usr/bin/stat -c '%u' -- "$current")" || die "could not inspect ${label} ancestor ownership"
    mode="$(/usr/bin/stat -c '%a' -- "$current")" || die "could not inspect ${label} ancestor permissions"
    [[ ($owner == 0 || $owner == "$controller_uid") && $mode =~ ^[0-7]{3,4}$ ]] || \
      die "${label} ancestor ownership or permissions are invalid: ${current}"
    permission_bits=$((8#$mode))
    (( (permission_bits & 0022) == 0 )) || die "${label} ancestor must not be group- or world-writable: ${current}"
    [[ $current == / ]] && break
    current="$(/usr/bin/dirname -- "$current")"
  done
}

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
readonly SCRIPT_DIR
PACKER_DIR="$(realpath -m -- "${SCRIPT_DIR}/../packer")"
REPOSITORY_ROOT="$(realpath -m -- "${SCRIPT_DIR}/../../..")"
readonly PACKER_DIR REPOSITORY_ROOT
readonly TOOLCHAIN_LOCK="${REPOSITORY_ROOT}/validation/proxmox/toolchain.lock.json"

git_readonly() {
  env -i \
    PATH=/usr/bin:/bin \
    LC_ALL=C \
    GIT_CONFIG_NOSYSTEM=1 \
    GIT_CONFIG_GLOBAL=/dev/null \
    GIT_ATTR_NOSYSTEM=1 \
    GIT_GRAFT_FILE=/dev/null \
    GIT_NO_LAZY_FETCH=1 \
    GIT_NO_REPLACE_OBJECTS=1 \
    GIT_REF_PARANOIA=1 \
    /usr/bin/git \
      --no-replace-objects \
      --literal-pathspecs \
      --no-optional-locks \
      -c core.useReplaceRefs=false \
      -c core.attributesFile=/dev/null \
      -c core.commitGraph=false \
      -c core.multiPackIndex=false \
      -c core.fsmonitor=false \
      -c core.untrackedCache=false \
      -C "$REPOSITORY_ROOT" \
      "$@"
}

assert_candidate_tree_regular() {
  # shellcheck disable=SC2016 # Embedded Perl source must not be expanded by Bash.
  if ! git_readonly ls-tree -r -z --full-tree "$SOURCE_REVISION" -- |
    /usr/bin/env -i \
      PATH=/usr/bin:/bin \
      LC_ALL=C \
      HOME=/nonexistent \
      NELOS_CANDIDATE_OBJECT_ID_WIDTH="$GIT_OBJECT_ID_WIDTH" \
      /usr/bin/perl -0ne '
      BEGIN {
        $expected_width = $ENV{NELOS_CANDIDATE_OBJECT_ID_WIDTH} // q{};
        exit 65 unless $expected_width eq q{40} || $expected_width eq q{64};
      }
      s/\0\z// or exit 66;
      /\A([0-7]{6}) (blob|commit) ([a-f0-9]+)\t(.+)\z/s or exit 66;
      exit 66 unless
        ($1 eq q{100644} || $1 eq q{100755}) &&
        $2 eq q{blob} &&
        length($3) == $expected_width;
    '; then
    die "source candidate tree must contain only regular tracked files"
  fi
}

repository_top="$(git_readonly rev-parse --show-toplevel 2>/dev/null)" || die "source checkout is not a Git worktree"
[[ $(realpath -e -- "$repository_top") == "$REPOSITORY_ROOT" ]] || die "script path and Git worktree root do not match"
git_common_dir="$(git_readonly rev-parse --path-format=absolute --git-common-dir)" || \
  die "could not resolve source checkout common Git directory"
[[ $git_common_dir == /* && -d $git_common_dir && ! -L $git_common_dir ]] || \
  die "source checkout common Git directory is not an absolute regular directory"
readonly git_common_dir

reject_git_backend_file() {
  local control_path="$1"
  local label="$2"
  if [[ -e $control_path || -L $control_path ]]; then
    [[ -f $control_path && ! -L $control_path && ! -s $control_path ]] || \
      die "source checkout ${label} must be absent or an empty regular file"
  fi
}

reject_git_backend_file "${git_common_dir}/info/grafts" "legacy grafts file"
reject_git_backend_file "${git_common_dir}/objects/info/alternates" "object alternates file"
replacement_refs="$(git_readonly for-each-ref --format='%(refname)' refs/replace/)" || \
  die "could not inspect source checkout replacement refs"
[[ -z $replacement_refs ]] || die "source checkout replacement refs are forbidden"
git_config_inventory="$(git_readonly config --includes --show-scope --name-only --list)" || \
  die "could not inspect source checkout Git configuration"
while IFS=$'\t' read -r config_scope config_key; do
  [[ -n $config_scope && -n $config_key ]] || die "source checkout Git configuration inventory is malformed"
  normalized_config_key="$(LC_ALL=C awk '{ print tolower($0) }' <<<"$config_key")"
  case "$normalized_config_key" in
    extensions.partialclone | remote.*.promisor | remote.*.partialclonefilter)
      die "source checkout partial-clone and promisor configuration is forbidden"
      ;;
  esac
done <<<"$git_config_inventory"
GIT_OBJECT_FORMAT="$(git_readonly rev-parse --show-object-format=storage)" || \
  die "could not resolve source checkout Git object format"
case "$GIT_OBJECT_FORMAT" in
  sha1) readonly GIT_OBJECT_ID_WIDTH=40 ;;
  sha256) readonly GIT_OBJECT_ID_WIDTH=64 ;;
  *) die "source checkout Git object format must be sha1 or sha256" ;;
esac
readonly GIT_OBJECT_FORMAT
SOURCE_REVISION="$(git_readonly rev-parse --verify --end-of-options 'HEAD^{commit}')" || \
  die "source checkout has no resolvable commit"
readonly SOURCE_REVISION
[[ ${SOURCE_REVISION} =~ ^[a-f0-9]+$ && ${#SOURCE_REVISION} -eq $GIT_OBJECT_ID_WIDTH ]] || \
  die "source revision is not a full object ID for the repository Git object format"
[[ -z $(git_readonly status --porcelain=v1 --untracked-files=all) ]] || die "source checkout must be clean, including untracked files"
assert_candidate_tree_regular

assert_controller_attestation_file "$BASE_ATTESTATION_SSH_IDENTITY_FILE" "attestation SSH identity" 600
assert_controller_attestation_file "$BASE_ATTESTATION_KNOWN_HOSTS_FILE" "attestation known_hosts file" 400
assert_controller_attestation_file "$BASE_ATTESTATION_BASELINE_FILE" "trusted base disk baseline receipt" 600
BASE_ATTESTATION_BASELINE_JSON="$(/usr/bin/perl -e '
  binmode(STDIN);
  binmode(STDOUT);
  my $receipt = q{};
  while (1) {
    my $count = sysread(STDIN, my $chunk, 8192);
    die "read" unless defined($count);
    last if $count == 0;
    $receipt .= $chunk;
    die "size" if length($receipt) > 4097;
  }
  die "framing" unless length($receipt) >= 2 && substr($receipt, -1, 1) eq qq{\n};
  chop($receipt);
  die "framing" if index($receipt, qq{\n}) >= 0 || index($receipt, qq{\0}) >= 0;
  print $receipt;
' <"$BASE_ATTESTATION_BASELINE_FILE")" || die "trusted base disk baseline receipt envelope is malformed"
readonly BASE_ATTESTATION_BASELINE_JSON
unset \
  NELOS_BASE_ATTESTATION_SSH_TARGET \
  NELOS_BASE_ATTESTATION_SSH_IDENTITY_FILE \
  NELOS_BASE_ATTESTATION_KNOWN_HOSTS_FILE \
  NELOS_BASE_ATTESTATION_BASELINE_FILE
unset SSH_AGENT_PID SSH_AUTH_SOCK

readonly -a EXPECTED_PACKER_SOURCES=(
  build.pkr.hcl
  proxmox.pkr.hcl
  variables.pkr.hcl
  versions.pkr.hcl
)
mapfile -t actual_packer_sources < <(
  find "$PACKER_DIR" -mindepth 1 -maxdepth 1 -type f -name '*.pkr.hcl' -printf '%f\n' | LC_ALL=C sort
)
[[ ${#actual_packer_sources[@]} -eq ${#EXPECTED_PACKER_SOURCES[@]} ]] || die "Packer source inventory is not the expected closed set"
for index in "${!EXPECTED_PACKER_SOURCES[@]}"; do
  [[ ${actual_packer_sources[$index]} == "${EXPECTED_PACKER_SOURCES[$index]}" ]] || \
    die "Packer source inventory is not the expected closed set"
done

readonly -a SEALED_INPUTS=(
  "${TOOLCHAIN_LOCK}"
  "${REPOSITORY_ROOT}/validation/proxmox/cloud-init/99-nelos-validator.cfg"
  "${REPOSITORY_ROOT}/validation/proxmox/scripts/provision-guest.sh"
  "${REPOSITORY_ROOT}/validation/proxmox/scripts/prepare-template.sh"
)
for source_path in "${SEALED_INPUTS[@]}"; do
  [[ -f $source_path && ! -L $source_path ]] || die "sealed source input must be a regular non-symlink file: ${source_path}"
done
for source_name in "${EXPECTED_PACKER_SOURCES[@]}"; do
  [[ -f ${PACKER_DIR}/${source_name} && ! -L ${PACKER_DIR}/${source_name} ]] || \
    die "Packer source must be a regular non-symlink file: ${source_name}"
done

without_proxmox_auth env -u NODE_OPTIONS -u NODE_PATH \
  node "${REPOSITORY_ROOT}/validation/proxmox/scripts/validate-contract.mjs" \
    --root "$REPOSITORY_ROOT" \
    --candidate-revision "$SOURCE_REVISION" >/dev/null || \
  die "repository contract validation failed"
readonly SOURCE_LOCK_SPEC="${SOURCE_REVISION}:validation/proxmox/toolchain.lock.json"
expected_node_version="$(git_readonly show "$SOURCE_LOCK_SPEC" | jq -er '.artifacts.node.version')"
observed_node_version="$(without_proxmox_auth env -u NODE_OPTIONS -u NODE_PATH node --version)"
[[ $observed_node_version == "v${expected_node_version}" ]] || \
  die "expected Node.js ${expected_node_version}, found ${observed_node_version}"
UBUNTU_IMAGE_SHA256="$(git_readonly show "$SOURCE_LOCK_SPEC" | jq -er '.artifacts.ubuntuCloudImage.sha256')"
readonly UBUNTU_IMAGE_SHA256

readonly CONFIGURED_STATE_ROOT="${NELOS_PACKER_STATE_DIR}"
[[ ${CONFIGURED_STATE_ROOT} =~ ^/[A-Za-z0-9._/-]+$ && ${CONFIGURED_STATE_ROOT} != / ]] || \
  die "NELOS_PACKER_STATE_DIR must be a specific absolute path without whitespace"
[[ ! -L $CONFIGURED_STATE_ROOT ]] || die "NELOS_PACKER_STATE_DIR must not be a symbolic link"
if [[ -e $CONFIGURED_STATE_ROOT ]]; then
  [[ -d $CONFIGURED_STATE_ROOT ]] || die "NELOS_PACKER_STATE_DIR must be a directory"
else
  install -d -m 0700 "$CONFIGURED_STATE_ROOT"
fi
STATE_ROOT="$(realpath -e -- "$CONFIGURED_STATE_ROOT")"
readonly STATE_ROOT
case "${STATE_ROOT}/" in
  "${REPOSITORY_ROOT}/"*) die "NELOS_PACKER_STATE_DIR must be outside the source checkout" ;;
esac
case "${REPOSITORY_ROOT}/" in
  "${STATE_ROOT}/"*) die "NELOS_PACKER_STATE_DIR must not contain the source checkout" ;;
esac
[[ $(stat -c '%u' "$STATE_ROOT") == "$(id -u)" ]] || die "NELOS_PACKER_STATE_DIR must be owned by the current user"
[[ $(stat -c '%a' "$STATE_ROOT") == "700" ]] || die "NELOS_PACKER_STATE_DIR must have mode 0700"

RUN_ROOT="$(mktemp -d --tmpdir="$STATE_ROOT" nelos-run.XXXXXXXXXX)"
readonly RUN_ROOT
cleanup_run() {
  case "${RUN_ROOT}" in
    "${STATE_ROOT}"/nelos-run.*)
      if [[ -d $RUN_ROOT && ! -L $RUN_ROOT && $(stat -c '%u' "$RUN_ROOT") == "$(id -u)" ]]; then
        rm -rf --one-file-system -- "$RUN_ROOT"
      else
        printf 'warning: refusing ambiguous run-directory cleanup: %s\n' "$RUN_ROOT" >&2
      fi
      ;;
    *) printf 'warning: refusing out-of-scope run-directory cleanup: %s\n' "$RUN_ROOT" >&2 ;;
  esac
}
trap cleanup_run EXIT
[[ $(stat -c '%a' "$RUN_ROOT") == "700" ]] || die "temporary run directory must have mode 0700"

readonly SEALED_SOURCE="${RUN_ROOT}/source"
readonly SEALED_PACKER_DIR="${SEALED_SOURCE}/packer"
readonly DOWNLOAD_DIR="${RUN_ROOT}/downloads"
readonly TOOL_BIN_DIR="${RUN_ROOT}/bin"
readonly PLUGIN_EXTRACT_DIR="${RUN_ROOT}/plugin-extract"
install -d -m 0700 \
  "$SEALED_PACKER_DIR" \
  "${SEALED_SOURCE}/cloud-init" \
  "${SEALED_SOURCE}/scripts" \
  "$DOWNLOAD_DIR" \
  "$TOOL_BIN_DIR" \
  "$PLUGIN_EXTRACT_DIR" \
  "${RUN_ROOT}/cache" \
  "${RUN_ROOT}/config" \
  "${RUN_ROOT}/plugins" \
  "${RUN_ROOT}/tmp" \
  "${RUN_ROOT}/xdg-cache" \
  "${RUN_ROOT}/xdg-config" \
  "${RUN_ROOT}/xdg-data"

materialize_tracked() {
  local repository_path="$1"
  local destination="$2"
  local destination_mode="$3"
  local materialized_object source_mode source_record source_type source_object source_path

  source_record="$(git_readonly ls-tree "$SOURCE_REVISION" -- "$repository_path")" || \
    die "could not inspect sealed input at source revision: ${repository_path}"
  [[ -n $source_record && $source_record != *$'\n'* ]] || \
    die "sealed input must resolve to exactly one tree record: ${repository_path}"
  read -r source_mode source_type source_object source_path <<<"$source_record"
  [[ $source_type == "blob" && ($source_mode == "100644" || $source_mode == "100755") ]] || \
    die "sealed input is not a regular tracked file at source revision: ${repository_path}"
  [[ $source_object =~ ^[a-f0-9]+$ && ${#source_object} -eq $GIT_OBJECT_ID_WIDTH ]] || \
    die "sealed input object ID does not match the repository Git object format: ${repository_path}"
  [[ $source_path == "$repository_path" ]] || die "sealed input path did not resolve exactly: ${repository_path}"
  git_readonly cat-file blob "$source_object" >"$destination" || \
    die "could not materialize sealed input: ${repository_path}"
  materialized_object="$(git_readonly hash-object --no-filters -- "$destination")" || \
    die "could not verify materialized sealed input: ${repository_path}"
  [[ $materialized_object == "$source_object" ]] || \
    die "materialized sealed input does not match its source object: ${repository_path}"
  chmod "$destination_mode" "$destination"
}

for source_name in "${EXPECTED_PACKER_SOURCES[@]}"; do
  materialize_tracked \
    "validation/proxmox/packer/${source_name}" \
    "${SEALED_PACKER_DIR}/${source_name}" \
    0444
done
materialize_tracked \
  "validation/proxmox/toolchain.lock.json" \
  "${SEALED_SOURCE}/toolchain.lock.json" \
  0444
readonly SEALED_TOOLCHAIN_LOCK="${SEALED_SOURCE}/toolchain.lock.json"
materialize_tracked \
  "validation/proxmox/cloud-init/99-nelos-validator.cfg" \
  "${SEALED_SOURCE}/cloud-init/99-nelos-validator.cfg" \
  0444
materialize_tracked \
  "validation/proxmox/scripts/provision-guest.sh" \
  "${SEALED_SOURCE}/scripts/provision-guest.sh" \
  0555
materialize_tracked \
  "validation/proxmox/scripts/prepare-template.sh" \
  "${SEALED_SOURCE}/scripts/prepare-template.sh" \
  0555

export CHECKPOINT_DISABLE=1
export PACKER_CACHE_DIR="${RUN_ROOT}/cache"
export PACKER_CONFIG_DIR="${RUN_ROOT}/config"
export PACKER_PLUGIN_PATH="${RUN_ROOT}/plugins"
export PACKER_CONFIG="${RUN_ROOT}/config/packer.json"
export TMPDIR="${RUN_ROOT}/tmp"
export XDG_CACHE_HOME="${RUN_ROOT}/xdg-cache"
export XDG_CONFIG_HOME="${RUN_ROOT}/xdg-config"
export XDG_DATA_HOME="${RUN_ROOT}/xdg-data"
unset SSH_AGENT_PID SSH_AUTH_SOCK
printf '{}\n' >"$PACKER_CONFIG"
chmod 0600 "$PACKER_CONFIG"

download_verified() {
  local url="$1"
  local sha256="$2"
  local destination="$3"
  without_proxmox_auth curl --disable --fail --silent --show-error --location \
    --proto '=https' --proto-redir '=https' --tlsv1.2 \
    --output "$destination" "$url"
  printf '%s  %s\n' "$sha256" "$destination" | sha256sum --check --status
}

packer_url="$(jq -er '.artifacts.packer.url' "$SEALED_TOOLCHAIN_LOCK")"
packer_sha="$(jq -er '.artifacts.packer.sha256' "$SEALED_TOOLCHAIN_LOCK")"
packer_file="$(jq -er '.artifacts.packer.fileName' "$SEALED_TOOLCHAIN_LOCK")"
plugin_url="$(jq -er '.artifacts.packerProxmoxPlugin.url' "$SEALED_TOOLCHAIN_LOCK")"
plugin_sha="$(jq -er '.artifacts.packerProxmoxPlugin.sha256' "$SEALED_TOOLCHAIN_LOCK")"
plugin_file="$(jq -er '.artifacts.packerProxmoxPlugin.fileName' "$SEALED_TOOLCHAIN_LOCK")"
for artifact_name in "$packer_file" "$plugin_file"; do
  [[ ${artifact_name} =~ ^[A-Za-z0-9._-]+$ ]] || die "toolchain archive filename is unsafe"
done
readonly PACKER_ZIP="${DOWNLOAD_DIR}/${packer_file}"
readonly PLUGIN_ZIP="${DOWNLOAD_DIR}/${plugin_file}"
download_verified "$packer_url" "$packer_sha" "$PACKER_ZIP" || die "Packer archive verification failed"
download_verified "$plugin_url" "$plugin_sha" "$PLUGIN_ZIP" || die "Proxmox plugin archive verification failed"
unzip -q "$PACKER_ZIP" -d "$TOOL_BIN_DIR"
unzip -q "$PLUGIN_ZIP" -d "$PLUGIN_EXTRACT_DIR"

readonly PACKER_BIN="${TOOL_BIN_DIR}/packer"
readonly PLUGIN_BINARY="${PLUGIN_EXTRACT_DIR}/${plugin_file%.zip}"
[[ -f $PACKER_BIN && ! -L $PACKER_BIN ]] || die "verified Packer archive did not contain the expected binary"
[[ -f $PLUGIN_BINARY && ! -L $PLUGIN_BINARY ]] || die "verified Proxmox plugin archive did not contain the expected binary"
chmod 0555 "$PACKER_BIN" "$PLUGIN_BINARY"
packer_version="$(without_proxmox_auth "$PACKER_BIN" version | awk 'NR == 1 { sub(/^Packer v/, ""); print; exit }')"
[[ ${packer_version} == "1.15.4" ]] || die "expected Packer 1.15.4, found ${packer_version:-unknown}"

readonly OFFLINE_PROXY="http://127.0.0.1:9"
without_proxmox_auth env \
  HTTP_PROXY="$OFFLINE_PROXY" \
  HTTPS_PROXY="$OFFLINE_PROXY" \
  ALL_PROXY="$OFFLINE_PROXY" \
  NO_PROXY= \
  http_proxy="$OFFLINE_PROXY" \
  https_proxy="$OFFLINE_PROXY" \
  all_proxy="$OFFLINE_PROXY" \
  no_proxy= \
  "$PACKER_BIN" plugins install --path "$PLUGIN_BINARY" github.com/hashicorp/proxmox
without_proxmox_auth env \
  HTTP_PROXY="$OFFLINE_PROXY" \
  HTTPS_PROXY="$OFFLINE_PROXY" \
  ALL_PROXY="$OFFLINE_PROXY" \
  NO_PROXY= \
  http_proxy="$OFFLINE_PROXY" \
  https_proxy="$OFFLINE_PROXY" \
  all_proxy="$OFFLINE_PROXY" \
  no_proxy= \
  "$PACKER_BIN" init "$SEALED_PACKER_DIR"

readonly API_ROOT="${PROXMOX_URL%/}"
api_get() {
  local endpoint="$1"
  command builtin printf \
    'header = "Authorization: PVEAPIToken=%s=%s"\n' \
    "$PROXMOX_USERNAME" "$PROXMOX_TOKEN" |
    /usr/bin/env -i \
      PATH=/usr/bin:/bin \
      LC_ALL=C \
      HOME=/nonexistent \
      /usr/bin/curl --disable --fail --silent --show-error --proto '=https' --tlsv1.2 \
        --config - "${API_ROOT}/${endpoint}"
}

run_base_disk_attestation() {
  local attestation_nonce="$1"
  local request response response_path fresh_config fresh_pending

  [[ $attestation_nonce =~ ^build-[a-f0-9]{32}$ ]] || die "base disk attestation nonce is invalid"
  [[ -x /usr/bin/timeout && -f /usr/bin/timeout && ! -L /usr/bin/timeout ]] || \
    die "required fixed timeout executable not found: /usr/bin/timeout"
  request="$(jq -cn \
    --arg nonce "$attestation_nonce" \
    --arg node "$PROXMOX_NODE" \
    --argjson vmid "$BASE_TEMPLATE_VMID" \
    --arg name "$BASE_TEMPLATE_NAME" \
    --arg digest "$base_config_digest" \
    '{
      schemaVersion: 1,
      nonce: $nonce,
      node: $node,
      baseTemplateVmid: $vmid,
      baseTemplateName: $name,
      configDigest: $digest
    }')" || die "could not create base disk attestation request"
  [[ $request != *$'\n'* && ${#request} -le 2048 ]] || die "base disk attestation request is malformed"

  response_path="${RUN_ROOT}/base-disk-attestation.json"
  [[ ! -e $response_path && ! -L $response_path ]] || die "base disk attestation output path already exists"
  if ! printf '%s\n' "$request" | \
    /usr/bin/timeout --foreground --signal=TERM --kill-after=30s 2700s \
    /usr/bin/env -i \
      PATH=/usr/bin:/bin \
      LC_ALL=C \
      HOME=/nonexistent \
      /usr/bin/ssh \
        -F /dev/null \
        -T \
        -i "$BASE_ATTESTATION_SSH_IDENTITY_FILE" \
        -o BatchMode=yes \
        -o CanonicalizeHostname=no \
        -o CheckHostIP=no \
        -o ClearAllForwardings=yes \
        -o ConnectionAttempts=1 \
        -o ConnectTimeout=15 \
        -o ControlMaster=no \
        -o ControlPath=none \
        -o EscapeChar=none \
        -o ForwardAgent=no \
        -o GlobalKnownHostsFile=/dev/null \
        -o IdentitiesOnly=yes \
        -o IdentityAgent=none \
        -o KbdInteractiveAuthentication=no \
        -o LocalCommand=none \
        -o LogLevel=ERROR \
        -o NumberOfPasswordPrompts=0 \
        -o PasswordAuthentication=no \
        -o PermitLocalCommand=no \
        -o PreferredAuthentications=publickey \
        -o ProxyCommand=none \
        -o ProxyJump=none \
        -o PubkeyAuthentication=yes \
        -o RequestTTY=no \
        -o ServerAliveCountMax=4 \
        -o ServerAliveInterval=15 \
        -o StrictHostKeyChecking=yes \
        -o UpdateHostKeys=no \
        -o UserKnownHostsFile="$BASE_ATTESTATION_KNOWN_HOSTS_FILE" \
        -o VerifyHostKeyDNS=no \
        "$BASE_ATTESTATION_SSH_TARGET" | \
    /usr/bin/perl -e '
      binmode(STDIN);
      binmode(STDOUT);
      my $response = q{};
      while (1) {
        my $count = sysread(STDIN, my $chunk, 8192);
        die "read" unless defined($count);
        last if $count == 0;
        $response .= $chunk;
        die "size" if length($response) > 4097;
      }
      die "framing" unless length($response) >= 2 && substr($response, -1, 1) eq qq{\n};
      chop($response);
      die "framing" if index($response, qq{\n}) >= 0 || index($response, qq{\0}) >= 0;
      print $response;
    ' >"$response_path"; then
    die "base-template disk attestation command or response envelope failed"
  fi
  response="$(<"$response_path")"
  [[ -n $response && ${#response} -le 4096 ]] || die "base-template disk attestation response is empty or oversized"
  jq -e \
    --arg nonce "$attestation_nonce" \
    --arg node "$PROXMOX_NODE" \
    --argjson vmid "$BASE_TEMPLATE_VMID" \
    --arg name "$BASE_TEMPLATE_NAME" \
    --arg digest "$base_config_digest" \
    --arg scsi0_volume "$base_scsi0_volume" \
    --arg efidisk0_volume "$base_efidisk0_volume" \
    --argjson baseline "$BASE_ATTESTATION_BASELINE_JSON" '
      type == "object" and
      keys == ["baseTemplateName", "baseTemplateVmid", "configDigest", "disks", "node", "nonce", "schemaVersion"] and
      .schemaVersion == 1 and
      .nonce == $nonce and
      .node == $node and
      .baseTemplateVmid == $vmid and
      .baseTemplateName == $name and
      .configDigest == $digest and
      (.disks | type == "object" and keys == ["efidisk0", "scsi0"]) and
      (all(.disks[];
        type == "object" and
        keys == ["backend", "logicalSizeBytes", "nativeIdentity", "sha256", "volumeId"] and
        (.backend == "lvmthin" or .backend == "zfspool") and
        (.nativeIdentity | type == "string" and test("^[A-Za-z0-9:+._/-]+$")) and
        (.sha256 | type == "string" and test("^[a-f0-9]{64}$")) and
        (.logicalSizeBytes | type == "number" and floor == . and . > 0) and
        (.volumeId | type == "string"))) and
      .disks == $baseline.disks and
      .disks.scsi0.volumeId == $scsi0_volume and
      .disks.efidisk0.volumeId == $efidisk0_volume
    ' <<<"$response" >/dev/null || die "base-template disk attestation does not match the pinned baseline"

  printf '%s\n' "$response" >"$response_path"
  chmod 0600 "$response_path"

  fresh_config="$(api_get "nodes/${PROXMOX_NODE}/qemu/${BASE_TEMPLATE_VMID}/config?current=1")" || \
    die "could not re-read current base template configuration after disk attestation"
  jq -e --arg digest "$base_config_digest" '.data.digest == $digest' <<<"$fresh_config" >/dev/null || \
    die "base template configuration changed after disk attestation"
  fresh_pending="$(api_get "nodes/${PROXMOX_NODE}/qemu/${BASE_TEMPLATE_VMID}/pending")" || \
    die "could not re-read pending base template configuration after disk attestation"
  jq -e "$BASE_TEMPLATE_PENDING_CONFIG_JQ" <<<"$fresh_pending" >/dev/null || \
    die "base template gained pending configuration after disk attestation"
}

version_response="$(api_get version)" || die "could not query Proxmox version"
jq -e '.data.version | startswith("8.4.")' <<<"$version_response" >/dev/null || die "target must run Proxmox VE 8.4"

resources_response="$(api_get 'cluster/resources?type=vm')" || die "could not query Proxmox VM inventory"
jq -e '.data | type == "array"' <<<"$resources_response" >/dev/null || die "unexpected Proxmox inventory response"

readonly LINKED_CLONE_STORAGE_TYPES_CSV="lvmthin,zfspool"
readonly FULL_COPY_STORAGE_TYPES_CSV="dir,lvm,lvmthin,zfspool"
readonly BLOCK_CLOUD_INIT_STORAGE_TYPES_CSV="lvm,lvmthin,zfspool"
readonly BASE_TEMPLATE_REQUIRED_CONFIG_KEYS_JSON='["agent","balloon","bios","boot","citype","ciupgrade","ciuser","cores","cpu","description","efidisk0","ide2","ipconfig0","machine","memory","meta","name","net0","ostype","scsi0","scsihw","serial0","smbios1","sockets","tags","template","vga","vmgenid"]'
readonly BASE_TEMPLATE_OPTIONAL_CONFIG_KEYS_JSON='["arch","onboot"]'
readonly BASE_TEMPLATE_API_METADATA_KEYS_JSON='["digest"]'
readonly BASE_TEMPLATE_FORBIDDEN_CONFIG_KEYS_JSON='["amd-sev","args","bootdisk","cdrom","cicustom","cipassword","hookscript","ivshmem","nameserver","runningcpu","runningmachine","searchdomain","spice_enhancements","sshkeys","tablet","vmstate","watchdog"]'
# shellcheck disable=SC2016
readonly TRUSTED_BASELINE_JQ='
  type == "object" and
  keys == [
    "baseTemplateName",
    "baseTemplateVmid",
    "configDigest",
    "disks",
    "node",
    "nonce",
    "receiptKind",
    "schemaVersion",
    "ubuntuImageSha256"
  ] and
  .schemaVersion == 1 and
  (.nonce | type == "string" and test("^baseline-[a-f0-9]{32}$")) and
  .receiptKind == "trusted-bootstrap-baseline" and
  .node == $node and
  .baseTemplateVmid == $vmid and
  .baseTemplateName == $name and
  .configDigest == $digest and
  .ubuntuImageSha256 == $ubuntu_sha and
  (.disks | type == "object" and keys == ["efidisk0", "scsi0"]) and
  (all(.disks[];
    type == "object" and
    keys == ["backend", "logicalSizeBytes", "nativeIdentity", "sha256", "volumeId"] and
    (.backend == "lvmthin" or .backend == "zfspool") and
    (if .backend == "lvmthin"
     then (.nativeIdentity | type == "string" and test("^[A-Za-z0-9-]+$"))
     else (.nativeIdentity | type == "string" and test("^[0-9]+:[0-9]+$"))
     end) and
    (.sha256 | type == "string" and test("^[a-f0-9]{64}$")) and
    (.logicalSizeBytes | type == "number" and floor == . and . > 0) and
    (.volumeId | type == "string"))) and
  .disks.scsi0.volumeId == $scsi0_volume and
  .disks.efidisk0.volumeId == $efidisk0_volume and
  .disks.scsi0.sha256 != .disks.efidisk0.sha256'
# shellcheck disable=SC2016
readonly BASE_TEMPLATE_PENDING_CONFIG_JQ='
  (.data | type == "array") and
  (.data | length) > 0 and
  all(.data[];
    type == "object" and
    ((has("pending") or has("delete")) | not) and
    ((keys | sort) == ["key", "value"]) and
    ((.key | type) == "string") and
    (.key | length) > 0 and
    ((.value | type) as $valueType |
      (["boolean", "number", "string"] | index($valueType)) != null)
  ) and
  ([.data[].key] | length) == ([.data[].key] | unique | length)'
# shellcheck disable=SC2016
readonly BASE_TEMPLATE_CONFIG_INVENTORY_JQ='
  (.data | keys) as $actualKeys |
  ((($required_config_keys + $api_metadata_keys) - $actualKeys) | length) == 0 and
  (($actualKeys - (
    $required_config_keys +
    $optional_config_keys +
    $api_metadata_keys
  )) | length) == 0 and
  (($forbidden_config_keys - ($forbidden_config_keys - $actualKeys)) | length) == 0'
# shellcheck disable=SC2016
readonly BASE_TEMPLATE_APPROVED_CONFIG_VALUES_JQ='
  ($vmid | tostring) as $vmidString |
  (((try ((.data.efidisk0 // "") | split(",")) catch []) // [])) as $efiDisk |
  (((try ($efiDisk[0] |
    capture("^(?<storage>[A-Za-z0-9][A-Za-z0-9._-]*):(?<volume>.+)$")
  ) catch null) // null)) as $efiVolume |
  ($efiDisk[1:] | sort) as $efiOptions |
  (((try ((.data.net0 // "") | split(",")) catch []) // [])) as $networkOptions |
  ($networkOptions |
    map(select(test("^virtio=[0-9A-Fa-f][02468AaCcEe](?::[0-9A-Fa-f]{2}){5}$")))
  ) as $networkMacOptions |
  (($networkMacOptions[0] // "") | sub("^virtio="; "") | ascii_downcase) as $networkMac |
  (((try ((.data.meta // "") | split(",")) catch []) // [])) as $metaOptions |
  (((try ((.data.scsi0 // "") | split(",")) catch []) // [])) as $scsiDisk |
  (((try ($scsiDisk[0] |
    capture("^(?<storage>[A-Za-z0-9][A-Za-z0-9._-]*):(?<volume>.+)$")
  ) catch null) // null)) as $scsiVolume |
  (((try ((.data.smbios1 // "") |
    capture("^uuid=(?<uuid>[a-f0-9]{8}-[a-f0-9]{4}-[14][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12})$").uuid
  ) catch null) // null)) as $smbiosUuid |
  (((try ((.data.vmgenid // "") |
    capture("^(?<uuid>[a-f0-9]{8}-[a-f0-9]{4}-[14][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12})$").uuid
  ) catch null) // null)) as $vmGenerationId |
  (((try ((.data.agent // "") | split(",") | sort) catch []) // []) ==
    ["enabled=1", "fstrim_cloned_disks=1"]) and
  ((.data | has("arch") | not) or .data.arch == "x86_64") and
  .data.balloon == 0 and
  .data.bios == "ovmf" and
  .data.boot == "order=scsi0" and
  .data.cores == 4 and
  (.data.cpu == "x86-64-v2-AES" or .data.cpu == "cputype=x86-64-v2-AES") and
  .data.description == ("Nelos validator base; Ubuntu 24.04 release-20260801; ubuntu-sha256:" + $digest) and
  (((try ((.data.digest // "") | test("^[a-f0-9]{40}$")) catch false) // false)) and
  (($efiVolume.volume // "") | test("^base-" + $vmidString + "-disk-0$")) and
  (
    $efiOptions == ["efitype=4m", "pre-enrolled-keys=0", "size=528K"] or
    $efiOptions == ["efitype=4m", "pre-enrolled-keys=0", "size=1M"] or
    $efiOptions == ["efitype=4m", "pre-enrolled-keys=0", "size=4M"]
  ) and
  .data.machine == "q35" and
  .data.memory == 8192 and
  ($metaOptions | length) == 2 and
  (($metaOptions | map(select(test("^creation-qemu=[0-9]+(?:[.][0-9]+)+$")))) | length) == 1 and
  (($metaOptions | map(select(test("^ctime=[0-9]+$")))) | length) == 1 and
  .data.name == $name and
  ($networkOptions | length) == 4 and
  ($networkMacOptions | length) == 1 and
  $networkMac != "00:00:00:00:00:00" and
  (($networkOptions | map(select(. == "bridge=vmbr0"))) == ["bridge=vmbr0"]) and
  (($networkOptions | map(select(. == "firewall=1"))) == ["firewall=1"]) and
  (($networkOptions | map(select(. == "queues=4"))) == ["queues=4"]) and
  ((.data | has("onboot") | not) or .data.onboot == 0) and
  .data.ostype == "l26" and
  (
    (
      $scsiVolume.storage == $efiVolume.storage and
      (($scsiVolume.volume // "") | test("^base-" + $vmidString + "-disk-1$"))
    ) or
    (
      $scsiVolume.storage != $efiVolume.storage and
      (($scsiVolume.volume // "") | test("^base-" + $vmidString + "-disk-0$"))
    )
  ) and
  (($scsiDisk[1:] | sort) == ["discard=on", "iothread=1", "size=64G", "ssd=1"]) and
  .data.scsihw == "virtio-scsi-single" and
  $smbiosUuid != null and
  $smbiosUuid != "00000000-0000-0000-0000-000000000000" and
  .data.serial0 == "socket" and
  .data.sockets == 1 and
  (((try ((.data.tags // "") | split(";") | sort) catch []) // []) ==
    ["nelos-validator-base", "ubuntu-24-04", "ubuntu-release-20260801"]) and
  .data.template == 1 and
  .data.vga == "serial0" and
  $vmGenerationId != null and
  $vmGenerationId != "00000000-0000-0000-0000-000000000000" and
  $vmGenerationId != $smbiosUuid'
# shellcheck disable=SC2016
readonly BASE_TEMPLATE_CLOUD_INIT_CONFIG_JQ='
  .data.citype == "nocloud" and
  .data.ciuser == "ubuntu" and
  .data.ciupgrade == 0 and
  .data.ipconfig0 == "ip=dhcp" and
  ([.data | keys[] |
    select(
      . == "cicustom" or
      . == "cipassword" or
      . == "nameserver" or
      . == "searchdomain" or
      . == "sshkeys"
    )
  ] | length) == 0'
# shellcheck disable=SC2016
readonly BASE_CLOUD_INIT_DEVICE_JQ='
  (((try ((.data.ide2 // "") | split(",")) catch []) // [])) as $cloudInit |
  ($vmid | tostring) as $vmidString |
  (((try ($cloudInit[0] |
    capture("^(?<storage>[A-Za-z0-9][A-Za-z0-9._-]*):(?<volume>.+)$")
  ) catch null) // null)) as $cloudInitVolume |
  (
    ($cloudInitVolume.volume // "") == ("vm-" + $vmidString + "-cloudinit") or
    ($cloudInitVolume.volume // "") == ($vmidString + "/vm-" + $vmidString + "-cloudinit.qcow2")
  ) and
  (
    (($cloudInit[1:] | sort) == ["media=cdrom"]) or
    (($cloudInit[1:] | sort) == ["media=cdrom", "size=4M"])
  )'
# shellcheck disable=SC2016
readonly CLOUD_INIT_STORAGE_VOLUME_JQ='
  .data.type as $storageType |
  ($base_vmid | tostring) as $vmidString |
  if $storageType == "dir" then
    $cloud_init_volume == ($vmidString + "/vm-" + $vmidString + "-cloudinit.qcow2")
  elif (($block_storage_types | split(",") | index($storageType)) != null) then
    $cloud_init_volume == ("vm-" + $vmidString + "-cloudinit")
  else
    false
  end'

assert_api_storage() {
  local storage="$1"
  local allowed_types_csv="$2"
  local role="$3"
  local cloud_init_volume="${4:-}"
  local config_response status_response

  config_response="$(api_get "storage/${storage}")" || die "could not query ${role} storage configuration"
  jq -e \
    --arg node "$PROXMOX_NODE" \
    --arg allowed_storage_types "$allowed_types_csv" \
    '.data.type as $storageType |
     (($allowed_storage_types | split(",") | index($storageType)) != null) and
     ((.data.shared // 0) == 0) and
     ((.data.content // "") | split(",") | index("images") != null) and
     ((.data.nodes // $node) | split(",") | index($node) != null)' \
    <<<"$config_response" >/dev/null || \
    die "${role} storage type, node-local scope, image content, or node restriction does not match"
  if [[ -n $cloud_init_volume ]]; then
    jq -e \
      --arg cloud_init_volume "$cloud_init_volume" \
      --arg block_storage_types "$BLOCK_CLOUD_INIT_STORAGE_TYPES_CSV" \
      --argjson base_vmid "$BASE_TEMPLATE_VMID" \
      "$CLOUD_INIT_STORAGE_VOLUME_JQ" \
      <<<"$config_response" >/dev/null || \
      die "${role} volume name does not match the base VMID and storage backend"
  fi
  status_response="$(api_get "nodes/${PROXMOX_NODE}/storage/${storage}/status")" || \
    die "could not query ${role} node storage status"
  jq -e '.data.active == 1 and .data.enabled == 1' <<<"$status_response" >/dev/null || \
    die "${role} storage must report active=1 and enabled=1 for the selected node"
}

jq -e \
  --argjson vmid "$BASE_TEMPLATE_VMID" \
  --arg name "$BASE_TEMPLATE_NAME" \
  --arg node "$PROXMOX_NODE" \
  'any(.data[];
    .vmid == $vmid and
    .name == $name and
    .template == 1 and
    .node == $node and
    (((.tags // "") | split(";")) | index("nelos-validator-base") != null) and
    (((.tags // "") | split(";")) | index("ubuntu-release-20260801") != null)
  )' <<<"$resources_response" >/dev/null || die "base VMID, name, node, template state, or ownership tag does not match"

base_config_response="$(api_get "nodes/${PROXMOX_NODE}/qemu/${BASE_TEMPLATE_VMID}/config?current=1")" || die "could not query current base template configuration"
base_pending_response="$(api_get "nodes/${PROXMOX_NODE}/qemu/${BASE_TEMPLATE_VMID}/pending")" || die "could not query pending base template configuration"
jq -e \
  "$BASE_TEMPLATE_PENDING_CONFIG_JQ" \
  <<<"$base_pending_response" >/dev/null || \
  die "base template must not have pending configuration changes"
jq -e \
  --argjson required_config_keys "$BASE_TEMPLATE_REQUIRED_CONFIG_KEYS_JSON" \
  --argjson optional_config_keys "$BASE_TEMPLATE_OPTIONAL_CONFIG_KEYS_JSON" \
  --argjson api_metadata_keys "$BASE_TEMPLATE_API_METADATA_KEYS_JSON" \
  --argjson forbidden_config_keys "$BASE_TEMPLATE_FORBIDDEN_CONFIG_KEYS_JSON" \
  "$BASE_TEMPLATE_CONFIG_INVENTORY_JQ" \
  <<<"$base_config_response" >/dev/null || \
  die "base template current configuration key inventory does not match"
jq -e \
  --arg digest "$UBUNTU_IMAGE_SHA256" \
  --arg name "$BASE_TEMPLATE_NAME" \
  --argjson vmid "$BASE_TEMPLATE_VMID" \
  "$BASE_TEMPLATE_APPROVED_CONFIG_VALUES_JQ" \
  <<<"$base_config_response" >/dev/null || \
  die "base template approved configuration values do not match"
jq -e \
  "$BASE_TEMPLATE_CLOUD_INIT_CONFIG_JQ" \
  <<<"$base_config_response" >/dev/null || \
  die "base template Cloud-Init configuration does not match"
jq -e \
  --argjson vmid "$BASE_TEMPLATE_VMID" \
  "$BASE_CLOUD_INIT_DEVICE_JQ" \
  <<<"$base_config_response" >/dev/null || \
  die "base template Cloud-Init device contract does not match"
base_config_digest="$(jq -er '.data.digest | select(test("^[a-f0-9]{40}$"))' <<<"$base_config_response")" || \
  die "base template configuration digest is missing or malformed"
base_scsi0_volume="$(jq -er '.data.scsi0 | split(",")[0]' <<<"$base_config_response")" || \
  die "could not identify the base scsi0 volume"
base_efidisk0_volume="$(jq -er '.data.efidisk0 | split(",")[0]' <<<"$base_config_response")" || \
  die "could not identify the base efidisk0 volume"
readonly base_config_digest base_scsi0_volume base_efidisk0_volume
[[ $base_scsi0_volume != "$base_efidisk0_volume" ]] || die "base persistent disk volume IDs must be distinct"
jq -e \
  --arg node "$PROXMOX_NODE" \
  --argjson vmid "$BASE_TEMPLATE_VMID" \
  --arg name "$BASE_TEMPLATE_NAME" \
  --arg digest "$base_config_digest" \
  --arg ubuntu_sha "$UBUNTU_IMAGE_SHA256" \
  --arg scsi0_volume "$base_scsi0_volume" \
  --arg efidisk0_volume "$base_efidisk0_volume" \
  "$TRUSTED_BASELINE_JQ" \
  <<<"$BASE_ATTESTATION_BASELINE_JSON" >/dev/null || \
  die "trusted base disk baseline receipt does not match the locked bootstrap or current template"
persistent_storage_inventory="$(jq -er '
  [.data.scsi0, .data.efidisk0] |
  map(capture("^(?<storage>[A-Za-z0-9][A-Za-z0-9._-]*):").storage) |
  unique[]
' <<<"$base_config_response")" || die "could not identify every inherited persistent disk storage"
mapfile -t persistent_disk_storages <<<"$persistent_storage_inventory"
readonly -a persistent_disk_storages
[[ ${#persistent_disk_storages[@]} -ge 1 ]] || die "base template has no inherited persistent disk storage"
inherited_cloud_init_inventory="$(jq -er '
  .data.ide2 | split(",")[0] |
  capture("^(?<storage>[A-Za-z0-9][A-Za-z0-9._-]*):(?<volume>.+)$") |
  [.storage, .volume] | @tsv
' <<<"$base_config_response")" || die "could not identify the inherited Cloud-Init volume"
IFS=$'\t' read -r inherited_cloud_init_storage inherited_cloud_init_volume <<<"$inherited_cloud_init_inventory"
readonly inherited_cloud_init_storage inherited_cloud_init_volume
[[ -n $inherited_cloud_init_storage && -n $inherited_cloud_init_volume ]] || \
  die "could not identify the inherited Cloud-Init volume"
for persistent_disk_storage in "${persistent_disk_storages[@]}"; do
  assert_api_storage "$persistent_disk_storage" "$LINKED_CLONE_STORAGE_TYPES_CSV" "inherited persistent disk"
done
assert_api_storage \
  "$inherited_cloud_init_storage" \
  "$FULL_COPY_STORAGE_TYPES_CSV" \
  "inherited Cloud-Init" \
  "$inherited_cloud_init_volume"

if jq -e \
  --argjson vmid "$OUTPUT_TEMPLATE_VMID" \
  --arg name "$OUTPUT_TEMPLATE_NAME" \
  'any(.data[]; .vmid == $vmid or .name == $name)' \
  <<<"$resources_response" >/dev/null; then
  die "refusing to overwrite an existing VM/template ID or name"
fi

assert_api_storage "$CLOUD_INIT_STORAGE" "$FULL_COPY_STORAGE_TYPES_CSV" "final Cloud-Init"

build_nonce="$(< /proc/sys/kernel/random/uuid)"
readonly build_nonce
[[ ${build_nonce} =~ ^[a-f0-9-]{36}$ ]] || die "could not generate a build nonce"

readonly sealed_var_file="${RUN_ROOT}/sealed.pkrvars.json"
jq -n \
  --arg proxmox_node "$PROXMOX_NODE" \
  --arg proxmox_pool "$PROXMOX_POOL" \
  --argjson base_template_vmid "$BASE_TEMPLATE_VMID" \
  --arg base_template_name "$BASE_TEMPLATE_NAME" \
  --argjson output_template_vmid "$OUTPUT_TEMPLATE_VMID" \
  --arg output_template_name "$OUTPUT_TEMPLATE_NAME" \
  --arg cloud_init_storage "$CLOUD_INIT_STORAGE" \
  --arg build_nonce "$build_nonce" \
  '{
    proxmox_node: $proxmox_node,
    proxmox_pool: $proxmox_pool,
    base_template_vmid: $base_template_vmid,
    base_template_name: $base_template_name,
    output_template_vmid: $output_template_vmid,
    output_template_name: $output_template_name,
    cloud_init_storage: $cloud_init_storage,
    build_nonce: $build_nonce
  }' >"$sealed_var_file"
chmod 0600 "$sealed_var_file"

unset \
  PKR_VAR_proxmox_node \
  PKR_VAR_proxmox_pool \
  PKR_VAR_base_template_vmid \
  PKR_VAR_base_template_name \
  PKR_VAR_output_template_vmid \
  PKR_VAR_output_template_name \
  PKR_VAR_cloud_init_storage

without_proxmox_auth "$PACKER_BIN" fmt -check "$SEALED_PACKER_DIR"
env \
  PROXMOX_URL="https://proxmox.invalid:8006/api2/json" \
  PROXMOX_USERNAME="validator@pve!synthetic" \
  PROXMOX_TOKEN="synthetic" \
  HTTP_PROXY="$OFFLINE_PROXY" \
  HTTPS_PROXY="$OFFLINE_PROXY" \
  ALL_PROXY="$OFFLINE_PROXY" \
  NO_PROXY= \
  http_proxy="$OFFLINE_PROXY" \
  https_proxy="$OFFLINE_PROXY" \
  all_proxy="$OFFLINE_PROXY" \
  no_proxy= \
  "$PACKER_BIN" validate -var-file="$sealed_var_file" "$SEALED_PACKER_DIR"

base_attestation_nonce="build-${build_nonce//-/}"
readonly base_attestation_nonce
run_base_disk_attestation "$base_attestation_nonce"

printf 'starting source %s with ownership tag nelos-build-%s\n' "$SOURCE_REVISION" "${build_nonce:0:12}"

# Packer cleanup is intentionally disabled. A failed build remains tagged with
# its unique build nonce for explicit inventory reconciliation by an operator.
"$PACKER_BIN" build -on-error=abort -var-file="$sealed_var_file" "$SEALED_PACKER_DIR"
