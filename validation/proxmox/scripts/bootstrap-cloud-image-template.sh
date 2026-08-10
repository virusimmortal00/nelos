#!/usr/bin/env bash
set -Eeuo pipefail
set +x

readonly UBUNTU_IMAGE_URL="https://cloud-images.ubuntu.com/releases/noble/release-20260801/ubuntu-24.04-server-cloudimg-amd64.img"
readonly UBUNTU_IMAGE_SHA256="0533b0655c32e68b31d792ecd6ccfca95abdbc536c4446874fe0513bd4140ffe"
readonly UBUNTU_IMAGE_NAME="ubuntu-24.04-server-cloudimg-amd64-release-20260801.img"
readonly UBUNTU_APT_SNAPSHOT="20260801T120000Z"
readonly LINKED_CLONE_STORAGE_TYPES_CSV="lvmthin,zfspool"
readonly FULL_COPY_STORAGE_TYPES_CSV="dir,lvm,lvmthin,zfspool"
readonly SNIPPET_STORAGE_TYPES_CSV="dir"

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

assert_root_owned_nonwritable_directory() {
  local path="$1"
  local label="$2"
  local owner mode permission_bits

  [[ -d $path && ! -L $path ]] || die "${label} must be a non-symlink directory"
  owner="$(stat -c '%u' -- "$path")" || die "could not inspect ${label} ownership"
  mode="$(stat -c '%a' -- "$path")" || die "could not inspect ${label} permissions"
  [[ $owner == "0" ]] || die "${label} must be owned by root"
  [[ $mode =~ ^[0-7]{3,4}$ ]] || die "${label} permissions are malformed"
  permission_bits=$((8#$mode))
  (( (permission_bits & 0022) == 0 )) || die "${label} must not be group- or world-writable"
}

assert_root_owned_nonwritable_file() {
  local path="$1"
  local label="$2"
  local owner mode permission_bits

  [[ -f $path && ! -L $path ]] || die "${label} must be a non-symlink regular file"
  owner="$(stat -c '%u' -- "$path")" || die "could not inspect ${label} ownership"
  mode="$(stat -c '%a' -- "$path")" || die "could not inspect ${label} permissions"
  [[ $owner == "0" ]] || die "${label} must be owned by root"
  [[ $mode =~ ^[0-7]{3,4}$ ]] || die "${label} permissions are malformed"
  permission_bits=$((8#$mode))
  (( (permission_bits & 0022) == 0 )) || die "${label} must not be group- or world-writable"
}

assert_protected_directory_chain() {
  local path="$1"
  local label="$2"
  local canonical current owner mode permission_bits

  canonical="$(readlink -f -- "$path")" || die "could not resolve ${label} exactly"
  [[ $canonical == "$path" ]] || die "${label} must use its canonical absolute path"
  current="$canonical"
  while true; do
    [[ -d $current && ! -L $current ]] || die "${label} ancestor must be a non-symlink directory: ${current}"
    owner="$(stat -c '%u' -- "$current")" || die "could not inspect ${label} ancestor ownership"
    mode="$(stat -c '%a' -- "$current")" || die "could not inspect ${label} ancestor permissions"
    [[ $owner == "0" ]] || die "${label} ancestor must be owned by root: ${current}"
    [[ $mode =~ ^[0-7]{3,4}$ ]] || die "${label} ancestor permissions are malformed: ${current}"
    permission_bits=$((8#$mode))
    if (( (permission_bits & 0022) != 0 )); then
      [[ $current == "/tmp" || $current == "/var/tmp" ]] || \
        die "${label} ancestor must not be group- or world-writable: ${current}"
      (( (permission_bits & 01000) != 0 )) || \
        die "${label} temporary ancestor must have the sticky bit: ${current}"
    fi
    [[ $current == "/" ]] && break
    current="$(dirname -- "$current")"
  done
}

storage_config() {
  local storage="$1"
  pvesh get "/storage/${storage}" --output-format json
}

storage_status() {
  local storage="$1"
  pvesh get "/nodes/${PROXMOX_NODE}/storage/${storage}/status" --output-format json
}

assert_node_local_storage() {
  local storage="$1"
  local required_content="$2"
  local allowed_types_csv="$3"
  local config status

  config="$(storage_config "$storage")" || die "could not read storage configuration: ${storage}"
  printf '%s' "$config" | perl -MJSON::PP -0777 -e '
    my ($wanted_node, $wanted_content, $allowed_types_csv) = @ARGV;
    my $data = decode_json(<STDIN>);
    my %allowed_types = map { $_ => 1 } split /,/, $allowed_types_csv;
    exit 1 unless $allowed_types{$data->{type} // q{}};
    exit 1 if (($data->{shared} // 0) != 0);
    my %content = map { $_ => 1 } split /,/, ($data->{content} // q{});
    exit 1 unless $content{$wanted_content};
    if (defined $data->{nodes} && length $data->{nodes}) {
      my %nodes = map { $_ => 1 } split /,/, $data->{nodes};
      exit 1 unless $nodes{$wanted_node};
    }
  ' "$PROXMOX_NODE" "$required_content" "$allowed_types_csv" || \
    die "storage ${storage} must be node-local, ${required_content}-capable, and enabled for ${PROXMOX_NODE}"
  status="$(storage_status "$storage")" || die "could not read node storage status: ${storage}"
  printf '%s' "$status" | perl -MJSON::PP -0777 -e '
    my $data = decode_json(<STDIN>);
    exit 1 unless (($data->{active} // 0) == 1 && ($data->{enabled} // 0) == 1);
  ' || die "storage ${storage} must report active=1 and enabled=1 for ${PROXMOX_NODE}"
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

guest_exec_cloud_init_wait() {
  local response exit_code
  response="$(qm guest exec "$BASE_TEMPLATE_VMID" --timeout 1800 -- /usr/bin/cloud-init status --wait)" || \
    die "cloud-init status command could not be submitted"
  exit_code="$(printf '%s' "$response" | perl -MJSON::PP -0777 -e '
    my $data = decode_json(<STDIN>);
    exit 1 unless (($data->{exited} // 0) == 1 && defined $data->{exitcode});
    print $data->{exitcode};
  ')" || die "cloud-init status returned an incomplete guest-agent response"
  case "$exit_code" in
    0) ;;
    2)
      printf 'warning: cloud-init completed with recoverable errors: %s\n' "$response" >&2
      ;;
    *)
      printf 'cloud-init failure response: %s\n' "$response" >&2
      die "cloud-init status failed with exit code ${exit_code}"
      ;;
  esac
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

for command in awk basename curl date dirname install mktemp perl pvesh pveversion qm readlink sha256sum sleep stat uname; do
  require_command "$command"
done

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
readonly SCRIPT_DIR
readonly DISK_ATTESTER="${SCRIPT_DIR}/attest-base-template-disks.sh"
assert_root_owned_nonwritable_directory "$SCRIPT_DIR" "bootstrap script directory"
assert_protected_directory_chain "$SCRIPT_DIR" "bootstrap script directory"
assert_root_owned_nonwritable_file "$DISK_ATTESTER" "base disk attester"
[[ -x $DISK_ATTESTER ]] || die "base disk attester must be executable"

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

assert_node_local_storage "$PVE_VM_STORAGE" images "$LINKED_CLONE_STORAGE_TYPES_CSV"
assert_node_local_storage "$PVE_EFI_STORAGE" images "$LINKED_CLONE_STORAGE_TYPES_CSV"
assert_node_local_storage "$PVE_CLOUD_INIT_STORAGE" images "$FULL_COPY_STORAGE_TYPES_CSV"
assert_node_local_storage "$PVE_SNIPPETS_STORAGE" snippets "$SNIPPET_STORAGE_TYPES_CSV"

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
baseline_response_path=""
snippet_created=0
created_vmid=0
cleanup_on_exit() {
  local status=$?

  if [[ -n $partial_path ]]; then
    rm -f -- "$partial_path"
  fi
  if [[ -n $baseline_response_path ]]; then
    rm -f -- "$baseline_response_path"
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

[[ $IMAGE_CACHE_DIR =~ ^/[A-Za-z0-9._/-]+$ && $IMAGE_CACHE_DIR != / && ! -L $IMAGE_CACHE_DIR ]] || \
  die "IMAGE_CACHE_DIR must be a specific absolute non-symlink directory without whitespace or backslashes"
if [[ -e $IMAGE_CACHE_DIR ]]; then
  [[ -d $IMAGE_CACHE_DIR ]] || die "IMAGE_CACHE_DIR exists but is not a directory"
else
  install -d -m 0755 "$IMAGE_CACHE_DIR"
fi
[[ $(stat -c '%u' "$IMAGE_CACHE_DIR") == "0" ]] || die "IMAGE_CACHE_DIR must be owned by root"
cache_mode="$(stat -c '%a' "$IMAGE_CACHE_DIR")"
[[ $cache_mode == "700" || $cache_mode == "750" || $cache_mode == "755" ]] || \
  die "IMAGE_CACHE_DIR must not be group- or world-writable"
assert_protected_directory_chain "$IMAGE_CACHE_DIR" "IMAGE_CACHE_DIR"
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
assert_root_owned_nonwritable_file "$IMAGE_PATH" "cached image"

assert_root_owned_nonwritable_directory "$snippet_root" "snippets storage root"
assert_protected_directory_chain "$snippet_root" "snippets storage root"
if [[ -e $SNIPPET_DIR || -L $SNIPPET_DIR ]]; then
  assert_root_owned_nonwritable_directory "$SNIPPET_DIR" "snippets directory"
else
  install -d -o root -g root -m 0755 "$SNIPPET_DIR"
  assert_root_owned_nonwritable_directory "$SNIPPET_DIR" "snippets directory"
fi
assert_protected_directory_chain "$SNIPPET_DIR" "snippets directory"
[[ ! -e $SNIPPET_PATH && ! -L $SNIPPET_PATH ]] || die "refusing to overwrite an existing snippets file: ${SNIPPET_PATH}"
umask 077
printf '%s\n' \
  '#cloud-config' \
  'apt:' \
  '  conf: |' \
  "    APT::Snapshot \"${UBUNTU_APT_SNAPSHOT}\";" \
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

guest_exec_cloud_init_wait
guest_exec_checked /usr/bin/env bash -c \
  'set -Eeuo pipefail; systemctl enable qemu-guest-agent.service; apt-get clean; rm -rf /var/lib/apt/lists/*; cloud-init clean --logs --machine-id --seed; rm -f /etc/ssh/ssh_host_* /var/lib/dbus/machine-id; truncate -s 0 /etc/machine-id; sync'

qm shutdown "$BASE_TEMPLATE_VMID" --timeout 180
[[ $(qm status "$BASE_TEMPLATE_VMID") == "status: stopped" ]] || die "base VM did not stop cleanly"

qm set "$BASE_TEMPLATE_VMID" --delete cicustom
qm cloudinit update "$BASE_TEMPLATE_VMID"
qm template "$BASE_TEMPLATE_VMID"
qm set "$BASE_TEMPLATE_VMID" --tags "$BASE_TEMPLATE_TAGS"

final_config="$(pvesh get "/nodes/${PROXMOX_NODE}/qemu/${BASE_TEMPLATE_VMID}/config" --current 1 --output-format json)" || \
  die "could not read final base-template configuration for attestation"
final_config_digest="$(printf '%s' "$final_config" | perl -MJSON::PP -0777 -e '
  my ($name) = @ARGV;
  my $value = decode_json(<STDIN>);
  my $json = JSON::PP->new->allow_nonref->canonical;
  exit 1 unless ($json->encode($value->{name}) =~ m{\A"} && ($value->{name} // q{}) eq $name);
  exit 1 unless $json->encode($value->{template}) eq q{1};
  my $digest = $value->{digest} // q{};
  exit 1 unless $json->encode($digest) =~ m{\A"} && $digest =~ m{\A[a-f0-9]{40}\z};
  print $digest;
' "$BASE_TEMPLATE_NAME")" || die "final base-template configuration identity is invalid"
baseline_uuid="$(< /proc/sys/kernel/random/uuid)"
baseline_nonce="baseline-${baseline_uuid//-/}"
readonly baseline_nonce
[[ $baseline_nonce =~ ^baseline-[a-f0-9]{32}$ ]] || die "could not generate a baseline attestation nonce"
baseline_request="$(perl -MJSON::PP -e '
  my ($nonce, $node, $vmid, $name, $digest) = @ARGV;
  print JSON::PP->new->ascii->canonical->encode({
    schemaVersion => 1,
    nonce => $nonce,
    node => $node,
    baseTemplateVmid => 0 + $vmid,
    baseTemplateName => $name,
    configDigest => $digest,
  }), qq{\n};
' "$baseline_nonce" "$PROXMOX_NODE" "$BASE_TEMPLATE_VMID" "$BASE_TEMPLATE_NAME" "$final_config_digest")" || \
  die "could not create baseline attestation request"
baseline_response_path="$(mktemp --tmpdir=/run nelos-base-attestation.XXXXXXXXXX)" || \
  die "could not create protected baseline attestation response file"
if ! printf '%s\n' "$baseline_request" | \
  "$DISK_ATTESTER" local-bootstrap "$PROXMOX_NODE" "$BASE_TEMPLATE_VMID" "$BASE_TEMPLATE_NAME" | \
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
  ' >"$baseline_response_path"; then
  die "base-template disk attestation command or response envelope failed"
fi
baseline_response="$(<"$baseline_response_path")"
[[ -n $baseline_response && ${#baseline_response} -le 4096 ]] || \
  die "base-template disk attestation response is empty or oversized"
baseline_receipt="$(printf '%s' "$baseline_response" | perl -MJSON::PP -0777 -e '
  my ($nonce, $node, $vmid, $name, $digest, $ubuntu_sha) = @ARGV;
  my $value = decode_json(<STDIN>);
  exit 1 unless ref($value) eq q{HASH};
  my @keys = sort keys %{$value};
  exit 1 unless join(q{,}, @keys) eq q{baseTemplateName,baseTemplateVmid,configDigest,disks,node,nonce,schemaVersion};
  my $json = JSON::PP->new->allow_nonref->canonical;
  exit 1 unless $json->encode($value->{schemaVersion}) eq q{1};
  exit 1 unless $json->encode($value->{baseTemplateVmid}) =~ m{\A[0-9]+\z} && $value->{baseTemplateVmid} == $vmid;
  exit 1 unless grep({ $json->encode($_) !~ m{\A"} } @{$value}{qw(nonce node baseTemplateName configDigest)}) == 0;
  exit 1 unless (($value->{nonce} // q{}) eq $nonce && ($value->{node} // q{}) eq $node);
  exit 1 unless (($value->{baseTemplateName} // q{}) eq $name && ($value->{configDigest} // q{}) eq $digest);
  my $disks = $value->{disks};
  exit 1 unless ref($disks) eq q{HASH} && keys(%{$disks}) == 2 && $disks->{scsi0} && $disks->{efidisk0};
  for my $key (qw(scsi0 efidisk0)) {
    my $disk = $disks->{$key};
    my @disk_keys = sort keys %{$disk};
    exit 1 unless join(q{,}, @disk_keys) eq q{backend,logicalSizeBytes,nativeIdentity,sha256,volumeId};
    exit 1 unless grep({ $json->encode($_) !~ m{\A"} } @{$disk}{qw(backend nativeIdentity sha256 volumeId)}) == 0;
    exit 1 unless ($disk->{backend} // q{}) eq q{lvmthin} || ($disk->{backend} // q{}) eq q{zfspool};
    exit 1 unless ($disk->{sha256} // q{}) =~ m{\A[a-f0-9]{64}\z};
    exit 1 unless $json->encode($disk->{logicalSizeBytes}) =~ m{\A[1-9][0-9]*\z};
  }
  $value->{receiptKind} = q{trusted-bootstrap-baseline};
  $value->{ubuntuImageSha256} = $ubuntu_sha;
  print JSON::PP->new->ascii->canonical->encode($value);
' "$baseline_nonce" "$PROXMOX_NODE" "$BASE_TEMPLATE_VMID" "$BASE_TEMPLATE_NAME" "$final_config_digest" "$UBUNTU_IMAGE_SHA256")" || \
  die "base-template disk attestation response is malformed"

created_vmid=0
rm -f -- "$SNIPPET_PATH"
snippet_created=0
rm -f -- "$baseline_response_path"
baseline_response_path=""
trap - EXIT
printf 'created base template %s (VMID %s) from the verified Ubuntu image\n' "$BASE_TEMPLATE_NAME" "$BASE_TEMPLATE_VMID" >&2
printf '%s\n' "$baseline_receipt"
