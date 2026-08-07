#!/usr/bin/env bash
set -Eeuo pipefail
set +x

readonly UBUNTU_IMAGE_URL="https://cloud-images.ubuntu.com/releases/noble/release-20260801/ubuntu-24.04-server-cloudimg-amd64.img"
readonly UBUNTU_IMAGE_SHA256="0533b0655c32e68b31d792ecd6ccfca95abdbc536c4446874fe0513bd4140ffe"
readonly UBUNTU_IMAGE_NAME="ubuntu-24.04-server-cloudimg-amd64-release-20260801.img"

die() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

require_env() {
  local name="$1"
  [[ -n "${!name:-}" ]] || die "required environment variable ${name} is not set"
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || die "required command not found: $1"
}

storage_config() {
  local storage="$1"
  pvesh get "/storage/${storage}" --output-format json
}

assert_node_local_storage() {
  local storage="$1"
  local required_content="$2"
  local config

  config="$(storage_config "$storage")" || die "could not read storage configuration: ${storage}"
  printf '%s' "$config" | perl -MJSON::PP -0777 -e '
    my ($wanted_node, $wanted_content) = @ARGV;
    my $data = decode_json(<STDIN>);
    exit 1 if (($data->{shared} // 0) != 0);
    my %content = map { $_ => 1 } split /,/, ($data->{content} // q{});
    exit 1 unless $content{$wanted_content};
    if (defined $data->{nodes} && length $data->{nodes}) {
      my %nodes = map { $_ => 1 } split /,/, $data->{nodes};
      exit 1 unless $nodes{$wanted_node};
    }
  ' "$PROXMOX_NODE" "$required_content" || \
    die "storage ${storage} must be node-local, ${required_content}-capable, and enabled for ${PROXMOX_NODE}"
  pvesm status --storage "$storage" >/dev/null || die "storage is not active on this node: ${storage}"
}

guest_exec_checked() {
  local response
  response="$(qm guest exec "$BASE_TEMPLATE_VMID" --timeout 1800 -- "$@")" || \
    die "guest command could not be submitted: $1"
  printf '%s' "$response" | perl -MJSON::PP -0777 -e '
    my $data = decode_json(<STDIN>);
    exit((($data->{exited} // 0) == 1 && ($data->{exitcode} // 1) == 0) ? 0 : 1);
  ' || die "guest command failed: $1"
}

[[ ${EUID} -eq 0 ]] || die "run this bootstrap on the selected Proxmox node as root"
(($# == 0)) || die "arguments are disabled; use the documented environment variables"

for name in \
  PROXMOX_NODE \
  BASE_TEMPLATE_VMID \
  BASE_TEMPLATE_NAME \
  PVE_VM_STORAGE \
  PVE_EFI_STORAGE \
  PVE_CLOUD_INIT_STORAGE \
  PVE_SNIPPETS_STORAGE; do
  require_env "$name"
done

for command in awk basename curl date dirname install mktemp perl pvesh pvesm pveversion qm readlink sha256sum sleep stat uname; do
  require_command "$command"
done

readonly IMAGE_CACHE_DIR="${IMAGE_CACHE_DIR:-/var/tmp/nelos-validator-images}"
readonly IMAGE_PATH="${IMAGE_CACHE_DIR}/${UBUNTU_IMAGE_NAME}"
BOOTSTRAP_TAG="nelos-bootstrap-${BASE_TEMPLATE_VMID}-$(date +%s)-${RANDOM}"
readonly BOOTSTRAP_TAG
readonly BASE_TEMPLATE_TAGS="nelos-validator-base;ubuntu-24-04;ubuntu-release-20260801"
readonly BASE_TEMPLATE_DESCRIPTION="Nelos validator base; Ubuntu 24.04 release-20260801; ubuntu-sha256:${UBUNTU_IMAGE_SHA256}"

[[ ${BASE_TEMPLATE_VMID} =~ ^[0-9]+$ ]] || die "BASE_TEMPLATE_VMID must be an integer"
((BASE_TEMPLATE_VMID >= 100 && BASE_TEMPLATE_VMID <= 999999999)) || die "BASE_TEMPLATE_VMID must be between 100 and 999999999"
[[ ${PROXMOX_NODE} =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]] || die "PROXMOX_NODE is unsafe"
[[ ${BASE_TEMPLATE_NAME} =~ ^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?$ ]] || die "BASE_TEMPLATE_NAME must be a DNS-safe single label"
for storage in "$PVE_VM_STORAGE" "$PVE_EFI_STORAGE" "$PVE_CLOUD_INIT_STORAGE" "$PVE_SNIPPETS_STORAGE"; do
  [[ ${storage} =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]] || die "unsafe storage ID: ${storage}"
done

[[ -L /etc/pve/local ]] || die "local Proxmox node identity is unavailable"
local_node="$(basename "$(readlink -f /etc/pve/local)")"
[[ ${PROXMOX_NODE} == "$local_node" ]] || die "run on node ${PROXMOX_NODE}; current Proxmox node is ${local_node}"
[[ $(uname -m) == "x86_64" ]] || die "the Ubuntu amd64 template requires an x86_64 Proxmox node"

pve_release="$(pveversion | awk 'NR == 1 { print; exit }')"
[[ ${pve_release} =~ ^pve-manager/8\.4\. ]] || die "expected Proxmox VE 8.4, found ${pve_release}"

assert_node_local_storage "$PVE_VM_STORAGE" images
assert_node_local_storage "$PVE_EFI_STORAGE" images
assert_node_local_storage "$PVE_CLOUD_INIT_STORAGE" images
assert_node_local_storage "$PVE_SNIPPETS_STORAGE" snippets

cluster_resources="$(pvesh get /cluster/resources --type vm --output-format json)" || die "could not query cluster VM inventory"
if printf '%s' "$cluster_resources" | perl -MJSON::PP -0777 -e '
  my ($wanted_id, $wanted_name) = @ARGV;
  my $resources = decode_json(<STDIN>);
  for my $resource (@{$resources}) {
    exit 0 if (($resource->{vmid} // q{}) eq $wanted_id || ($resource->{name} // q{}) eq $wanted_name);
  }
  exit 1;
' "$BASE_TEMPLATE_VMID" "$BASE_TEMPLATE_NAME"; then
  die "refusing to overwrite an existing VM/template ID or name"
fi

snippet_storage_config="$(storage_config "$PVE_SNIPPETS_STORAGE")" || die "could not read snippets storage configuration"
snippet_root="$(printf '%s' "$snippet_storage_config" | perl -MJSON::PP -0777 -e '
  my $data = decode_json(<STDIN>);
  exit 1 unless (($data->{type} // q{}) eq q{dir});
  my $path = $data->{path} // q{};
  exit 1 unless ($path =~ m{^/} && $path ne q{/});
  print $path;
')" || die "bootstrap currently requires node-local dir storage for snippets"
readonly SNIPPET_DIR="${snippet_root}/snippets"
readonly SNIPPET_NAME="${BOOTSTRAP_TAG}.yaml"
readonly SNIPPET_VOLUME="${PVE_SNIPPETS_STORAGE}:snippets/${SNIPPET_NAME}"
readonly SNIPPET_PATH="${SNIPPET_DIR}/${SNIPPET_NAME}"

partial_path=""
snippet_created=0
created_vmid=0
cleanup_on_exit() {
  local status=$?

  if [[ -n $partial_path ]]; then
    rm -f -- "$partial_path"
  fi
  if ((snippet_created == 1)); then
    rm -f -- "$SNIPPET_PATH"
  fi

  if ((status != 0 && created_vmid == 1)); then
    local current_config current_name current_tags current_status
    if current_config="$(qm config "$BASE_TEMPLATE_VMID" 2>/dev/null)"; then
      current_name="$(awk -F': ' '$1 == "name" { print $2; exit }' <<<"$current_config")"
      current_tags="$(awk -F': ' '$1 == "tags" { print $2; exit }' <<<"$current_config")"
      if [[ $current_name == "$BASE_TEMPLATE_NAME" && ";${current_tags};" == *";${BOOTSTRAP_TAG};"* ]]; then
        current_status="$(qm status "$BASE_TEMPLATE_VMID" 2>/dev/null || true)"
        if [[ $current_status == "status: running" ]] && ! qm stop "$BASE_TEMPLATE_VMID" >/dev/null; then
          printf 'leaving incomplete VMID %s for operator review: stop failed\n' "$BASE_TEMPLATE_VMID" >&2
        elif ! qm destroy "$BASE_TEMPLATE_VMID" >/dev/null; then
          printf 'leaving incomplete VMID %s for operator review: destroy failed\n' "$BASE_TEMPLATE_VMID" >&2
        else
          printf 'removed verified incomplete VMID %s\n' "$BASE_TEMPLATE_VMID" >&2
        fi
      else
        printf 'leaving incomplete VMID %s for operator review: ownership check failed\n' "$BASE_TEMPLATE_VMID" >&2
      fi
    else
      printf 'leaving incomplete VMID %s for operator review: configuration could not be read\n' "$BASE_TEMPLATE_VMID" >&2
    fi
  fi
  exit "$status"
}
trap cleanup_on_exit EXIT

[[ $IMAGE_CACHE_DIR == /* && $IMAGE_CACHE_DIR != / && ! -L $IMAGE_CACHE_DIR ]] || \
  die "IMAGE_CACHE_DIR must be a specific absolute non-symlink directory"
if [[ -e $IMAGE_CACHE_DIR ]]; then
  [[ -d $IMAGE_CACHE_DIR ]] || die "IMAGE_CACHE_DIR exists but is not a directory"
else
  install -d -m 0755 "$IMAGE_CACHE_DIR"
fi
[[ $(stat -c '%u' "$IMAGE_CACHE_DIR") == "0" ]] || die "IMAGE_CACHE_DIR must be owned by root"
cache_mode="$(stat -c '%a' "$IMAGE_CACHE_DIR")"
[[ $cache_mode == "700" || $cache_mode == "750" || $cache_mode == "755" ]] || \
  die "IMAGE_CACHE_DIR must not be group- or world-writable"
[[ ! -L $IMAGE_PATH ]] || die "cached image path must not be a symbolic link"
if [[ -e "$IMAGE_PATH" ]]; then
  [[ -f $IMAGE_PATH ]] || die "cached image path must be a regular file"
  printf '%s  %s\n' "$UBUNTU_IMAGE_SHA256" "$IMAGE_PATH" | sha256sum --check --status || die "cached image exists with an unexpected digest: ${IMAGE_PATH}"
else
  partial_path="$(mktemp --tmpdir="$IMAGE_CACHE_DIR" "${UBUNTU_IMAGE_NAME}.partial.XXXXXXXXXX")"
  curl --disable --fail --silent --show-error --location \
    --proto '=https' --proto-redir '=https' --tlsv1.2 --retry 3 \
    --output "$partial_path" "$UBUNTU_IMAGE_URL" || \
    die "could not download the pinned Ubuntu image"
  printf '%s  %s\n' "$UBUNTU_IMAGE_SHA256" "$partial_path" | sha256sum --check --status || \
    die "downloaded Ubuntu image failed SHA-256 verification"
  if ! ln "$partial_path" "$IMAGE_PATH"; then
    [[ -f $IMAGE_PATH && ! -L $IMAGE_PATH ]] || die "could not place downloaded image in cache"
    printf '%s  %s\n' "$UBUNTU_IMAGE_SHA256" "$IMAGE_PATH" | sha256sum --check --status || \
      die "concurrent cached image has an unexpected digest"
  fi
  rm -f -- "$partial_path"
  partial_path=""
fi

install -d -m 0755 "$SNIPPET_DIR"
[[ -d $SNIPPET_DIR && ! -L $SNIPPET_DIR ]] || die "snippets directory must be a non-symlink directory"
[[ ! -e $SNIPPET_PATH && ! -L $SNIPPET_PATH ]] || die "refusing to overwrite an existing snippets file: ${SNIPPET_PATH}"
umask 077
printf '%s\n' \
  '#cloud-config' \
  'package_update: true' \
  'package_upgrade: false' \
  'packages:' \
  '  - qemu-guest-agent' \
  'runcmd:' \
  '  - [systemctl, enable, --now, qemu-guest-agent.service]' >"$SNIPPET_PATH"
chmod 0600 "$SNIPPET_PATH"
snippet_created=1

qm create "$BASE_TEMPLATE_VMID" \
  --name "$BASE_TEMPLATE_NAME" \
  --ostype l26 \
  --machine q35 \
  --bios ovmf \
  --cpu cputype=x86-64-v2-AES \
  --sockets 1 \
  --cores 4 \
  --memory 8192 \
  --balloon 0 \
  --description "$BASE_TEMPLATE_DESCRIPTION" \
  --tags "$BOOTSTRAP_TAG" \
  --scsihw virtio-scsi-single \
  --agent enabled=1,fstrim_cloned_disks=1 \
  --serial0 socket \
  --vga serial0 \
  --net0 'virtio,bridge=vmbr0,firewall=1,queues=4'
created_vmid=1

qm set "$BASE_TEMPLATE_VMID" --efidisk0 "${PVE_EFI_STORAGE}:1,efitype=4m,pre-enrolled-keys=0"
qm importdisk "$BASE_TEMPLATE_VMID" "$IMAGE_PATH" "$PVE_VM_STORAGE"

imported_volume="$(qm config "$BASE_TEMPLATE_VMID" | awk -F': ' '/^unused[0-9]+:/ { sub(/,.*/, "", $2); print $2; exit }')"
[[ -n "$imported_volume" ]] || die "could not identify the imported cloud-image volume"

qm set "$BASE_TEMPLATE_VMID" --scsi0 "${imported_volume},discard=on,iothread=1,ssd=1"
qm disk resize "$BASE_TEMPLATE_VMID" scsi0 64G
qm set "$BASE_TEMPLATE_VMID" --ide2 "${PVE_CLOUD_INIT_STORAGE}:cloudinit"
qm set "$BASE_TEMPLATE_VMID" --citype nocloud --ciuser ubuntu --ciupgrade 0 --ipconfig0 ip=dhcp
qm set "$BASE_TEMPLATE_VMID" --cicustom "user=${SNIPPET_VOLUME}"
qm set "$BASE_TEMPLATE_VMID" --boot order=scsi0

qm start "$BASE_TEMPLATE_VMID"
agent_ready=0
deadline=$((SECONDS + 1800))
while ((SECONDS < deadline)); do
  if qm guest cmd "$BASE_TEMPLATE_VMID" ping >/dev/null 2>&1; then
    agent_ready=1
    break
  fi
  [[ $(qm status "$BASE_TEMPLATE_VMID") == "status: running" ]] || die "base VM stopped before the guest agent became ready"
  sleep 5
done
((agent_ready == 1)) || die "guest agent did not become ready within 30 minutes"

guest_exec_checked /usr/bin/cloud-init status --wait
guest_exec_checked /usr/bin/env bash -c \
  'set -Eeuo pipefail; systemctl enable qemu-guest-agent.service; apt-get clean; rm -rf /var/lib/apt/lists/*; cloud-init clean --logs --machine-id --seed; rm -f /etc/ssh/ssh_host_* /var/lib/dbus/machine-id; truncate -s 0 /etc/machine-id; sync'

qm shutdown "$BASE_TEMPLATE_VMID" --timeout 180
[[ $(qm status "$BASE_TEMPLATE_VMID") == "status: stopped" ]] || die "base VM did not stop cleanly"

qm set "$BASE_TEMPLATE_VMID" --delete cicustom
qm cloudinit update "$BASE_TEMPLATE_VMID"
qm template "$BASE_TEMPLATE_VMID"
qm set "$BASE_TEMPLATE_VMID" --tags "$BASE_TEMPLATE_TAGS"

created_vmid=0
rm -f -- "$SNIPPET_PATH"
snippet_created=0
trap - EXIT
printf 'created base template %s (VMID %s) from the verified Ubuntu image\n' "$BASE_TEMPLATE_NAME" "$BASE_TEMPLATE_VMID"
