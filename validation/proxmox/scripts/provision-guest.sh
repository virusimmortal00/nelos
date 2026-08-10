#!/usr/bin/env bash
set -Eeuo pipefail

readonly UBUNTU_APT_SNAPSHOT="20260801T120000Z"

die() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || die "required command not found: $1"
}

assert_build_guest() {
  local marker="/run/nelos-packer-build/authorized"

  [[ ${NELOS_PACKER_BUILD_NONCE:-} =~ ^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$ ]] || \
    die "a valid Packer build nonce is required"
  [[ -f $marker && ! -L $marker ]] || die "Packer guest authorization marker is missing"
  [[ $(<"$marker") == "$NELOS_PACKER_BUILD_NONCE" ]] || die "Packer guest authorization marker does not match"
  [[ -r /etc/os-release ]] || die "guest operating-system identity is unavailable"
  # shellcheck disable=SC1091
  source /etc/os-release
  [[ ${ID:-} == "ubuntu" && ${VERSION_ID:-} == "24.04" ]] || die "guest must be Ubuntu 24.04"
  [[ $(uname -m) == "x86_64" ]] || die "guest must be x86_64"
  [[ $(systemd-detect-virt --vm) == "kvm" ]] || die "guest must be a KVM virtual machine"
}

download_verified() {
  local url="$1"
  local sha256="$2"
  local destination="$3"

  [[ $url == https://* ]] || die "artifact URL must use HTTPS: ${url}"
  [[ $sha256 =~ ^[0-9a-f]{64}$ ]] || die "artifact has an invalid SHA-256: ${url}"
  curl --disable --fail --silent --show-error --location \
    --proto '=https' --proto-redir '=https' --tlsv1.2 --retry 3 \
    --output "$destination" "$url"
  printf '%s  %s\n' "$sha256" "$destination" | sha256sum --check --status || die "artifact failed SHA-256 verification: ${url}"
}

safe_file_name() {
  local file_name="$1"
  [[ -n $file_name && $file_name != */* && $file_name != *..* ]] || die "unsafe artifact fileName in toolchain lock: ${file_name}"
}

install_codex_lane() {
  local artifact_key="$1"
  local version lane_id url sha256 file_name archive lane_root manifest entrypoint wrapper
  local -a candidates

  version="$(jq -er --arg key "$artifact_key" '.artifacts[$key].version' "$TOOLCHAIN_LOCK")"
  lane_id="$(jq -er --arg key "$artifact_key" '.artifacts[$key].laneId' "$TOOLCHAIN_LOCK")"
  url="$(jq -er --arg key "$artifact_key" '.artifacts[$key].url' "$TOOLCHAIN_LOCK")"
  sha256="$(jq -er --arg key "$artifact_key" '.artifacts[$key].sha256' "$TOOLCHAIN_LOCK")"
  file_name="$(jq -er --arg key "$artifact_key" '.artifacts[$key].fileName' "$TOOLCHAIN_LOCK")"
  safe_file_name "$file_name"
  [[ $lane_id =~ ^[a-z0-9][a-z0-9-]*$ ]] || die "unsafe laneId in toolchain lock: ${lane_id}"

  archive="${DOWNLOAD_DIR}/${lane_id}-${file_name}"
  lane_root="${INSTALL_ROOT}/lanes/${lane_id}"
  [[ ! -e $lane_root ]] || die "refusing to overwrite Codex lane: ${lane_root}"

  download_verified "$url" "$sha256" "$archive"
  install -d -m 0755 "$lane_root"
  tar -xzf "$archive" -C "$lane_root" --no-same-owner --no-same-permissions

  manifest="${lane_root}/codex-package.json"
  [[ -f $manifest ]] || die "Codex lane is missing codex-package.json: ${lane_id}"
  jq -e --arg version "$version" '
    .layoutVersion == 1 and
    .version == $version and
    .target == "x86_64-unknown-linux-musl" and
    .variant == "codex" and
    (.entrypoint | type == "string")
  ' "$manifest" >/dev/null || die "Codex package manifest does not match lock: ${lane_id}"

  entrypoint="$(jq -er '.entrypoint' "$manifest")"
  [[ $entrypoint != /* && $entrypoint != *..* ]] || die "unsafe Codex entrypoint: ${entrypoint}"
  mapfile -t candidates < <(find "$lane_root" -type f -path '*/bin/codex' -print)
  ((${#candidates[@]} == 1)) || die "expected exactly one Codex executable candidate in lane ${lane_id}"
  [[ ${candidates[0]} == "${lane_root}/${entrypoint}" ]] || die "Codex manifest entrypoint does not match extracted executable: ${lane_id}"
  chmod 0755 "${candidates[0]}"

  wrapper="/usr/local/bin/codex-${lane_id}"
  [[ ! -e $wrapper && ! -L $wrapper ]] || die "refusing to overwrite existing wrapper: ${wrapper}"
  ln -s "${candidates[0]}" "$wrapper"
  "$wrapper" --version | grep -F "$version" >/dev/null || die "Codex lane version check failed: ${lane_id}"
}

[[ ${EUID} -eq 0 ]] || die "guest provisioning must run as root"
: "${TOOLCHAIN_LOCK:?TOOLCHAIN_LOCK is required}"
: "${CLOUD_INIT_POLICY:?CLOUD_INIT_POLICY is required}"
[[ -f $TOOLCHAIN_LOCK ]] || die "toolchain lock not found: ${TOOLCHAIN_LOCK}"
[[ -f $CLOUD_INIT_POLICY ]] || die "Cloud-Init policy not found: ${CLOUD_INIT_POLICY}"
require_command systemd-detect-virt
assert_build_guest

export DEBIAN_FRONTEND=noninteractive
apt-get \
  --error-on=any \
  -o DPkg::Lock::Timeout=300 \
  -o Acquire::Retries=3 \
  -o APT::Snapshot="$UBUNTU_APT_SNAPSHOT" \
  update
apt-get \
  -o DPkg::Lock::Timeout=300 \
  -o Acquire::Retries=3 \
  -o APT::Snapshot="$UBUNTU_APT_SNAPSHOT" \
  install -y --no-install-recommends \
  ca-certificates \
  curl \
  git \
  jq \
  qemu-guest-agent \
  xz-utils

for command in curl find grep install jq sha256sum tar; do
  require_command "$command"
done

jq -e '
  .schemaVersion == 1 and
  .platform.operatingSystem == "linux" and
  .platform.distribution == "ubuntu" and
  .platform.architecture == "x86_64" and
  .policy.allowFloatingVersions == false and
  .policy.requireSha256 == true and
  .policy.ubuntuAptSnapshot == "20260801T120000Z" and
  .policy.buildNetwork == {
    mode: "preconfigured-restricted-vnet",
    bridge: "nelosbld",
    dhcpSource: "restricted-vnet",
    defaultEgressPolicy: "deny",
    dnsPolicy: "restricted-host-allowlist-only",
    allowedTcpPorts: [443],
    allowedGuestHosts: [
      "github.com",
      "nodejs.org",
      "release-assets.githubusercontent.com",
      "snapshot.ubuntu.com"
    ]
  } and
  .policy.validationNetwork == "denied" and
  (.artifacts.node | type == "object") and
  (.artifacts.codexLegacy | type == "object") and
  (.artifacts.codexAgentPlugin | type == "object")
' "$TOOLCHAIN_LOCK" >/dev/null || die "unsupported or incomplete toolchain lock"

readonly INSTALL_ROOT="/opt/nelos-validator"
readonly DOWNLOAD_DIR="/var/tmp/nelos-validator-downloads"
install -d -m 0755 "$INSTALL_ROOT" "${INSTALL_ROOT}/lanes"
install -d -m 0700 "$DOWNLOAD_DIR"
install -m 0444 "$TOOLCHAIN_LOCK" "${INSTALL_ROOT}/toolchain.lock.json"
install -m 0644 "$CLOUD_INIT_POLICY" /etc/cloud/cloud.cfg.d/99-nelos-validator.cfg

node_version="$(jq -er '.artifacts.node.version' "$TOOLCHAIN_LOCK")"
node_url="$(jq -er '.artifacts.node.url' "$TOOLCHAIN_LOCK")"
node_sha256="$(jq -er '.artifacts.node.sha256' "$TOOLCHAIN_LOCK")"
node_file_name="$(jq -er '.artifacts.node.fileName' "$TOOLCHAIN_LOCK")"
safe_file_name "$node_file_name"

node_archive="${DOWNLOAD_DIR}/${node_file_name}"
node_root="${INSTALL_ROOT}/node/${node_version}"
[[ ! -e $node_root ]] || die "refusing to overwrite Node installation: ${node_root}"
download_verified "$node_url" "$node_sha256" "$node_archive"
install -d -m 0755 "$node_root"
tar -xJf "$node_archive" -C "$node_root" --strip-components=1 --no-same-owner --no-same-permissions
[[ -x ${node_root}/bin/node ]] || die "Node archive did not contain bin/node"
[[ $("${node_root}/bin/node" --version) == "v${node_version}" ]] || die "Node version check failed"

for binary in node npm npx corepack; do
  target="/usr/local/bin/${binary}"
  [[ ! -e $target && ! -L $target ]] || die "refusing to overwrite existing command: ${target}"
  ln -s "${node_root}/bin/${binary}" "$target"
done

install_codex_lane codexLegacy
install_codex_lane codexAgentPlugin

systemctl enable qemu-guest-agent.service
cloud-init schema --system >/dev/null

rm -f "${DOWNLOAD_DIR:?}"/*
rmdir "$DOWNLOAD_DIR"
mv /run/nelos-packer-build/authorized /run/nelos-packer-build/provisioned
