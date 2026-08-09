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
  PKR_VAR_proxmox_node \
  PKR_VAR_base_template_vmid \
  PKR_VAR_base_template_name \
  PKR_VAR_output_template_vmid \
  PKR_VAR_output_template_name \
  PKR_VAR_cloud_init_storage; do
  require_env "$name"
done

for command in awk chmod curl dirname env find git grep id install jq mktemp node realpath rm sha256sum sort stat uname unzip; do
  require_command "$command"
done

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

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
readonly SCRIPT_DIR
PACKER_DIR="$(realpath -m -- "${SCRIPT_DIR}/../packer")"
REPOSITORY_ROOT="$(realpath -m -- "${SCRIPT_DIR}/../../..")"
readonly PACKER_DIR REPOSITORY_ROOT
readonly TOOLCHAIN_LOCK="${REPOSITORY_ROOT}/validation/proxmox/toolchain.lock.json"

git_readonly() {
  env -i PATH="$PATH" LC_ALL=C git -C "$REPOSITORY_ROOT" "$@"
}

repository_top="$(git_readonly rev-parse --show-toplevel 2>/dev/null)" || die "source checkout is not a Git worktree"
[[ $(realpath -e -- "$repository_top") == "$REPOSITORY_ROOT" ]] || die "script path and Git worktree root do not match"
SOURCE_REVISION="$(git_readonly rev-parse --verify 'HEAD^{commit}')" || die "source checkout has no resolvable commit"
readonly SOURCE_REVISION
[[ ${SOURCE_REVISION} =~ ^[a-f0-9]{40}$|^[a-f0-9]{64}$ ]] || die "source revision is not a full Git object ID"
[[ -z $(git_readonly status --porcelain=v1 --untracked-files=all) ]] || die "source checkout must be clean, including untracked files"

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
  node "${REPOSITORY_ROOT}/validation/proxmox/scripts/validate-contract.mjs" >/dev/null || \
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
  local source_mode source_type source_object source_path

  read -r source_mode source_type source_object source_path < <(
    git_readonly ls-tree "$SOURCE_REVISION" -- "$repository_path"
  ) || die "sealed input is absent at source revision: ${repository_path}"
  [[ $source_type == "blob" && ($source_mode == "100644" || $source_mode == "100755") ]] || \
    die "sealed input is not a regular tracked file at source revision: ${repository_path}"
  [[ $source_path == "$repository_path" ]] || die "sealed input path did not resolve exactly: ${repository_path}"
  git_readonly cat-file blob "$source_object" >"$destination" || \
    die "could not materialize sealed input: ${repository_path}"
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
  printf 'header = "Authorization: PVEAPIToken=%s=%s"\n' "$PROXMOX_USERNAME" "$PROXMOX_TOKEN" |
    curl --disable --fail --silent --show-error --proto '=https' --tlsv1.2 \
      --config - "${API_ROOT}/${endpoint}"
}

version_response="$(api_get version)" || die "could not query Proxmox version"
jq -e '.data.version | startswith("8.4.")' <<<"$version_response" >/dev/null || die "target must run Proxmox VE 8.4"

resources_response="$(api_get 'cluster/resources?type=vm')" || die "could not query Proxmox VM inventory"
jq -e '.data | type == "array"' <<<"$resources_response" >/dev/null || die "unexpected Proxmox inventory response"

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

base_config_response="$(api_get "nodes/${PROXMOX_NODE}/qemu/${BASE_TEMPLATE_VMID}/config")" || die "could not query base template configuration"
jq -e \
  --arg digest "$UBUNTU_IMAGE_SHA256" \
  '(.data.scsi0 // "") as $disk |
   ($disk | split(",")) as $diskOptions |
   .data.machine == "q35" and
   .data.bios == "ovmf" and
   .data.scsihw == "virtio-scsi-single" and
   ((.data.agent // "") | contains("enabled=1")) and
   ((.data.description // "") | contains("ubuntu-sha256:" + $digest)) and
   ($disk | test("^[A-Za-z0-9][A-Za-z0-9._-]*:")) and
   (($diskOptions | map(select(startswith("size=")))) == ["size=64G"]) and
   (($diskOptions | map(select(startswith("discard=")))) == ["discard=on"]) and
   (($diskOptions | map(select(startswith("iothread=")))) == ["iothread=1"])' \
  <<<"$base_config_response" >/dev/null || \
  die "base template hardware, guest-agent, provenance, or inherited disk contract does not match"

base_disk_storage="$(jq -er '.data.scsi0 | capture("^(?<storage>[A-Za-z0-9][A-Za-z0-9._-]*):").storage' <<<"$base_config_response")"
base_storage_response="$(api_get "storage/${base_disk_storage}")" || die "could not query base disk storage configuration"
jq -e \
  --arg node "$PROXMOX_NODE" \
  '.data.shared != 1 and
   ((.data.content // "") | split(",") | index("images") != null) and
   ((.data.nodes // $node) | split(",") | index($node) != null)' \
  <<<"$base_storage_response" >/dev/null || die "base disk storage must be node-local, image-capable, and enabled for the selected node"

if jq -e \
  --argjson vmid "$OUTPUT_TEMPLATE_VMID" \
  --arg name "$OUTPUT_TEMPLATE_NAME" \
  'any(.data[]; .vmid == $vmid or .name == $name)' \
  <<<"$resources_response" >/dev/null; then
  die "refusing to overwrite an existing VM/template ID or name"
fi

storage_response="$(api_get "storage/${CLOUD_INIT_STORAGE}")" || die "could not query Cloud-Init storage configuration"
jq -e \
  --arg node "$PROXMOX_NODE" \
  '.data.shared != 1 and
   ((.data.content // "") | split(",") | index("images") != null) and
   ((.data.nodes // $node) | split(",") | index($node) != null)' \
  <<<"$storage_response" >/dev/null || die "Cloud-Init storage must be node-local, image-capable, and enabled for the selected node"

storage_status="$(api_get "nodes/${PROXMOX_NODE}/storage/${CLOUD_INIT_STORAGE}/status")" || die "could not query Cloud-Init storage status"
jq -e '.data.active == 1' <<<"$storage_status" >/dev/null || die "Cloud-Init storage is not active on the selected node"

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

printf 'starting source %s with ownership tag nelos-build-%s\n' "$SOURCE_REVISION" "${build_nonce:0:12}"

# Packer cleanup is intentionally disabled. A failed build remains tagged with
# its unique build nonce for explicit inventory reconciliation by an operator.
"$PACKER_BIN" build -on-error=abort -var-file="$sealed_var_file" "$SEALED_PACKER_DIR"
