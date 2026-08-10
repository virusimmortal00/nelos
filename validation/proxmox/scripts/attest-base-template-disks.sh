#!/usr/bin/bash
set -Eeuo pipefail
set +x
umask 077

readonly PVE_SHELL_PATH="/usr/sbin:/usr/bin:/sbin:/bin"
readonly NONCE_PATTERN='^(baseline|build)-[a-f0-9]{32}$'
readonly SHA1_PATTERN='^[a-f0-9]{40}$'
readonly TEMPLATE_NAME_PATTERN='^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?$'
readonly ATTESTATION_CONFIG_DEFAULT="/etc/nelos-validator/base-disk-attester.json"

die() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

require_fixed_command() {
  local path="$1"
  [[ -x $path && -f $path && ! -L $path ]] || die "required fixed executable is unavailable: ${path}"
}

assert_root_protected_file() {
  local path="$1"
  local label="$2"
  local canonical current owner mode link_count permission_bits

  [[ $path == /* && -f $path && ! -L $path ]] || die "${label} must be an absolute regular non-symlink file"
  canonical="$(/usr/bin/readlink -f -- "$path")" || die "could not resolve ${label}"
  [[ $canonical == "$path" ]] || die "${label} must use its canonical path"
  owner="$(/usr/bin/stat -c '%u' -- "$path")" || die "could not inspect ${label} ownership"
  mode="$(/usr/bin/stat -c '%a' -- "$path")" || die "could not inspect ${label} permissions"
  link_count="$(/usr/bin/stat -c '%h' -- "$path")" || die "could not inspect ${label} link count"
  [[ $owner == 0 && $mode =~ ^[0-7]{3,4}$ ]] || die "${label} ownership or permissions are invalid"
  [[ $link_count == 1 ]] || die "${label} must have exactly one hard link"
  permission_bits=$((8#$mode))
  (( (permission_bits & 0022) == 0 )) || die "${label} must not be group- or world-writable"

  current="$(/usr/bin/dirname -- "$canonical")"
  while true; do
    [[ -d $current && ! -L $current ]] || die "${label} ancestor must be a non-symlink directory: ${current}"
    owner="$(/usr/bin/stat -c '%u' -- "$current")" || die "could not inspect ${label} ancestor ownership"
    mode="$(/usr/bin/stat -c '%a' -- "$current")" || die "could not inspect ${label} ancestor permissions"
    [[ $owner == 0 && $mode =~ ^[0-7]{3,4}$ ]] || die "${label} ancestor ownership or permissions are invalid: ${current}"
    permission_bits=$((8#$mode))
    (( (permission_bits & 0022) == 0 )) || die "${label} ancestor must not be group- or world-writable: ${current}"
    [[ $current == / ]] && break
    current="$(/usr/bin/dirname -- "$current")"
  done
}

for command_path in \
  /usr/bin/bash \
  /usr/bin/basename \
  /usr/bin/dirname \
  /usr/bin/flock \
  /usr/bin/install \
  /usr/bin/perl \
  /usr/bin/pvesh \
  /usr/bin/readlink \
  /usr/bin/sha256sum \
  /usr/bin/stat \
  /usr/sbin/blockdev \
  /usr/sbin/lvm \
  /usr/sbin/pvesm \
  /usr/sbin/zfs; do
  require_fixed_command "$command_path"
done

[[ ${EUID} -eq 0 ]] || die "the disk attester must run as root through the documented forced command"
assert_root_protected_file "$0" "disk attester executable"
export PATH="$PVE_SHELL_PATH"
unset \
  BASH_ENV \
  CDPATH \
  ENV \
  GIT_DIR \
  IFS \
  PERL5LIB \
  PERL5OPT \
  PYTHONPATH \
  SSH_ASKPASS \
  SSH_AUTH_SOCK

mode="${1:-}"
case "$mode" in
  local-bootstrap)
    (($# == 4)) || die "local-bootstrap requires node, VMID, and exact template name"
    [[ -z ${SSH_CONNECTION:-} && -z ${SSH_ORIGINAL_COMMAND:-} ]] || \
      die "local-bootstrap cannot run through SSH"
    allowed_node="$2"
    allowed_vmid="$3"
    allowed_name="$4"
    ;;
  serve)
    (($# == 1)) || die "serve accepts no request-controlled arguments"
    [[ -z ${SSH_ORIGINAL_COMMAND:-} ]] || die "remote commands are disabled; send one JSON request on standard input"
    readonly attestation_config="$ATTESTATION_CONFIG_DEFAULT"
    assert_root_protected_file "$attestation_config" "attester configuration"
    config_fields="$(/usr/bin/perl -MJSON::PP -0777 -e '
      my $value = decode_json(<STDIN>);
      die "object" unless ref($value) eq "HASH";
      my @keys = sort keys %{$value};
      die "keys" unless join(q{,}, @keys) eq q{baseTemplateName,baseTemplateVmid,node,schemaVersion};
      my $json = JSON::PP->new->allow_nonref->canonical;
      die "schema" unless $json->encode($value->{schemaVersion}) eq q{1};
      my $node = $value->{node} // q{};
      my $vmid = $value->{baseTemplateVmid} // q{};
      my $name = $value->{baseTemplateName} // q{};
      die "node" unless $json->encode($node) =~ m{\A"} && $node =~ m{\A[A-Za-z0-9][A-Za-z0-9._-]*\z};
      die "vmid" unless $json->encode($vmid) =~ m{\A[0-9]+\z} && $vmid >= 100 && $vmid <= 999999999;
      die "name" unless $json->encode($name) =~ m{\A"} && $name =~ m{\A[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\z};
      print join(qq{\t}, $node, $vmid, $name);
    ' <"$attestation_config")" || die "attester configuration is malformed"
    IFS=$'\t' read -r allowed_node allowed_vmid allowed_name <<<"$config_fields"
    ;;
  *) die "expected local-bootstrap or serve mode" ;;
esac
readonly allowed_node allowed_vmid allowed_name

[[ $allowed_node =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]] || die "allowed node is unsafe"
[[ $allowed_vmid =~ ^[0-9]+$ ]] || die "allowed VMID is invalid"
((allowed_vmid >= 100 && allowed_vmid <= 999999999)) || die "allowed VMID is out of range"
[[ $allowed_name =~ $TEMPLATE_NAME_PATTERN ]] || die "allowed template name is unsafe"

request_fields="$(/usr/bin/perl -MJSON::PP -e '
  binmode(STDIN);
  my $request = q{};
  while (1) {
    my $count = sysread(STDIN, my $chunk, 4096);
    die "read" unless defined($count);
    last if $count == 0;
    $request .= $chunk;
    die "size" if length($request) > 2049;
  }
  die "framing" unless length($request) >= 2 && substr($request, -1, 1) eq qq{\n};
  chop($request);
  die "framing" if index($request, qq{\n}) >= 0 || index($request, qq{\0}) >= 0;
  die "size" if length($request) > 2048;
  my $value = decode_json($request);
  die "object" unless ref($value) eq "HASH";
  my @keys = sort keys %{$value};
  die "keys" unless join(q{,}, @keys) eq q{baseTemplateName,baseTemplateVmid,configDigest,node,nonce,schemaVersion};
  my $json = JSON::PP->new->allow_nonref->canonical;
  die "schema" unless $json->encode($value->{schemaVersion}) eq q{1};
  my ($nonce, $node, $vmid, $name, $digest) = @{$value}{qw(nonce node baseTemplateVmid baseTemplateName configDigest)};
  die "strings" unless grep({ $json->encode($_) !~ m{\A"} } ($nonce, $node, $name, $digest)) == 0;
  die "vmid" unless $json->encode($vmid) =~ m{\A[0-9]+\z};
  print join(qq{\t}, $nonce, $node, $vmid, $name, $digest);
')" || die "attestation request is malformed"
IFS=$'\t' read -r request_nonce request_node request_vmid request_name request_config_digest <<<"$request_fields"
readonly request_nonce request_node request_vmid request_name request_config_digest

[[ $request_nonce =~ $NONCE_PATTERN ]] || die "attestation nonce is invalid"
[[ $request_node == "$allowed_node" ]] || die "request node is not allowlisted"
[[ $request_vmid == "$allowed_vmid" ]] || die "request VMID is not allowlisted"
[[ $request_name == "$allowed_name" ]] || die "request template name is not allowlisted"
[[ $request_config_digest =~ $SHA1_PATTERN ]] || die "request configuration digest is invalid"

local_node="$(/usr/bin/basename "$(/usr/bin/readlink -f /etc/pve/local)")" || die "could not resolve local PVE node"
[[ $local_node == "$allowed_node" ]] || die "attester is installed on the wrong PVE node"

readonly lock_directory="/run/nelos-base-disk-attester"
if [[ ! -e $lock_directory && ! -L $lock_directory ]]; then
  /usr/bin/install -d -o root -g root -m 0700 "$lock_directory"
fi
[[ -d $lock_directory && ! -L $lock_directory ]] || die "attester lock directory is unsafe"
[[ $(/usr/bin/stat -c '%u:%a' -- "$lock_directory") == "0:700" ]] || \
  die "attester lock directory must be root-owned mode 0700"
readonly lock_path="${lock_directory}/${allowed_vmid}.lock"
exec 9>"$lock_path"
/usr/bin/flock -n 9 || die "another attestation is already active for VMID ${allowed_vmid}"

read_current_config() {
  /usr/bin/pvesh get "/nodes/${allowed_node}/qemu/${allowed_vmid}/config" --current 1 --output-format json
}

assert_no_pending_config() {
  local pending
  pending="$(/usr/bin/pvesh get "/nodes/${allowed_node}/qemu/${allowed_vmid}/pending" --output-format json)" || \
    die "could not read pending base-template configuration"
  printf '%s' "$pending" | /usr/bin/perl -MJSON::PP -0777 -e '
    my $rows = decode_json(<STDIN>);
    die "rows" unless ref($rows) eq "ARRAY" && @{$rows};
    my %seen;
    for my $row (@{$rows}) {
      die "row" unless ref($row) eq "HASH";
      my @keys = sort keys %{$row};
      die "pending" if exists($row->{pending}) || exists($row->{delete});
      die "shape" unless join(q{,}, @keys) eq q{key,value};
      my $key = $row->{key} // q{};
      die "key" unless $key =~ m{\A[A-Za-z0-9][A-Za-z0-9_-]*\z} && !$seen{$key}++;
      die "value" if !defined($row->{value}) || ref($row->{value});
    }
  ' || die "base template has pending or malformed configuration"
}

parse_config() {
  /usr/bin/perl -MJSON::PP -0777 -e '
    my ($vmid, $name, $digest) = @ARGV;
    my $value = decode_json(<STDIN>);
    die "object" unless ref($value) eq "HASH";
    my $json = JSON::PP->new->allow_nonref->canonical;
    die "identity" unless $json->encode($value->{name}) =~ m{\A"} && ($value->{name} // q{}) eq $name;
    die "identity" unless $json->encode($value->{template}) eq q{1};
    die "digest" unless $json->encode($value->{digest}) =~ m{\A"} && ($value->{digest} // q{}) eq $digest;
    my %seen_volume;
    for my $key (qw(scsi0 efidisk0)) {
      my $disk = $value->{$key} // q{};
      die "disk" unless $disk =~ m{\A([A-Za-z0-9][A-Za-z0-9._-]*):(base-\Q${vmid}\E-disk-[0-9]+)(?:,.*)?\z};
      die "duplicate" if $seen_volume{"$1:$2"}++;
      print join(qq{\t}, $key, $1, $2), qq{\n};
    }
  ' "$allowed_vmid" "$allowed_name" "$request_config_digest"
}

initial_config="$(read_current_config)" || die "could not read current base-template configuration"
disk_inventory="$(printf '%s' "$initial_config" | parse_config)" || die "base-template persistent disk inventory does not match"
assert_no_pending_config

ACTIVATED_LVS=()
cleanup_activated_lvs() {
  local index lv
  for ((index=${#ACTIVATED_LVS[@]} - 1; index >= 0; index--)); do
    lv="${ACTIVATED_LVS[$index]}"
    [[ -n $lv ]] && /usr/sbin/lvm lvchange -an -- "$lv" >/dev/null 2>&1 || true
  done
}
trap cleanup_activated_lvs EXIT

storage_type_and_pool() {
  local storage="$1"
  /usr/bin/pvesh get "/storage/${storage}" --output-format json | /usr/bin/perl -MJSON::PP -0777 -e '
    my $value = decode_json(<STDIN>);
    my $type = $value->{type} // q{};
    die "type" unless $type eq q{lvmthin} || $type eq q{zfspool};
    if ($type eq q{lvmthin}) {
      my $vg = $value->{vgname} // q{};
      my $thinpool = $value->{thinpool} // q{};
      die "lvm" unless $vg =~ m{\A[A-Za-z0-9][A-Za-z0-9+_.-]*\z} && $thinpool =~ m{\A[A-Za-z0-9][A-Za-z0-9+_.-]*\z};
      print join(qq{\t}, $type, $vg, $thinpool);
    } else {
      my $pool = $value->{pool} // q{};
      die "zfs" unless $pool =~ m{\A[A-Za-z0-9][A-Za-z0-9._:-]*(?:/[A-Za-z0-9][A-Za-z0-9._:-]*)*\z};
      die "zfs" if grep { $_ eq q{.} || $_ eq q{..} } split m{/}, $pool;
      print join(qq{\t}, $type, $pool);
    }
  '
}

lvm_identity() {
  local lv_path="$1"
  /usr/sbin/lvm lvs --noheadings --separator ':' --units b --nosuffix \
    -o vg_name,lv_name,lv_size,lv_attr,uuid,pool_lv -- "$lv_path" | \
    /usr/bin/perl -ne '
      s/^\s+|\s+$//g;
      my @v = split /:/, $_, 6;
      s/^\s+|\s+$//g for @v;
      die "fields" unless @v == 6 && $v[2] =~ m{\A[0-9]+\z} && $v[4] =~ m{\A[A-Za-z0-9-]+\z};
      print join(qq{\t}, @v);
    '
}

hash_lvmthin() {
  local key="$1" storage="$2" volume="$3" vg="$4" thinpool="$5"
  local volid path expected_path canonical before after vg_name lv_name logical_size lv_attr lv_uuid pool_lv hash observed_size observed_uuid observed_path storage_after
  volid="${storage}:${volume}"
  path="$(/usr/sbin/pvesm path "$volid")" || die "could not resolve ${key} LVM path"
  expected_path="/dev/${vg}/${volume}"
  [[ $path == "$expected_path" ]] || die "${key} LVM path does not match its storage-native identity"
  before="$(lvm_identity "${vg}/${volume}")" || die "could not inspect ${key} LVM identity"
  IFS=$'\t' read -r vg_name lv_name logical_size lv_attr lv_uuid pool_lv <<<"$before"
  [[ $vg_name == "$vg" && $lv_name == "$volume" && $pool_lv == "$thinpool" ]] || die "${key} LVM storage identity does not match"
  [[ ${lv_attr:0:1} == V && ${lv_attr:1:1} == r && ${lv_attr:4:1} == - && ${lv_attr:9:1} == k ]] || \
    die "${key} LVM base volume must be an inactive read-only activation-skip thin volume"
  /usr/sbin/lvm lvchange -ay -K -- "${vg}/${volume}" >/dev/null || die "could not activate ${key} read-only base volume"
  ACTIVATED_LVS+=("${vg}/${volume}")
  after="$(lvm_identity "${vg}/${volume}")" || die "could not re-read activated ${key} LVM identity"
  IFS=$'\t' read -r vg_name lv_name observed_size lv_attr observed_uuid pool_lv <<<"$after"
  [[ $observed_uuid == "$lv_uuid" && $observed_size == "$logical_size" && ${lv_attr:1:1} == r && ${lv_attr:4:1} == a && ${lv_attr:9:1} == k ]] || \
    die "${key} LVM identity changed during activation"
  canonical="$(/usr/bin/readlink -f -- "$path")" || die "could not resolve ${key} LVM block device"
  [[ -b $canonical && ! -L $canonical ]] || die "${key} LVM path must resolve to a block device"
  observed_size="$(/usr/sbin/blockdev --getsize64 "$canonical")" || die "could not read ${key} logical size"
  [[ $observed_size == "$logical_size" ]] || die "${key} LVM logical size does not match"
  hash="$(/usr/bin/sha256sum -- "$canonical")" || die "could not hash ${key} LVM bytes"
  hash="${hash%% *}"
  [[ $hash =~ ^[a-f0-9]{64}$ ]] || die "${key} LVM hash is malformed"
  after="$(lvm_identity "${vg}/${volume}")" || die "could not verify ${key} LVM identity after hashing"
  IFS=$'\t' read -r vg_name lv_name observed_size lv_attr observed_uuid pool_lv <<<"$after"
  [[ $observed_uuid == "$lv_uuid" && $observed_size == "$logical_size" && ${lv_attr:1:1} == r && ${lv_attr:4:1} == a && ${lv_attr:9:1} == k ]] || \
    die "${key} LVM identity changed while hashing"
  observed_path="$(/usr/sbin/pvesm path "$volid")" || die "could not re-resolve ${key} LVM path"
  [[ $observed_path == "$expected_path" ]] || die "${key} LVM path changed while hashing"
  storage_after="$(storage_type_and_pool "$storage")" || die "could not re-read ${key} LVM storage identity"
  [[ $storage_after == "lvmthin"$'\t'"${vg}"$'\t'"${thinpool}" ]] || die "${key} LVM storage identity changed while hashing"
  /usr/sbin/lvm lvchange -an -- "${vg}/${volume}" >/dev/null || die "could not deactivate ${key} base volume"
  ACTIVATED_LVS[${#ACTIVATED_LVS[@]} - 1]=""
  printf -v HASHED_DISK_ROW '%s\t%s\t%s\t%s\t%s\t%s' "$key" "$volid" "$logical_size" "$hash" "lvmthin" "$lv_uuid"
}

zfs_identity() {
  local dataset="$1"
  local dataset_row snapshot_row written
  dataset_row="$(/usr/sbin/zfs list -Hp -o name,guid,volsize "$dataset")" || return 1
  snapshot_row="$(/usr/sbin/zfs list -Hp -t snapshot -o name,guid "$dataset@__base__")" || return 1
  written="$(/usr/sbin/zfs get -Hp -o value 'written@__base__' "$dataset")" || return 1
  printf '%s\n%s\n%s\n' "$dataset_row" "$snapshot_row" "$written" | /usr/bin/perl -ne '
    chomp;
    push @rows, $_;
    END {
      die "rows" unless @rows == 3;
      my @dataset = split /\t/, $rows[0];
      my @snapshot = split /\t/, $rows[1];
      my $written = $rows[2];
      die "dataset" unless @dataset == 3 && $dataset[1] =~ m{\A[0-9]+\z} && $dataset[2] =~ m{\A[0-9]+\z};
      die "snapshot" unless @snapshot == 2 && $snapshot[0] eq $dataset[0] . q{@__base__} && $snapshot[1] =~ m{\A[0-9]+\z};
      die "written" unless $written eq q{0};
      print join(qq{\t}, $dataset[1], $snapshot[1], $dataset[2], $written);
    }
  '
}

hash_zfspool() {
  local key="$1" storage="$2" volume="$3" pool="$4"
  local volid dataset path expected_path canonical before after dataset_guid snapshot_guid logical_size written observed_size hash observed_path storage_after
  volid="${storage}:${volume}"
  dataset="${pool}/${volume}"
  before="$(zfs_identity "$dataset")" || die "could not inspect ${key} ZFS base snapshot identity"
  IFS=$'\t' read -r dataset_guid snapshot_guid logical_size written <<<"$before"
  path="$(/usr/sbin/pvesm path "$volid")" || die "could not resolve ${key} ZFS path"
  expected_path="/dev/zvol/${dataset}"
  [[ $path == "$expected_path" && -L $path ]] || die "${key} ZFS zvol link does not match its storage-native identity"
  canonical="$(/usr/bin/readlink -f -- "$path")" || die "could not resolve ${key} ZFS zvol device"
  [[ -b $canonical && ! -L $canonical ]] || die "${key} ZFS path must resolve to a block device"
  observed_size="$(/usr/sbin/blockdev --getsize64 "$canonical")" || die "could not read ${key} logical size"
  [[ $observed_size == "$logical_size" ]] || die "${key} ZFS logical size does not match"
  hash="$(/usr/bin/sha256sum -- "$canonical")" || die "could not hash ${key} ZFS bytes"
  hash="${hash%% *}"
  [[ $hash =~ ^[a-f0-9]{64}$ ]] || die "${key} ZFS hash is malformed"
  after="$(zfs_identity "$dataset")" || die "could not verify ${key} ZFS base snapshot after hashing"
  [[ $after == "$before" ]] || die "${key} ZFS dataset or __base__ snapshot changed while hashing"
  observed_path="$(/usr/sbin/pvesm path "$volid")" || die "could not re-resolve ${key} ZFS path"
  [[ $observed_path == "$expected_path" ]] || die "${key} ZFS path changed while hashing"
  storage_after="$(storage_type_and_pool "$storage")" || die "could not re-read ${key} ZFS storage identity"
  [[ $storage_after == "zfspool"$'\t'"${pool}" ]] || die "${key} ZFS storage identity changed while hashing"
  printf -v HASHED_DISK_ROW '%s\t%s\t%s\t%s\t%s\t%s' "$key" "$volid" "$logical_size" "$hash" "zfspool" "${dataset_guid}:${snapshot_guid}"
}

disk_rows=""
HASHED_DISK_ROW=""
while IFS=$'\t' read -r disk_key disk_storage disk_volume; do
  [[ -n $disk_key && -n $disk_storage && -n $disk_volume ]] || die "persistent disk inventory is incomplete"
  storage_fields="$(storage_type_and_pool "$disk_storage")" || die "could not inspect ${disk_key} storage"
  IFS=$'\t' read -r disk_storage_type storage_field_one storage_field_two <<<"$storage_fields"
  case "$disk_storage_type" in
    lvmthin)
      hash_lvmthin "$disk_key" "$disk_storage" "$disk_volume" "$storage_field_one" "$storage_field_two"
      ;;
    zfspool)
      hash_zfspool "$disk_key" "$disk_storage" "$disk_volume" "$storage_field_one"
      ;;
    *) die "unsupported persistent disk storage type: ${disk_storage_type}" ;;
  esac
  [[ -n $HASHED_DISK_ROW ]] || die "disk attester did not produce a measurement row"
  disk_rows+="${HASHED_DISK_ROW}"$'\n'
  HASHED_DISK_ROW=""
done <<<"$disk_inventory"

final_config="$(read_current_config)" || die "could not re-read current base-template configuration"
printf '%s' "$final_config" | parse_config >/dev/null || die "base-template configuration changed while hashing"
assert_no_pending_config

printf '%s' "$disk_rows" | /usr/bin/perl -MJSON::PP -e '
  my ($nonce, $node, $vmid, $name, $digest) = @ARGV;
  my %disks;
  while (<STDIN>) {
    chomp;
    next unless length;
    my ($key, $volid, $size, $sha, $backend, $native) = split /\t/, $_, 6;
    die "row" unless defined($native) && ($key eq q{scsi0} || $key eq q{efidisk0}) && !$disks{$key};
    die "size" unless $size =~ m{\A[1-9][0-9]*\z};
    die "sha" unless $sha =~ m{\A[a-f0-9]{64}\z};
    $disks{$key} = {
      backend => $backend,
      logicalSizeBytes => 0 + $size,
      nativeIdentity => $native,
      sha256 => $sha,
      volumeId => $volid,
    };
  }
  die "disks" unless keys(%disks) == 2 && $disks{scsi0} && $disks{efidisk0};
  my $response = {
    schemaVersion => 1,
    nonce => $nonce,
    node => $node,
    baseTemplateVmid => 0 + $vmid,
    baseTemplateName => $name,
    configDigest => $digest,
    disks => \%disks,
  };
  print JSON::PP->new->ascii->canonical->encode($response), qq{\n};
' "$request_nonce" "$allowed_node" "$allowed_vmid" "$allowed_name" "$request_config_digest"

trap - EXIT
cleanup_activated_lvs
