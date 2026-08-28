#!/usr/bin/bash
set -Eeuo pipefail
set +x
umask 077

die() { printf 'error: %s\n' "$*" >&2; exit 1; }
[[ ${EUID} -eq 0 ]] || die "installation must run as root"
(($# == 1)) || die "usage: install.sh /absolute/path/to/digest-verified-candidate"
candidate="$1"
[[ $candidate == /* && -d $candidate && ! -L $candidate ]] || die "candidate must be an absolute non-symlink directory"
for path in \
  "$candidate/src/proxmox-desktop-test-driver.mjs" \
  "$candidate/src/proxmox-review-output.mjs" \
  "$candidate/validation/desktop-smoke/scenario-sets/release.json" \
  "$candidate/validation/proxmox/desktop-driver/nelos-desktop-test-driver"; do
  [[ -f $path && ! -L $path ]] || die "required driver artifact is unavailable: $path"
done
for executable in /usr/bin/install /usr/bin/cp /usr/bin/find /usr/bin/chown /usr/bin/chmod /usr/bin/jq /usr/bin/node; do
  [[ -x $executable && -f $executable && ! -L $executable ]] || die "required fixed executable is unavailable: $executable"
done
/usr/bin/jq --version >/dev/null

target=/usr/local/lib/nelos-provider-driver
[[ ! -e $target ]] || die "provider library already exists; remove it deliberately before installing a different reviewed candidate"
/usr/bin/install -d -o root -g root -m 0755 "$target"
/usr/bin/cp -a -- "$candidate/src" "$candidate/validation" "$target/"
/usr/bin/find "$target" -type d -exec /usr/bin/chown root:root {} + -exec /usr/bin/chmod 0755 {} +
/usr/bin/find "$target" -type f -exec /usr/bin/chown root:root {} + -exec /usr/bin/chmod go-w {} +
/usr/bin/install -o root -g root -m 0755 \
  "$candidate/validation/proxmox/desktop-driver/nelos-desktop-test-driver" \
  /usr/local/libexec/nelos-desktop-test-driver

printf '%s\n' "installed /usr/local/libexec/nelos-desktop-test-driver" >&2
