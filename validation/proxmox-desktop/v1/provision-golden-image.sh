#!/usr/bin/env bash
set -Eeuo pipefail

die() { printf 'error: %s\n' "$*" >&2; exit 1; }
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
  [[ $(cat /proc/sys/fs/suid_dumpable) == 0 && $(cat /proc/sys/kernel/core_pattern) == /dev/null ]] || die "kernel no-core policy did not converge"
  [[ $(systemctl show --property DefaultLimitCORE --value) == 0 ]] || die "systemd no-core default did not converge"
  [[ $(cat /etc/security/limits.d/99-nelos-no-core.conf) == $'* soft core 0\n* hard core 0\nroot soft core 0\nroot hard core 0' ]] || die "PAM no-core policy differs"
  [[ $(cat /etc/systemd/system.conf.d/99-nelos-no-core.conf) == $'[Manager]\nDefaultLimitCORE=0' &&
     $(cat /etc/systemd/user.conf.d/99-nelos-no-core.conf) == $'[Manager]\nDefaultLimitCORE=0' ]] || die "systemd no-core policy differs"
  [[ $(cat /etc/systemd/coredump.conf.d/99-nelos-no-core.conf) == $'[Coredump]\nStorage=none\nProcessSizeMax=0\nExternalSizeMax=0' ]] || die "systemd coredump policy differs"
  [[ $(cat /etc/sysctl.d/99-nelos-no-core.conf) == $'fs.suid_dumpable = 0\nkernel.core_pattern = /dev/null' && $(cat /etc/default/apport) == enabled=0 ]] || die "kernel or Apport no-core policy differs"
  for unit in apport.service apport-autoreport.path apport-autoreport.service systemd-coredump.socket 'systemd-coredump@.service'; do
    [[ -L /etc/systemd/system/${unit} && $(readlink "/etc/systemd/system/${unit}") == /dev/null ]] || die "core collector is not masked: ${unit}"
  done
}
[[ ${EUID} -eq 0 ]] || die "golden-image provisioning requires root"
: "${PACKAGE_LOCK:?PACKAGE_LOCK is required}"
: "${APT_SOURCES:?APT_SOURCES is required}"
: "${CANDIDATE_RUNTIME_ARCHIVE:?CANDIDATE_RUNTIME_ARCHIVE is required}"
: "${CANDIDATE_RUNTIME_SHA256:?CANDIDATE_RUNTIME_SHA256 is required}"
: "${HELPER_SOURCE_DIR:?HELPER_SOURCE_DIR is required}"
: "${ACCESSIBILITY_AUTOSTART:?ACCESSIBILITY_AUTOSTART is required}"
: "${SESSION_SERVICE:?SESSION_SERVICE is required}"
: "${DESKTOP_USER_SERVICE:?DESKTOP_USER_SERVICE is required}"
: "${DEVICE_AUTH_SERVICE:?DEVICE_AUTH_SERVICE is required}"
: "${READINESS_HELPER:?READINESS_HELPER is required}"
[[ -f $PACKAGE_LOCK && ! -L $PACKAGE_LOCK ]] || die "package lock is missing or unsafe"
[[ -f $APT_SOURCES && ! -L $APT_SOURCES ]] || die "sealed Ubuntu snapshot source is missing or unsafe"
[[ -f $CANDIDATE_RUNTIME_ARCHIVE && ! -L $CANDIDATE_RUNTIME_ARCHIVE && -f $CANDIDATE_RUNTIME_SHA256 && ! -L $CANDIDATE_RUNTIME_SHA256 ]] || die "candidate runtime transport is missing or unsafe"
for helper in nelos-desktop-atspi.mjs nelos-desktop-archive.mjs nelos-atspi-control nelos-archive-control nelos-bind-runtime nelos-credential-boundary device-auth.sh nelos-device-auth-controller.mjs nelos-desktop-identity.py nelos-guest-task-control.mjs; do
  [[ -f ${HELPER_SOURCE_DIR}/${helper} && ! -L ${HELPER_SOURCE_DIR}/${helper} ]] || die "required guest helper is missing or unsafe: ${helper}"
done

candidate_transport_root="$(mktemp -d --tmpdir nelos-candidate-transport.XXXXXX)"
candidate_archive="${candidate_transport_root}/candidate-runtime.tar"
candidate_sidecar="${candidate_transport_root}/candidate-runtime.tar.sha256"
install -o root -g root -m 0400 "$CANDIDATE_RUNTIME_ARCHIVE" "$candidate_archive"
install -o root -g root -m 0400 "$CANDIDATE_RUNTIME_SHA256" "$candidate_sidecar"
(cd "$candidate_transport_root" && sha256sum --check --strict --status candidate-runtime.tar.sha256) || die "candidate runtime transport digest mismatch"
/usr/bin/python3 - "$candidate_archive" <<'PY' || die "candidate runtime archive inventory is unsafe"
import pathlib, sys, tarfile
archive=pathlib.Path(sys.argv[1])
allowed={".codex-plugin",".mcp.json","plugin.json","mcp.json","CHANGELOG.md","README.md","assets","bin","completions","corpus","docs","evals","LICENSE","package.json","scripts","skills","src","validation","distribution-provenance.json"}
seen=set(); total=0
with tarfile.open(archive, "r:") as handle:
    members=handle.getmembers()
    assert 1 <= len(members) <= 20000
    for member in members:
        name=member.name.removeprefix("./")
        if name in {"", "."}: continue
        path=pathlib.PurePosixPath(name)
        assert not path.is_absolute() and ".." not in path.parts and path.parts[0] in allowed and name not in seen
        assert member.isdir() or member.isfile()
        assert member.uid == 0 and member.gid == 0 and not (member.mode & 0o6022)
        if member.isfile():
            total += member.size
            assert member.size <= 33_554_432 and member.mode in {0o444,0o644,0o755}
        seen.add(name)
assert total <= 268_435_456
PY
for asset in "$ACCESSIBILITY_AUTOSTART" "$SESSION_SERVICE" "$DESKTOP_USER_SERVICE" "$DEVICE_AUTH_SERVICE" "$READINESS_HELPER"; do
  [[ -f $asset && ! -L $asset ]] || die "graphical bootstrap asset is missing or unsafe: ${asset}"
done

snapshot="$(jq -er '.policy.aptSnapshot' "$PACKAGE_LOCK")"
[[ $(sed -n 's#^URIs: https://snapshot.ubuntu.com/ubuntu/\([^/]\+\)/$#\1#p' "$APT_SOURCES") == "$snapshot" ]] || die "Ubuntu source snapshot differs from the package lock"
jq -e '
  .schemaVersion == 1 and
  .platform == {distribution:"ubuntu", release:"24.04", architecture:"amd64"} and
  .policy.allowFloatingVersions == false and
  .policy.allowUnsignedArtifacts == false and
  (.artifacts.qga.name == "qemu-guest-agent") and
  (.artifacts.chatgptDesktop.version == "26.814.41957") and
  (.artifacts.chatgptDesktop.bundledCodexPath == "/usr/lib/chatgpt/resources/codex") and
  (.artifacts.chatgptDesktop.bundledCodexDigest == "sha256:f13176129580681cf3024192f1ad43535c9933b24b7eca89e90fa57b3f4855fc") and
  (.artifacts.chatgptDesktop.bundledCodexVersion == "0.148.0-alpha.15") and
  (.artifacts.chatgptDesktop.bundledNodePath == "/usr/lib/chatgpt/resources/cua_node/bin/node") and
  (.artifacts.chatgptDesktop.bundledNodeDigest == "sha256:bc17c508ffeed0ec622934f9b7fa72f8e78da65350e63c3eceb56fa688aa5e12") and
  (.artifacts.chatgptDesktop.bundledNodeVersion == "24.19.0") and
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
find /etc/apt/sources.list.d -mindepth 1 -maxdepth 1 -delete
install -o root -g root -m 0644 "$APT_SOURCES" /etc/apt/sources.list.d/nelos-ubuntu.sources
install -o root -g root -m 0644 /dev/null /etc/apt/sources.list
[[ $(find /etc/apt/sources.list.d -mindepth 1 -maxdepth 1 -printf '%f\n') == "nelos-ubuntu.sources" ]] || die "unsealed APT source remains enabled"
apt-get -o "APT::Snapshot=${snapshot}" -o Acquire::Retries=3 update
locked_deb_root="$(mktemp -d --tmpdir nelos-locked-debs.XXXXXX)"
while IFS=$'\t' read -r name version url digest; do
  [[ $name =~ ^[a-z0-9][a-z0-9+.-]*$ && -n $version && $url == https://snapshot.ubuntu.com/ubuntu/${snapshot}/* && $digest =~ ^[0-9a-f]{64}$ ]] || die "locked Ubuntu package record is invalid"
  package_path="${locked_deb_root}/${name}.deb"
  curl --disable --fail --location --proto '=https' --proto-redir '=https' --tlsv1.2 --output "$package_path" "$url"
  printf '%s  %s\n' "$digest" "$package_path" | sha256sum --check --status || die "locked Ubuntu package digest mismatch: ${name}"
  [[ $(dpkg-deb -f "$package_path" Package) == "$name" && $(dpkg-deb -f "$package_path" Version) == "$version" ]] || die "locked Ubuntu package identity mismatch: ${name}"
done < <(jq -r '[.artifacts.qga, .artifacts.signatureVerifier] + .artifacts.graphicalSession | .[] | [.name,.version,.source,(.digest | sub("^sha256:"; ""))] | @tsv' "$PACKAGE_LOCK")
mapfile -t locked_debs < <(find "$locked_deb_root" -maxdepth 1 -type f -name '*.deb' -print | LC_ALL=C sort)
[[ ${#locked_debs[@]} -eq 5 ]] || die "locked Ubuntu package set is incomplete"
apt-get -o "APT::Snapshot=${snapshot}" -o Acquire::Retries=3 install -y --no-install-recommends "${locked_debs[@]}"
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
for command in base64 chatgpt convert findmnt flock identify import jq mount python3 readlink scrot stat swapon sysctl systemctl umount; do command -v "$command" >/dev/null || die "required production command is unavailable: ${command}"; done
bundled_codex="$(jq -er '.artifacts.chatgptDesktop.bundledCodexPath' "$PACKAGE_LOCK")"
bundled_node="$(jq -er '.artifacts.chatgptDesktop.bundledNodePath' "$PACKAGE_LOCK")"
for runtime in "$bundled_codex" "$bundled_node"; do
  [[ -f $runtime && ! -L $runtime && -x $runtime && $(stat -c '%u:%g' "$runtime") == 0:0 ]] || die "bundled runtime ownership, type, or execution mode is unsafe"
  runtime_mode="$(stat -c '%a' "$runtime")"
  (( (8#${runtime_mode} & 8#022) == 0 )) || die "bundled runtime mode is unsafe"
done
printf '%s  %s\n' "$(jq -er '.artifacts.chatgptDesktop.bundledCodexDigest | sub("^sha256:"; "")' "$PACKAGE_LOCK")" "$bundled_codex" | sha256sum --check --status || die "bundled Codex digest mismatch"
printf '%s  %s\n' "$(jq -er '.artifacts.chatgptDesktop.bundledNodeDigest | sub("^sha256:"; "")' "$PACKAGE_LOCK")" "$bundled_node" | sha256sum --check --status || die "bundled Node digest mismatch"
[[ $($bundled_codex --version) == "codex-cli $(jq -er '.artifacts.chatgptDesktop.bundledCodexVersion' "$PACKAGE_LOCK")" ]] || die "bundled Codex version mismatch"
[[ $($bundled_node --version) == "v$(jq -er '.artifacts.chatgptDesktop.bundledNodeVersion' "$PACKAGE_LOCK")" ]] || die "bundled Node version mismatch"
install_and_attest_no_core_policy
/usr/bin/python3 -c 'import pyatspi' || die "Python AT-SPI binding is unavailable"
find "$verify_root" -depth -delete
find "$locked_deb_root" -depth -delete

install -d -o root -g root -m 0755 /opt/nelos-desktop
candidate_extract_root="$(mktemp -d /opt/nelos-desktop/.candidate.XXXXXX)"
tar --extract --file "$candidate_archive" --directory "$candidate_extract_root" --no-same-owner --no-same-permissions
chown -R root:root "$candidate_extract_root"
find "$candidate_extract_root" -xdev -type d -exec chmod 0755 {} +
find "$candidate_extract_root" -xdev -type f -perm /022 -print -quit | grep -q . && die "candidate runtime contains a group/world-writable file"
candidate_root=/opt/nelos-desktop/nelos
[[ ! -e $candidate_root && ! -L $candidate_root ]] || die "candidate runtime target already exists"
mv "$candidate_extract_root" "$candidate_root"
candidate_integrity="$($bundled_node --input-type=module - "$candidate_root" <<'NODE'
import { lstat, readdir } from "node:fs/promises";
import { join, relative } from "node:path";
const root=process.argv[2];
const module=await import(`file://${root}/src/distribution-provenance.mjs`);
const provenance=await module.readRequiredProvenance(join(root,"distribution-provenance.json"));
const expected=new Set(await module.listDistributionFiles(root,{includeProvenance:true}));
const actual=[];
async function walk(path){for(const entry of await readdir(path,{withFileTypes:true})){const target=join(path,entry.name); const info=await lstat(target); if(info.isSymbolicLink()) throw new Error("symlink"); if(info.isDirectory()) await walk(target); else if(info.isFile()) actual.push(relative(root,target).split("\\").join("/")); else throw new Error("unsupported entry");}}
await walk(root); actual.sort();
if(actual.length!==expected.size || actual.some((path)=>!expected.has(path))) throw new Error("candidate inventory differs");
const digest=await module.computeDistributionIntegrity(root);
if(provenance.sourceRevisionType!=="git" || !/^[0-9a-f]{40}$/.test(provenance.sourceRevision??"") || provenance.integrity!==digest) throw new Error("candidate provenance differs");
process.stdout.write(digest);
NODE
)" || die "candidate runtime distribution integrity is invalid"
[[ $candidate_integrity =~ ^sha256:[0-9a-f]{64}$ ]] || die "candidate runtime identity is invalid"
[[ -x $candidate_root/bin/nelos-mcp && ! -L $candidate_root/bin/nelos-mcp ]] || die "candidate MCP entrypoint is missing or unsafe"
for module in production-task-preparation.mjs production-guest-task.mjs production-task-surface-observer.mjs production-archive-surface-observer.mjs mcp-app-server-bridge.mjs; do
  "$bundled_node" --check "$candidate_root/src/$module" >/dev/null || die "candidate guest module syntax is invalid: ${module}"
done
rm -rf -- "$candidate_transport_root"
install -o root -g root -m 0444 "$PACKAGE_LOCK" /opt/nelos-desktop/package-lock.json
install -d -o root -g root -m 0755 /usr/libexec /etc/xdg/autostart
install -o root -g root -m 0755 "${HELPER_SOURCE_DIR}/nelos-desktop-identity.py" /usr/libexec/nelos-desktop-identity
identity_bake="$(/usr/libexec/nelos-desktop-identity bake "$desktop_deb")" || die "installed Desktop identity bake failed"
jq -e 'keys == ["bakeDigest","kind","schemaVersion"] and .schemaVersion == 1 and .kind == "nelos-desktop-bake-complete" and (.bakeDigest | test("^sha256:[0-9a-f]{64}$"))' <<<"$identity_bake" >/dev/null || die "installed Desktop identity bake receipt is invalid"
install -o root -g root -m 0755 "${HELPER_SOURCE_DIR}/nelos-desktop-atspi.mjs" /usr/libexec/nelos-desktop-atspi
install -o root -g root -m 0755 "${HELPER_SOURCE_DIR}/nelos-desktop-archive.mjs" /usr/libexec/nelos-desktop-archive
install -o root -g root -m 0755 "${HELPER_SOURCE_DIR}/nelos-atspi-control" /usr/libexec/nelos-atspi-control
install -o root -g root -m 0755 "${HELPER_SOURCE_DIR}/nelos-archive-control" /usr/libexec/nelos-archive-control
install -o root -g root -m 0750 "${HELPER_SOURCE_DIR}/nelos-bind-runtime" /usr/libexec/nelos-bind-runtime
install -o root -g root -m 0750 "${HELPER_SOURCE_DIR}/nelos-credential-boundary" /usr/libexec/nelos-credential-boundary
install -o root -g root -m 0750 "${HELPER_SOURCE_DIR}/device-auth.sh" /usr/libexec/nelos-device-auth
install -o root -g root -m 0755 "${HELPER_SOURCE_DIR}/nelos-device-auth-controller.mjs" /usr/libexec/nelos-device-auth-controller
install -o root -g root -m 0755 "${HELPER_SOURCE_DIR}/nelos-guest-task-control.mjs" /usr/libexec/nelos-guest-task-control
[[ $(stat -c '%u:%g:%a' /usr/libexec/nelos-guest-task-control) == 0:0:755 ]] || die "guest task helper ownership or mode differs"
[[ $(sed -n '1p' /usr/libexec/nelos-guest-task-control) == '#!/usr/lib/chatgpt/resources/cua_node/bin/node' ]] || die "guest task helper runtime shebang differs"
install -o root -g root -m 0755 "$READINESS_HELPER" /usr/libexec/nelos-check-gui-readiness
install -o root -g root -m 0644 "$ACCESSIBILITY_AUTOSTART" /etc/xdg/autostart/nelos-accessibility.desktop
install -o root -g root -m 0644 "$SESSION_SERVICE" /etc/systemd/system/nelos-desktop-session.service
install -d -o root -g root -m 0755 /etc/systemd/user
install -o root -g root -m 0644 "$DESKTOP_USER_SERVICE" /etc/systemd/user/nelos-codex-desktop.service
install -o root -g root -m 0644 "$DEVICE_AUTH_SERVICE" /etc/systemd/system/nelos-device-auth.service
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
systemctl enable qemu-guest-agent.service gdm3.service
systemctl set-default graphical.target

# Authentication state is permitted only on the run-scoped tmpfs mounted by
# nelos-credential-boundary. Disable every disk-backed swap activation path so
# credential pages cannot be paged into the disposable VM disk.
swapoff --all
sed -i -E '/^[[:space:]]*#/!{/^[^[:space:]]+[[:space:]]+[^[:space:]]+[[:space:]]+swap([[:space:]]|$)/d;}' /etc/fstab
[[ -z $(swapon --noheadings --show=NAME) ]] || die "active swap remains enabled in the golden image"
systemctl mask sleep.target suspend.target hibernate.target hybrid-sleep.target

# The template intentionally contains no benchmark account, password, token,
# developer SSH key, browser profile, ChatGPT profile, or writable run state.
getent passwd nelosauto >/dev/null && die "automation account must be clone-created, not baked"
find /root /home -xdev -type f -name authorized_keys -delete
find /root /home -xdev -type f -name authorized_keys -print -quit | grep -q . && \
  die "SSH authorization state could not be removed from the golden image"
find /root /home -xdev -type f \( -name '*.token' -o -name 'Cookies' \) -print -quit | grep -q . && \
  die "credential-like state is present in the golden image"
cloud-init clean --logs --seed
dpkg-query -W -f='${binary:Package}\t${Version}\n' | LC_ALL=C sort > /opt/nelos-desktop/installed-packages.tsv
chmod 0444 /opt/nelos-desktop/installed-packages.tsv
sha256sum /opt/nelos-desktop/installed-packages.tsv | awk '{print "sha256:" $1}' > /opt/nelos-desktop/installed-packages.sha256
chmod 0444 /opt/nelos-desktop/installed-packages.sha256
rm -f /etc/machine-id
touch /etc/machine-id
sync
