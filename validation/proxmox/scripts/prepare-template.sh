#!/usr/bin/env bash
set -Eeuo pipefail

die() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

assert_provisioned_guest() {
  local marker="/run/nelos-packer-build/provisioned"

  [[ ${NELOS_PACKER_BUILD_NONCE:-} =~ ^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$ ]] || \
    die "a valid Packer build nonce is required"
  [[ -f $marker && ! -L $marker ]] || die "Packer guest provisioning marker is missing"
  [[ $(<"$marker") == "$NELOS_PACKER_BUILD_NONCE" ]] || die "Packer guest provisioning marker does not match"
  [[ -r /etc/os-release ]] || die "guest operating-system identity is unavailable"
  # shellcheck disable=SC1091
  source /etc/os-release
  [[ ${ID:-} == "ubuntu" && ${VERSION_ID:-} == "24.04" ]] || die "guest must be Ubuntu 24.04"
  [[ $(uname -m) == "x86_64" ]] || die "guest must be x86_64"
  [[ $(systemd-detect-virt --vm) == "kvm" ]] || die "guest must be a KVM virtual machine"
}

[[ ${EUID} -eq 0 ]] || die "template cleanup must run as root"
command -v systemd-detect-virt >/dev/null 2>&1 || die "systemd-detect-virt is required"
assert_provisioned_guest
[[ -r /opt/nelos-validator/toolchain.lock.json ]] || die "installed toolchain lock is missing"
compgen -G '/usr/local/bin/codex-*' >/dev/null || die "no isolated Codex lane wrappers are installed"

systemctl enable qemu-guest-agent.service
apt-get clean
rm -rf /var/lib/apt/lists/*

cloud-init clean --logs --machine-id --seed
if [[ -f /home/ubuntu/.ssh/authorized_keys ]]; then
  truncate -s 0 /home/ubuntu/.ssh/authorized_keys
fi
if [[ -f /root/.ssh/authorized_keys ]]; then
  truncate -s 0 /root/.ssh/authorized_keys
fi
rm -f /etc/ssh/ssh_host_*
rm -f /var/lib/dbus/machine-id
truncate -s 0 /etc/machine-id

rm -f /root/.bash_history /home/ubuntu/.bash_history
rm -f /tmp/nelos-toolchain.lock.json /tmp/99-nelos-validator.cfg
find /var/log -xdev -type f -exec truncate -s 0 {} +

rm -f /run/nelos-packer-build/provisioned
rmdir /run/nelos-packer-build

sync
