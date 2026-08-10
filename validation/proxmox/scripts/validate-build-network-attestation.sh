#!/usr/bin/env bash
set -Eeuo pipefail

die() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

(($# == 3)) || die "usage: validate-build-network-attestation.sh ATTESTATION_FILE NODE SOURCE_REVISION"
readonly ATTESTATION_FILE="$1"
readonly EXPECTED_NODE="$2"
readonly EXPECTED_SOURCE_REVISION="$3"

[[ $ATTESTATION_FILE == /* && $ATTESTATION_FILE =~ ^/[A-Za-z0-9._/-]+$ ]] || \
  die "build-network attestation must use a specific absolute path without whitespace"
[[ $EXPECTED_NODE =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]] || die "expected node is unsafe"
[[ $EXPECTED_SOURCE_REVISION =~ ^[a-f0-9]{40}$ || $EXPECTED_SOURCE_REVISION =~ ^[a-f0-9]{64}$ ]] || \
  die "expected source revision must be a full Git object ID"
for executable in /usr/bin/date /usr/bin/dirname /usr/bin/env /usr/bin/id /usr/bin/perl /usr/bin/realpath /usr/bin/stat; do
  [[ -x $executable && -f $executable && ! -L $executable ]] || die "required fixed executable is unavailable: ${executable}"
done
[[ -f $ATTESTATION_FILE && ! -L $ATTESTATION_FILE ]] || \
  die "build-network attestation must be a regular non-symlink file"
canonical="$(/usr/bin/realpath -e -- "$ATTESTATION_FILE")" || die "could not resolve build-network attestation"
[[ $canonical == "$ATTESTATION_FILE" ]] || die "build-network attestation must use its canonical path"
current_uid="$(/usr/bin/id -u)"
owner="$(/usr/bin/stat -c '%u' -- "$ATTESTATION_FILE")" || die "could not inspect build-network attestation ownership"
mode="$(/usr/bin/stat -c '%a' -- "$ATTESTATION_FILE")" || die "could not inspect build-network attestation mode"
links="$(/usr/bin/stat -c '%h' -- "$ATTESTATION_FILE")" || die "could not inspect build-network attestation links"
[[ $owner == "$current_uid" && $mode == "400" && $links == "1" ]] || \
  die "build-network attestation must be singly linked, owned by the current user, and mode 0400"

current="$(/usr/bin/dirname -- "$canonical")"
while true; do
  [[ -d $current && ! -L $current ]] || die "build-network attestation ancestor is not a directory: ${current}"
  owner="$(/usr/bin/stat -c '%u' -- "$current")" || die "could not inspect attestation ancestor ownership"
  mode="$(/usr/bin/stat -c '%a' -- "$current")" || die "could not inspect attestation ancestor mode"
  [[ ($owner == "0" || $owner == "$current_uid") && $mode =~ ^[0-7]{3,4}$ ]] || \
    die "build-network attestation ancestor ownership or mode is invalid: ${current}"
  permission_bits=$((8#$mode))
  if (( (permission_bits & 0022) != 0 )); then
    [[ ($current == "/tmp" || $current == "/var/tmp") && $owner == "0" ]] || \
      die "build-network attestation ancestor must not be group- or world-writable: ${current}"
    (( (permission_bits & 01000) != 0 )) || \
      die "build-network attestation temporary ancestor must have the sticky bit: ${current}"
  fi
  [[ $current == / ]] && break
  current="$(/usr/bin/dirname -- "$current")"
done

NOW_EPOCH="$(/usr/bin/date +%s)"
readonly NOW_EPOCH
# shellcheck disable=SC2016 # Embedded Perl source must not be expanded by Bash.
/usr/bin/env -i \
  PATH=/usr/bin:/bin \
  LC_ALL=C \
  HOME=/nonexistent \
  /usr/bin/perl -MJSON::PP -0777 -e '
  my ($node, $revision, $now) = @ARGV;
  my $value = decode_json(<STDIN>);
  my $json = JSON::PP->new->allow_nonref;
  sub has_exact_keys {
    my ($object, @expected) = @_;
    return 0 unless ref($object) eq q{HASH};
    return 0 unless scalar(keys %{$object}) == scalar(@expected);
    for my $field (@expected) {
      return 0 unless exists($object->{$field});
    }
    return 1;
  }
  exit 1 unless has_exact_keys(
    $value,
    qw(checks kind node policy schemaVersion sourceRevision validFromEpoch validUntilEpoch),
  );
  exit 1 unless $json->encode($value->{schemaVersion}) eq q{1};
  exit 1 unless ($value->{kind} // q{}) eq q{nelos-build-network-readiness};
  exit 1 unless ($value->{node} // q{}) eq $node;
  exit 1 unless ($value->{sourceRevision} // q{}) eq $revision;
  for my $field (qw(validFromEpoch validUntilEpoch)) {
    exit 1 unless $json->encode($value->{$field}) =~ m{\A[0-9]+\z};
  }
  exit 1 unless $value->{validFromEpoch} <= $now && $now <= $value->{validUntilEpoch};
  exit 1 unless $value->{validUntilEpoch} > $value->{validFromEpoch};
  exit 1 unless ($value->{validUntilEpoch} - $value->{validFromEpoch}) <= 86400;

  my $policy = $value->{policy};
  exit 1 unless has_exact_keys(
    $policy,
    qw(allowedGuestHosts allowedTcpPorts bridge defaultEgressPolicy dhcpSource dnsPolicy mode),
  );
  exit 1 unless ($policy->{mode} // q{}) eq q{preconfigured-restricted-vnet};
  exit 1 unless ($policy->{bridge} // q{}) eq q{nelosbld};
  exit 1 unless ($policy->{dhcpSource} // q{}) eq q{restricted-vnet};
  exit 1 unless ($policy->{defaultEgressPolicy} // q{}) eq q{deny};
  exit 1 unless ($policy->{dnsPolicy} // q{}) eq q{restricted-host-allowlist-only};
  exit 1 unless ref($policy->{allowedTcpPorts}) eq q{ARRAY};
  exit 1 unless @{$policy->{allowedTcpPorts}} == 1 &&
    $json->encode($policy->{allowedTcpPorts}->[0]) eq q{443};
  exit 1 unless ref($policy->{allowedGuestHosts}) eq q{ARRAY};
  exit 1 unless $json->encode($policy->{allowedGuestHosts}) eq
    q{["github.com","nodejs.org","release-assets.githubusercontent.com","snapshot.ubuntu.com"]};

  my $checks = $value->{checks};
  my @check_fields = qw(
    buildGuestVmbr0Excluded
    clusterSpanning
    defaultEgressDenied
    dhcpProvidedByRestrictedVnet
    dnsRestrictedToAllowedHosts
    tcp443Only
    vnetExists
  );
  exit 1 unless has_exact_keys($checks, @check_fields);
  for my $field (@check_fields) {
    exit 1 unless JSON::PP::is_bool($checks->{$field}) && $checks->{$field};
  }
' "$EXPECTED_NODE" "$EXPECTED_SOURCE_REVISION" "$NOW_EPOCH" <"$ATTESTATION_FILE" || \
  die "build-network readiness attestation is malformed, stale, mismatched, or incomplete"
