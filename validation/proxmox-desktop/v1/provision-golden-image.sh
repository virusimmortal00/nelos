#!/usr/bin/env bash
set -Eeuo pipefail

die() { printf 'error: %s\n' "$*" >&2; exit 1; }
[[ ${EUID} -eq 0 ]] || die "golden-image provisioning requires root"
: "${PACKAGE_LOCK:?PACKAGE_LOCK is required}"
: "${HELPER_SOURCE_DIR:?HELPER_SOURCE_DIR is required}"
: "${ACCESSIBILITY_AUTOSTART:?ACCESSIBILITY_AUTOSTART is required}"
: "${SESSION_SERVICE:?SESSION_SERVICE is required}"
: "${DESKTOP_USER_SERVICE:?DESKTOP_USER_SERVICE is required}"
: "${READINESS_HELPER:?READINESS_HELPER is required}"
[[ -f $PACKAGE_LOCK && ! -L $PACKAGE_LOCK ]] || die "package lock is missing or unsafe"
for helper in nelos-desktop-atspi.mjs nelos-desktop-archive.mjs nelos-atspi-control nelos-archive-control nelos-bind-runtime device-auth.sh; do
  [[ -f ${HELPER_SOURCE_DIR}/${helper} && ! -L ${HELPER_SOURCE_DIR}/${helper} ]] || die "required guest helper is missing or unsafe: ${helper}"
done
[[ -f $ACCESSIBILITY_AUTOSTART && ! -L $ACCESSIBILITY_AUTOSTART && -f $SESSION_SERVICE && ! -L $SESSION_SERVICE ]] || die "graphical bootstrap assets are missing or unsafe"

snapshot="$(jq -er '.policy.aptSnapshot' "$PACKAGE_LOCK")"
jq -e '
  .schemaVersion == 1 and
  .platform == {distribution:"ubuntu", release:"24.04", architecture:"amd64"} and
  .policy.allowFloatingVersions == false and
  .policy.allowUnsignedArtifacts == false and
  (.artifacts.qga.name == "qemu-guest-agent") and
  (.artifacts.chatgptDesktop.version == "26.814.41957") and
  (.artifacts.chatgptDesktop.bundledCodexVersion == "0.148.0-alpha.15") and
  (.artifacts.chatgptDesktop.signatureIdentity == {
    scheme: "debsig-origin-openpgp",
    issuer: "OpenAI",
    subject: "Codex Linux Repository",
    fingerprint: "3BFA0E4AE8B8CC16A2D9BA684A3B4A566C4660E4"
  }) and
  ([.artifacts.ubuntuBase, .artifacts.qga, .artifacts.chatgptDesktop, .artifacts.signatureVerifier] + .artifacts.graphicalSession |
    all(.source | startswith("https://")) and all(.digest | test("^sha256:[0-9a-f]{64}$")))
' "$PACKAGE_LOCK" >/dev/null || die "immutable package lock is invalid"

export DEBIAN_FRONTEND=noninteractive
apt-get -o "APT::Snapshot=${snapshot}" -o Acquire::Retries=3 update
mapfile -t apt_packages < <(jq -r '[.artifacts.qga, .artifacts.signatureVerifier] + .artifacts.graphicalSession | .[].name + "=" + .version' "$PACKAGE_LOCK")
apt-get -o "APT::Snapshot=${snapshot}" -o Acquire::Retries=3 install -y --no-install-recommends "${apt_packages[@]}"
apt-get -o "APT::Snapshot=${snapshot}" -o Acquire::Retries=3 install -y --no-install-recommends \
  dbus-x11 imagemagick jq python3-pyatspi scrot xauth

desktop_url="$(jq -er '.artifacts.chatgptDesktop.source' "$PACKAGE_LOCK")"
desktop_digest="$(jq -er '.artifacts.chatgptDesktop.digest | sub("^sha256:"; "")' "$PACKAGE_LOCK")"
desktop_deb="$(mktemp --tmpdir chatgpt-desktop.XXXXXX.deb)"
trap 'rm -f "$desktop_deb"' EXIT
curl --disable --fail --location --proto '=https' --proto-redir '=https' --tlsv1.2 --output "$desktop_deb" "$desktop_url"
printf '%s  %s\n' "$desktop_digest" "$desktop_deb" | sha256sum --check --status || die "Desktop package digest mismatch"
verify_root="$(mktemp -d --tmpdir nelos-debsig.XXXXXX)"
signing_key="${verify_root}/openai.gpg"
postinst="${verify_root}/postinst"
dpkg-deb --ctrl-tarfile "$desktop_deb" | tar -xOf - ./postinst > "$postinst"
sed -n "s/^SIGNING_KEY_BASE64='\(.*\)'$/\1/p" "$postinst" | base64 -d > "$signing_key"
signing_key_digest="$(jq -er '.artifacts.chatgptDesktop.signingKeyDigest | sub("^sha256:"; "")' "$PACKAGE_LOCK")"
printf '%s  %s\n' "$signing_key_digest" "$signing_key" | sha256sum --check --status || die "Desktop signing key digest mismatch"
signing_fingerprint="$(jq -er '.artifacts.chatgptDesktop.signatureIdentity.fingerprint' "$PACKAGE_LOCK")"
policy_dir="${verify_root}/policies/${signing_fingerprint}"
keyring_dir="${verify_root}/keyrings/${signing_fingerprint}"
install -d -m 0700 "$policy_dir" "$keyring_dir"
install -m 0600 "$signing_key" "${keyring_dir}/openai.gpg"
cat > "${policy_dir}/openai.pol" <<EOF
<?xml version="1.0"?>
<!DOCTYPE Policy SYSTEM "https://www.debian.org/debsig/1.0/policy.dtd">
<Policy xmlns="https://www.debian.org/debsig/1.0/">
  <Origin Name="Codex Linux Repository" id="${signing_fingerprint}" Description="OpenAI ChatGPT Desktop Linux package"/>
  <Selection><Required Type="origin" File="openai.gpg" id="${signing_fingerprint}"/></Selection>
  <Verification MinOptional="0"><Required Type="origin" File="openai.gpg" id="${signing_fingerprint}"/></Verification>
</Policy>
EOF
debsig-verify --policies-dir "${verify_root}/policies" --keyrings-dir "${verify_root}/keyrings" "$desktop_deb" || die "Desktop package signature is invalid"
dpkg -i "$desktop_deb" || apt-get -o "APT::Snapshot=${snapshot}" -f install -y
for command in chatgpt codex convert identify jq python3 scrot; do command -v "$command" >/dev/null || die "required production command is unavailable: ${command}"; done
/usr/bin/python3 -c 'import pyatspi' || die "Python AT-SPI binding is unavailable"
find "$verify_root" -depth -delete

install -d -o root -g root -m 0755 /opt/nelos-desktop
install -o root -g root -m 0444 "$PACKAGE_LOCK" /opt/nelos-desktop/package-lock.json
install -d -o root -g root -m 0755 /usr/libexec /etc/xdg/autostart
install -o root -g root -m 0755 "${HELPER_SOURCE_DIR}/nelos-desktop-atspi.mjs" /usr/libexec/nelos-desktop-atspi
install -o root -g root -m 0755 "${HELPER_SOURCE_DIR}/nelos-desktop-archive.mjs" /usr/libexec/nelos-desktop-archive
install -o root -g root -m 0755 "${HELPER_SOURCE_DIR}/nelos-atspi-control" /usr/libexec/nelos-atspi-control
install -o root -g root -m 0755 "${HELPER_SOURCE_DIR}/nelos-archive-control" /usr/libexec/nelos-archive-control
install -o root -g root -m 0750 "${HELPER_SOURCE_DIR}/nelos-bind-runtime" /usr/libexec/nelos-bind-runtime
install -o root -g root -m 0750 "${HELPER_SOURCE_DIR}/device-auth.sh" /usr/libexec/nelos-device-auth
install -o root -g root -m 0755 "$READINESS_HELPER" /usr/libexec/nelos-check-gui-readiness
install -o root -g root -m 0644 "$ACCESSIBILITY_AUTOSTART" /etc/xdg/autostart/nelos-accessibility.desktop
install -o root -g root -m 0644 "$SESSION_SERVICE" /etc/systemd/system/nelos-desktop-session.service
install -d -o root -g root -m 0755 /etc/systemd/user
install -o root -g root -m 0644 "$DESKTOP_USER_SERVICE" /etc/systemd/user/nelos-codex-desktop.service
install -o root -g root -m 0644 /dev/null /etc/gdm3/custom.conf
cat >/etc/gdm3/custom.conf <<'EOF'
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
systemctl enable qemu-guest-agent.service gdm3.service nelos-desktop-session.service
systemctl --global enable nelos-codex-desktop.service
systemctl set-default graphical.target

# The template intentionally contains no benchmark account, password, token,
# developer SSH key, browser profile, ChatGPT profile, or writable run state.
getent passwd nelosauto >/dev/null && die "automation account must be clone-created, not baked"
find /root /home -xdev -type f \( -name authorized_keys -o -name '*.token' -o -name 'Cookies' \) -print -quit | grep -q . && \
  die "credential-like state is present in the golden image"
cloud-init clean --logs --seed
rm -f /etc/machine-id
touch /etc/machine-id
sync
