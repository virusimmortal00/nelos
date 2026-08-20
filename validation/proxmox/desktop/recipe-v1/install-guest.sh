#!/usr/bin/env bash
set -euo pipefail
umask 027

[[ ${EUID} -eq 0 ]] || { echo "install-guest.sh must run as root" >&2; exit 70; }
readonly recipe_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
readonly helper_src="${recipe_dir}/../helpers/nelos-guest-helper"
readonly auth_src="${recipe_dir}/../helpers/device-auth.sh"
readonly desktop_deb="${NELOS_CODEX_DESKTOP_DEB:?set NELOS_CODEX_DESKTOP_DEB to the immutable Linux Desktop .deb}"
readonly desktop_sha256="${NELOS_CODEX_DESKTOP_SHA256:?set NELOS_CODEX_DESKTOP_SHA256}"
[[ -f ${helper_src} && ! -L ${helper_src} && -f ${auth_src} && ! -L ${auth_src} ]] || { echo "guest helpers unavailable" >&2; exit 70; }
[[ -f ${desktop_deb} && ! -L ${desktop_deb} && ${desktop_sha256} =~ ^[0-9a-f]{64}$ ]] || { echo "Desktop artifact is unavailable or unsealed" >&2; exit 70; }
printf '%s  %s\n' "${desktop_sha256}" "${desktop_deb}" | sha256sum --check --strict -

export DEBIAN_FRONTEND=noninteractive
install -o root -g root -m 0644 "${recipe_dir}/ubuntu.sources" /etc/apt/sources.list.d/ubuntu.sources
apt-get update
apt-get install -y --no-install-recommends \
  at-spi2-core dbus-x11 gdm3 gnome-session gnome-shell jq libatk-adaptor \
  python3-dbus python3-gi scrot xauth xdotool
apt-get install -y "${desktop_deb}"
command -v codex >/dev/null

id nelos-automation >/dev/null 2>&1 || useradd --create-home --shell /bin/bash nelos-automation
passwd --lock nelos-automation
install -o root -g root -m 0755 "${helper_src}" /usr/local/libexec/nelos-guest-helper
install -o root -g root -m 0750 "${auth_src}" /usr/local/libexec/nelos-device-auth
install -d -o root -g root -m 0750 /etc/nelos-desktop /var/lib/nelos-desktop

install -o root -g root -m 0644 /dev/null /etc/gdm3/custom.conf
sed -i '/^\[daemon\]/,$d' /etc/gdm3/custom.conf
cat >>/etc/gdm3/custom.conf <<'EOF'
[daemon]
AutomaticLoginEnable=true
AutomaticLogin=nelos-automation
WaylandEnable=false

[security]

[xdmcp]

[chooser]

[debug]
Enable=false
EOF

install -d -o nelos-automation -g nelos-automation -m 0700 /home/nelos-automation/.config/autostart
install -o root -g root -m 0644 "${recipe_dir}/nelos-accessibility.desktop" /home/nelos-automation/.config/autostart/nelos-accessibility.desktop
chown -R nelos-automation:nelos-automation /home/nelos-automation/.config

install -o root -g root -m 0644 "${recipe_dir}/nelos-desktop-session.service" /etc/systemd/system/nelos-desktop-session.service
systemctl enable gdm3.service nelos-desktop-session.service
