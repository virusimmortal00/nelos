#!/usr/bin/env bash
set -euo pipefail
umask 027

[[ ${EUID} -eq 0 ]] || { echo "install-guest.sh must run as root" >&2; exit 70; }
install_and_attest_no_core_policy() {
  install -d -o root -g root -m 0755 \
    /etc/security/limits.d /etc/systemd/system.conf.d /etc/systemd/user.conf.d /etc/systemd/coredump.conf.d /etc/sysctl.d /etc/default
  install -o root -g root -m 0644 /dev/null /etc/security/limits.d/99-nelos-no-core.conf
  cat >/etc/security/limits.d/99-nelos-no-core.conf <<'EOF'
* soft core 0
* hard core 0
root soft core 0
root hard core 0
EOF
  for target in /etc/systemd/system.conf.d/99-nelos-no-core.conf /etc/systemd/user.conf.d/99-nelos-no-core.conf; do
    install -o root -g root -m 0644 /dev/null "$target"
    cat >"$target" <<'EOF'
[Manager]
DefaultLimitCORE=0
EOF
  done
  install -o root -g root -m 0644 /dev/null /etc/systemd/coredump.conf.d/99-nelos-no-core.conf
  cat >/etc/systemd/coredump.conf.d/99-nelos-no-core.conf <<'EOF'
[Coredump]
Storage=none
ProcessSizeMax=0
ExternalSizeMax=0
EOF
  install -o root -g root -m 0644 /dev/null /etc/sysctl.d/99-nelos-no-core.conf
  cat >/etc/sysctl.d/99-nelos-no-core.conf <<'EOF'
fs.suid_dumpable = 0
kernel.core_pattern = /dev/null
EOF
  install -o root -g root -m 0644 /dev/null /etc/default/apport
  printf 'enabled=0\n' >/etc/default/apport
  sysctl --system >/dev/null
  systemctl daemon-reexec
  systemctl mask --now apport.service apport-autoreport.path apport-autoreport.service systemd-coredump.socket
  systemctl mask 'systemd-coredump@.service'
  [[ $(cat /proc/sys/fs/suid_dumpable) == 0 && $(cat /proc/sys/kernel/core_pattern) == /dev/null ]]
  [[ $(systemctl show --property DefaultLimitCORE --value) == 0 ]]
  [[ $(cat /etc/security/limits.d/99-nelos-no-core.conf) == $'* soft core 0\n* hard core 0\nroot soft core 0\nroot hard core 0' ]]
  [[ $(cat /etc/systemd/system.conf.d/99-nelos-no-core.conf) == $'[Manager]\nDefaultLimitCORE=0' &&
     $(cat /etc/systemd/user.conf.d/99-nelos-no-core.conf) == $'[Manager]\nDefaultLimitCORE=0' ]]
  [[ $(cat /etc/systemd/coredump.conf.d/99-nelos-no-core.conf) == $'[Coredump]\nStorage=none\nProcessSizeMax=0\nExternalSizeMax=0' ]]
  [[ $(cat /etc/sysctl.d/99-nelos-no-core.conf) == $'fs.suid_dumpable = 0\nkernel.core_pattern = /dev/null' && $(cat /etc/default/apport) == enabled=0 ]]
  for unit in apport.service apport-autoreport.path apport-autoreport.service systemd-coredump.socket 'systemd-coredump@.service'; do
    [[ -L /etc/systemd/system/${unit} && $(readlink "/etc/systemd/system/${unit}") == /dev/null ]]
  done
}
readonly recipe_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
readonly auth_src="${recipe_dir}/../helpers/device-auth.sh"
readonly atspi_src="${recipe_dir}/../helpers/nelos-desktop-atspi.mjs"
readonly archive_src="${recipe_dir}/../helpers/nelos-desktop-archive.mjs"
readonly atspi_control_src="${recipe_dir}/../helpers/nelos-atspi-control"
readonly archive_control_src="${recipe_dir}/../helpers/nelos-archive-control"
readonly bind_src="${recipe_dir}/../helpers/nelos-bind-runtime"
readonly credential_boundary_src="${recipe_dir}/../helpers/nelos-credential-boundary"
readonly auth_controller_src="${recipe_dir}/../helpers/nelos-device-auth-controller.mjs"
readonly identity_src="${recipe_dir}/../helpers/nelos-desktop-identity.py"
readonly guest_task_src="${recipe_dir}/../helpers/nelos-guest-task-control.mjs"
readonly package_lock_src="${recipe_dir}/../../../proxmox-desktop/v1/package-lock.json"
readonly desktop_deb="${NELOS_CODEX_DESKTOP_DEB:?set NELOS_CODEX_DESKTOP_DEB to the immutable Linux Desktop .deb}"
readonly desktop_sha256="${NELOS_CODEX_DESKTOP_SHA256:?set NELOS_CODEX_DESKTOP_SHA256}"
for asset in "${auth_src}" "${auth_controller_src}" "${identity_src}" "${guest_task_src}" "${package_lock_src}" "${atspi_src}" "${archive_src}" "${atspi_control_src}" "${archive_control_src}" "${bind_src}" "${credential_boundary_src}" "${recipe_dir}/check-gui-readiness.sh" "${recipe_dir}/nelos-codex-desktop.service" "${recipe_dir}/nelos-device-auth.service"; do [[ -f ${asset} && ! -L ${asset} ]] || { echo "guest helper unavailable: ${asset}" >&2; exit 70; }; done
[[ -f ${desktop_deb} && ! -L ${desktop_deb} && ${desktop_sha256} =~ ^[0-9a-f]{64}$ ]] || { echo "Desktop artifact is unavailable or unsealed" >&2; exit 70; }
printf '%s  %s\n' "${desktop_sha256}" "${desktop_deb}" | sha256sum --check --strict -

export DEBIAN_FRONTEND=noninteractive
install -o root -g root -m 0644 "${recipe_dir}/ubuntu.sources" /etc/apt/sources.list.d/ubuntu.sources
apt-get update
apt-get install -y --no-install-recommends \
  at-spi2-core dbus-x11 gdm3 gnome-session gnome-shell imagemagick jq libatk-adaptor \
  python3-dbus python3-gi python3-pyatspi scrot xauth xdotool
for command in convert findmnt identify import mount readlink swapon sysctl systemctl umount; do command -v "${command}" >/dev/null || { echo "guest dependency unavailable: ${command}" >&2; exit 70; }; done
MAGICK_MEMORY_LIMIT=16MiB MAGICK_MAP_LIMIT=0 MAGICK_DISK_LIMIT=0 MAGICK_TMPDIR=/run \
  convert -limit memory 16MiB -limit map 0 -limit disk 0 -size 1x1 xc:black null: || {
    echo "ImageMagick cannot enforce memory-only capture limits" >&2
    exit 70
  }
readonly locked_desktop_sha256="$(jq -er '.artifacts.chatgptDesktop.digest | sub("^sha256:"; "")' "${package_lock_src}")"
[[ ${desktop_sha256} == "${locked_desktop_sha256}" ]] || { echo "Desktop artifact digest differs from the immutable package lock" >&2; exit 77; }
apt-get install -y "${desktop_deb}"
command -v chatgpt >/dev/null
readonly bundled_codex=/usr/lib/chatgpt/resources/codex
readonly bundled_node=/usr/lib/chatgpt/resources/cua_node/bin/node
for runtime in "${bundled_codex}" "${bundled_node}"; do
  [[ -f ${runtime} && ! -L ${runtime} && -x ${runtime} && $(stat -c '%u:%g' "${runtime}") == 0:0 ]]
  runtime_mode="$(stat -c '%a' "${runtime}")"
  (( (8#${runtime_mode} & 8#022) == 0 ))
done
printf '%s  %s\n' f13176129580681cf3024192f1ad43535c9933b24b7eca89e90fa57b3f4855fc "${bundled_codex}" | sha256sum --check --strict -
printf '%s  %s\n' bc17c508ffeed0ec622934f9b7fa72f8e78da65350e63c3eceb56fa688aa5e12 "${bundled_node}" | sha256sum --check --strict -
[[ $("${bundled_codex}" --version) == "codex-cli 0.148.0-alpha.15" ]]
[[ $("${bundled_node}" --version) == "v24.19.0" ]]
install_and_attest_no_core_policy

id nelosauto >/dev/null 2>&1 || useradd --create-home --shell /bin/bash nelosauto
passwd --lock nelosauto
install -d -o root -g root -m 0755 /usr/libexec
install -d -o root -g root -m 0755 /opt/nelos-desktop
install -o root -g root -m 0444 "${package_lock_src}" /opt/nelos-desktop/package-lock.json
install -o root -g root -m 0755 "${identity_src}" /usr/libexec/nelos-desktop-identity
identity_bake="$(/usr/libexec/nelos-desktop-identity bake "${desktop_deb}")"
jq -e 'keys == ["bakeDigest","kind","schemaVersion"] and .schemaVersion == 1 and .kind == "nelos-desktop-bake-complete" and (.bakeDigest | test("^sha256:[0-9a-f]{64}$"))' <<<"${identity_bake}" >/dev/null
install -o root -g root -m 0750 "${auth_src}" /usr/libexec/nelos-device-auth
install -o root -g root -m 0755 "${auth_controller_src}" /usr/libexec/nelos-device-auth-controller
install -o root -g root -m 0755 "${atspi_src}" /usr/libexec/nelos-desktop-atspi
install -o root -g root -m 0755 "${archive_src}" /usr/libexec/nelos-desktop-archive
install -o root -g root -m 0755 "${guest_task_src}" /usr/libexec/nelos-guest-task-control
install -o root -g root -m 0755 "${atspi_control_src}" /usr/libexec/nelos-atspi-control
install -o root -g root -m 0755 "${archive_control_src}" /usr/libexec/nelos-archive-control
install -o root -g root -m 0750 "${bind_src}" /usr/libexec/nelos-bind-runtime
install -o root -g root -m 0750 "${credential_boundary_src}" /usr/libexec/nelos-credential-boundary
install -o root -g root -m 0755 "${recipe_dir}/check-gui-readiness.sh" /usr/libexec/nelos-check-gui-readiness
install -d -o root -g root -m 0755 /etc/systemd/user
install -o root -g root -m 0644 "${recipe_dir}/nelos-codex-desktop.service" /etc/systemd/user/nelos-codex-desktop.service
install -o root -g root -m 0644 "${recipe_dir}/nelos-device-auth.service" /etc/systemd/system/nelos-device-auth.service
install -d -o root -g root -m 0750 /etc/nelos-desktop /var/lib/nelos-desktop /var/lib/nelos-desktop/observations

install -o root -g root -m 0644 /dev/null /etc/gdm3/custom.conf
sed -i '/^\[daemon\]/,$d' /etc/gdm3/custom.conf
cat >>/etc/gdm3/custom.conf <<'EOF'
[daemon]
AutomaticLoginEnable=true
AutomaticLogin=nelosauto
WaylandEnable=false

[security]

[xdmcp]

[chooser]

[debug]
Enable=false
EOF

install -d -o nelosauto -g nelosauto -m 0700 /home/nelosauto/.config/autostart
install -o root -g root -m 0644 "${recipe_dir}/nelos-accessibility.desktop" /home/nelosauto/.config/autostart/nelos-accessibility.desktop
chown -R nelosauto:nelosauto /home/nelosauto/.config

install -o root -g root -m 0644 "${recipe_dir}/nelos-desktop-session.service" /etc/systemd/system/nelos-desktop-session.service
systemctl enable gdm3.service
swapoff --all
sed -i -E '/^[[:space:]]*#/!{/^[^[:space:]]+[[:space:]]+[^[:space:]]+[[:space:]]+swap([[:space:]]|$)/d;}' /etc/fstab
[[ -z $(swapon --noheadings --show=NAME) ]]
systemctl mask sleep.target suspend.target hibernate.target hybrid-sleep.target
