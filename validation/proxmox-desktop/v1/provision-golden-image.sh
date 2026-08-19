#!/usr/bin/env bash
set -Eeuo pipefail

die() { printf 'error: %s\n' "$*" >&2; exit 1; }
[[ ${EUID} -eq 0 ]] || die "golden-image provisioning requires root"
: "${PACKAGE_LOCK:?PACKAGE_LOCK is required}"
[[ -f $PACKAGE_LOCK && ! -L $PACKAGE_LOCK ]] || die "package lock is missing or unsafe"

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
find "$verify_root" -depth -delete

install -d -o root -g root -m 0755 /opt/nelos-desktop
install -o root -g root -m 0444 "$PACKAGE_LOCK" /opt/nelos-desktop/package-lock.json
systemctl enable qemu-guest-agent.service gdm3.service
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
