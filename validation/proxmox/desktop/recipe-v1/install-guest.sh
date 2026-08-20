#!/usr/bin/env bash
set -euo pipefail
umask 027

[[ ${EUID} -eq 0 ]] || { echo "install-guest.sh must run as root" >&2; exit 70; }
readonly recipe_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
readonly auth_src="${recipe_dir}/../helpers/device-auth.sh"
readonly atspi_src="${recipe_dir}/../helpers/nelos-desktop-atspi.mjs"
readonly archive_src="${recipe_dir}/../helpers/nelos-desktop-archive.mjs"
readonly atspi_control_src="${recipe_dir}/../helpers/nelos-atspi-control"
readonly archive_control_src="${recipe_dir}/../helpers/nelos-archive-control"
readonly bind_src="${recipe_dir}/../helpers/nelos-bind-runtime"
readonly desktop_deb="${NELOS_CODEX_DESKTOP_DEB:?set NELOS_CODEX_DESKTOP_DEB to the immutable Linux Desktop .deb}"
readonly desktop_sha256="${NELOS_CODEX_DESKTOP_SHA256:?set NELOS_CODEX_DESKTOP_SHA256}"
for asset in "${auth_src}" "${atspi_src}" "${archive_src}" "${atspi_control_src}" "${archive_control_src}" "${bind_src}" "${recipe_dir}/check-gui-readiness.sh" "${recipe_dir}/nelos-codex-desktop.service"; do [[ -f ${asset} && ! -L ${asset} ]] || { echo "guest helper unavailable: ${asset}" >&2; exit 70; }; done
[[ -f ${desktop_deb} && ! -L ${desktop_deb} && ${desktop_sha256} =~ ^[0-9a-f]{64}$ ]] || { echo "Desktop artifact is unavailable or unsealed" >&2; exit 70; }
printf '%s  %s\n' "${desktop_sha256}" "${desktop_deb}" | sha256sum --check --strict -

export DEBIAN_FRONTEND=noninteractive
install -o root -g root -m 0644 "${recipe_dir}/ubuntu.sources" /etc/apt/sources.list.d/ubuntu.sources
apt-get update
apt-get install -y --no-install-recommends \
  at-spi2-core dbus-x11 gdm3 gnome-session gnome-shell imagemagick jq libatk-adaptor \
  python3-dbus python3-gi python3-pyatspi scrot xauth xdotool
apt-get install -y "${desktop_deb}"
command -v codex >/dev/null
command -v chatgpt >/dev/null

id nelosauto >/dev/null 2>&1 || useradd --create-home --shell /bin/bash nelosauto
passwd --lock nelosauto
install -d -o root -g root -m 0755 /usr/libexec
install -o root -g root -m 0750 "${auth_src}" /usr/libexec/nelos-device-auth
install -o root -g root -m 0755 "${atspi_src}" /usr/libexec/nelos-desktop-atspi
install -o root -g root -m 0755 "${archive_src}" /usr/libexec/nelos-desktop-archive
install -o root -g root -m 0755 "${atspi_control_src}" /usr/libexec/nelos-atspi-control
install -o root -g root -m 0755 "${archive_control_src}" /usr/libexec/nelos-archive-control
install -o root -g root -m 0750 "${bind_src}" /usr/libexec/nelos-bind-runtime
install -o root -g root -m 0755 "${recipe_dir}/check-gui-readiness.sh" /usr/libexec/nelos-check-gui-readiness
install -d -o root -g root -m 0755 /etc/systemd/user
install -o root -g root -m 0644 "${recipe_dir}/nelos-codex-desktop.service" /etc/systemd/user/nelos-codex-desktop.service
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
systemctl enable gdm3.service nelos-desktop-session.service
systemctl --global enable nelos-codex-desktop.service
