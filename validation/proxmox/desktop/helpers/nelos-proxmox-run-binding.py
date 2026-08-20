#!/usr/bin/python3
"""Install one sealed, least-privilege Proxmox Desktop run binding.

The production path is intentionally root-only.  ``--fake-root`` is an
explicit, marker-gated test harness; it never claims to verify real uid/gid
ownership and never invokes host account tools.
"""

import argparse
import base64
import binascii
import grp
import hashlib
import ipaddress
import json
import os
import pathlib
import pwd
import re
import secrets
import shlex
import stat
import subprocess
import sys


KIND = "nelos.proxmox-desktop.host-run-binding.v1"
RECEIPT_KIND = "nelos.proxmox-desktop.host-run-installation-receipt.v1"
FAKE_MARKER = b"nelos-proxmox-run-binding-fake-root-v1\n"
MAX_JSON_BYTES = 65_536
SAFE_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9._:-]{0,127}\Z")
VMID = re.compile(r"[1-9][0-9]{2,8}\Z")
MAC_ADDRESS = re.compile(r"02(?::[0-9A-F]{2}){5}\Z")
FINGERPRINT = re.compile(r"SHA256:[A-Za-z0-9+/]{43}\Z")
DIGEST = re.compile(r"sha256:[0-9a-f]{64}\Z")
RUN_FIELDS = {
    "automationUser", "fencingToken", "hostId", "imageId", "leaseId",
    "gatewayId", "macAddress", "networkId", "networkPolicyDigest", "providerId", "runId", "stateRoot", "vmId",
}
LEASE_AUTHORITY_FIELDS = {
    "authorityId", "epoch", "issuedRecordDigest", "issuedRecordFileDigest", "issuedRevision", "trustDigest",
}
PROVIDER_USER = "nelos-provider"
ATTESTOR_USER = "nelos-attestor"
PROVIDER_HOME = "/var/lib/nelos-proxmox-provider"
ATTESTOR_HOME = "/var/lib/nelos-proxmox-attestor"
PROVIDER_HELPER = "/usr/libexec/nelos-proxmox-transport"
ATTESTOR_HELPER = "/usr/libexec/nelos-proxmox-attest"
LEASE_AUTHORITY_HELPER = "/usr/libexec/nelos-proxmox-lease-authority"
RECEIPT_PATH = "/etc/nelos-desktop/operator-receipt.json"
CLEANUP_ROOT = "/var/lib/nelos-proxmox-run-binding-cleanup"
CLEANUP_INTENT_KIND = "nelos.proxmox-desktop.host-run-cleanup-intent.v1"
CLEANUP_RECEIPT_KIND = "nelos.proxmox-desktop.host-run-cleanup-receipt.v1"
PRODUCTION_PROVIDER_ID = "proxmox-lab"
PRODUCTION_HOST_ID = "prox2"
PRODUCTION_GATEWAY_ID = "9023"
PRODUCTION_NETWORK_ID = "nelosbld"
ROOT_FILES = {
    "/etc/nelos-desktop/run-binding.json": 0o400,
    "/etc/nelos-desktop/provider.json": 0o400,
    "/etc/nelos-desktop/operator-binding.json": 0o400,
    "/etc/nelos-desktop/lease-authority-binding.json": 0o400,
    "/etc/sudoers.d/nelos-desktop-provider": 0o440,
    "/etc/sudoers.d/nelos-desktop-attestor": 0o440,
}


class BoundaryError(Exception):
    def __init__(self, code, message, exit_code=77):
        super().__init__(message)
        self.code = code
        self.message = message
        self.exit_code = exit_code


def fail(code, message, exit_code=77):
    raise BoundaryError(code, message, exit_code)


def exact(value, names, label):
    if not isinstance(value, dict) or set(value) != set(names):
        fail("INVALID_PACKET", f"{label} fields differ from the closed contract", 65)


def canonical_bytes(value):
    return (json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True) + "\n").encode("utf-8")


def sha256(bytes_value):
    return "sha256:" + hashlib.sha256(bytes_value).hexdigest()


def safe_absolute(value, label):
    if (not isinstance(value, str) or not value.startswith("/") or len(value) > 4096 or
            "\x00" in value or "\n" in value or pathlib.PurePosixPath(value).as_posix() != value or
            ".." in pathlib.PurePosixPath(value).parts):
        fail("INVALID_PACKET", f"{label} must be one normalized absolute path", 65)
    return value


def parse_public_key(value, label):
    if not isinstance(value, str) or "\n" in value or "\r" in value or len(value) > 4096:
        fail("INVALID_PUBLIC_KEY", f"{label} is not one bounded public-key line", 65)
    parts = value.strip().split(None, 2)
    if len(parts) < 2 or parts[0] != "ssh-ed25519":
        fail("INVALID_PUBLIC_KEY", f"{label} must be an ED25519 public key", 65)
    encoded = parts[1]
    if re.fullmatch(r"[A-Za-z0-9+/]+={0,2}", encoded) is None:
        fail("INVALID_PUBLIC_KEY", f"{label} is not canonical base64", 65)
    try:
        blob = base64.b64decode(encoded, validate=True)
    except binascii.Error:
        fail("INVALID_PUBLIC_KEY", f"{label} is not canonical base64", 65)
    if base64.b64encode(blob).decode("ascii") != encoded:
        fail("INVALID_PUBLIC_KEY", f"{label} is not canonical base64", 65)
    key_type = b"ssh-ed25519"
    expected = len(key_type).to_bytes(4, "big") + key_type
    if not blob.startswith(expected) or len(blob) != len(expected) + 4 + 32 or blob[len(expected):len(expected) + 4] != (32).to_bytes(4, "big"):
        fail("INVALID_PUBLIC_KEY", f"{label} has an invalid ED25519 wire encoding", 65)
    fingerprint = "SHA256:" + base64.b64encode(hashlib.sha256(blob).digest()).decode("ascii").rstrip("=")
    return {"encoded": encoded, "fingerprint": fingerprint}


def valid_host(value):
    if not isinstance(value, str) or not 1 <= len(value) <= 253 or any(character in value for character in "\r\n\x00[]"):
        return False
    try:
        ipaddress.ip_address(value)
        return True
    except ValueError:
        return all(re.fullmatch(r"[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?", label) for label in value.rstrip(".").split("."))


def validate_packet(value):
    exact(value, {"access", "controller", "kind", "leaseAuthority", "provider", "runBinding", "schemaVersion"}, "packet")
    if value["schemaVersion"] != 1 or value["kind"] != KIND:
        fail("INVALID_PACKET", "packet identity is unsupported", 65)
    binding = value["runBinding"]
    exact(binding, RUN_FIELDS, "run binding")
    for name in RUN_FIELDS - {"stateRoot", "macAddress", "networkPolicyDigest"}:
        if not isinstance(binding[name], str) or SAFE_ID.fullmatch(binding[name]) is None:
            fail("INVALID_PACKET", f"run binding {name} is invalid", 65)
    if (binding["automationUser"] != "nelosauto" or VMID.fullmatch(binding["vmId"]) is None or
            VMID.fullmatch(binding["gatewayId"]) is None or binding["gatewayId"] == binding["vmId"] or
            MAC_ADDRESS.fullmatch(binding["macAddress"]) is None or DIGEST.fullmatch(binding["networkPolicyDigest"]) is None):
        fail("INVALID_PACKET", "automation user, reserved VMID, gateway, MAC, or network policy is invalid", 65)
    if (binding["providerId"] != PRODUCTION_PROVIDER_ID or binding["hostId"] != PRODUCTION_HOST_ID or
            binding["gatewayId"] != PRODUCTION_GATEWAY_ID or binding["networkId"] != PRODUCTION_NETWORK_ID):
        fail("INVALID_PACKET", "run binding differs from the fixed prox2 gateway VM 9023 and nelosbld VNet lane", 65)
    if binding["stateRoot"] != f"/var/lib/nelos-desktop/runs/{binding['runId']}":
        fail("INVALID_PACKET", "stateRoot is not derived from runId", 65)
    authority = value["leaseAuthority"]
    exact(authority, LEASE_AUTHORITY_FIELDS, "lease authority binding")
    if (not isinstance(authority["authorityId"], str) or SAFE_ID.fullmatch(authority["authorityId"]) is None or
            not isinstance(authority["epoch"], int) or isinstance(authority["epoch"], bool) or authority["epoch"] < 1 or
            not isinstance(authority["issuedRevision"], int) or isinstance(authority["issuedRevision"], bool) or authority["issuedRevision"] < 1 or
            not isinstance(authority["issuedRecordDigest"], str) or DIGEST.fullmatch(authority["issuedRecordDigest"]) is None or
            not isinstance(authority["issuedRecordFileDigest"], str) or DIGEST.fullmatch(authority["issuedRecordFileDigest"]) is None or
            not isinstance(authority["trustDigest"], str) or DIGEST.fullmatch(authority["trustDigest"]) is None):
        fail("INVALID_PACKET", "lease authority identity is invalid", 65)
    provider = value["provider"]
    exact(provider, {"gatewayId", "hostId", "networkId", "networkPolicyDigest", "networkPolicyObserverDigest", "providerId", "sourceTemplateVmId"}, "provider")
    if (provider["hostId"] != binding["hostId"] or provider["providerId"] != binding["providerId"] or
            provider["networkId"] != binding["networkId"] or provider["gatewayId"] != binding["gatewayId"] or
            provider["networkPolicyDigest"] != binding["networkPolicyDigest"] or
            not isinstance(provider["networkPolicyObserverDigest"], str) or DIGEST.fullmatch(provider["networkPolicyObserverDigest"]) is None or
            not isinstance(provider["sourceTemplateVmId"], str) or VMID.fullmatch(provider["sourceTemplateVmId"]) is None or
            provider["sourceTemplateVmId"] in {binding["vmId"], binding["gatewayId"]}):
        fail("INVALID_PACKET", "provider, host, or source template is not bound to the run", 65)
    access = value["access"]
    exact(access, {"attestorPublicKey", "providerPublicKey"}, "access")
    provider_key = parse_public_key(access["providerPublicKey"], "providerPublicKey")
    attestor_key = parse_public_key(access["attestorPublicKey"], "attestorPublicKey")
    if provider_key["fingerprint"] == attestor_key["fingerprint"]:
        fail("INDEPENDENT_ATTESTOR_REQUIRED", "provider and attestor public keys must be distinct")
    controller = value["controller"]
    exact(controller, {
        "attestorIdentityFile", "hostFingerprint", "hostPublicKey", "knownHostsFile",
        "providerIdentityFile", "sshHost", "sshPort",
    }, "controller")
    if not valid_host(controller["sshHost"]):
        fail("INVALID_PACKET", "controller sshHost is invalid", 65)
    if not isinstance(controller["sshPort"], int) or isinstance(controller["sshPort"], bool) or not 1 <= controller["sshPort"] <= 65_535:
        fail("INVALID_PACKET", "controller sshPort is invalid", 65)
    safe_absolute(controller["knownHostsFile"], "knownHostsFile")
    safe_absolute(controller["providerIdentityFile"], "providerIdentityFile")
    safe_absolute(controller["attestorIdentityFile"], "attestorIdentityFile")
    if controller["providerIdentityFile"] == controller["attestorIdentityFile"]:
        fail("INDEPENDENT_ATTESTOR_REQUIRED", "controller identity paths must be distinct")
    host_key = parse_public_key(controller["hostPublicKey"], "hostPublicKey")
    if not isinstance(controller["hostFingerprint"], str) or FINGERPRINT.fullmatch(controller["hostFingerprint"]) is None or host_key["fingerprint"] != controller["hostFingerprint"]:
        fail("HOST_KEY_MISMATCH", "host public key does not produce the pinned fingerprint")
    if host_key["fingerprint"] in {provider_key["fingerprint"], attestor_key["fingerprint"]}:
        fail("INVALID_PUBLIC_KEY", "host and access keys must be distinct", 65)
    return {"packet": value, "providerKey": provider_key, "attestorKey": attestor_key, "hostKey": host_key}


def read_closed_json(path_value, label, sealed=False, fake=False):
    path = pathlib.Path(path_value)
    try:
        info = path.lstat()
        data = path.read_bytes()
    except OSError:
        fail("SEALED_INPUT_UNAVAILABLE", f"{label} is unavailable", 66)
    allowed_modes = {0o400, 0o440} if not fake else {0o400, 0o600}
    expected_uid = 0 if not fake else os.geteuid()
    if (not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_uid != expected_uid or
            (sealed and (info.st_mode & 0o777) not in allowed_modes) or len(data) > MAX_JSON_BYTES):
        fail("UNTRUSTED_INPUT", f"{label} is not a sealed regular file", 66)
    try:
        value = json.loads(data)
    except (UnicodeDecodeError, json.JSONDecodeError):
        fail("INVALID_JSON", f"{label} is not valid JSON", 65)
    if data != canonical_bytes(value):
        fail("NONCANONICAL_INPUT", f"{label} is not canonical JSON", 65)
    return value, data


def root_path(root, absolute):
    return pathlib.Path(root, absolute.lstrip("/")) if root != "/" else pathlib.Path(absolute)


def require_regular(path, mode, uid, gid, label):
    try:
        info = path.lstat()
    except OSError:
        fail("HOST_STATE_MISMATCH", f"{label} is unavailable", 70)
    if (not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_uid != uid or info.st_gid != gid or
            (info.st_mode & 0o777) != mode):
        fail("HOST_STATE_MISMATCH", f"{label} ownership, type, link count, or mode differs", 70)
    return info


def require_directory(path, label, uid, gid, exact_mode=None):
    try:
        info = path.lstat()
    except OSError:
        fail("HOST_STATE_MISMATCH", f"{label} directory is unavailable", 70)
    mode = info.st_mode & 0o777
    if (not stat.S_ISDIR(info.st_mode) or stat.S_ISLNK(info.st_mode) or info.st_uid != uid or info.st_gid != gid or
            (exact_mode is not None and mode != exact_mode) or (exact_mode is None and mode & 0o022)):
        fail("HOST_STATE_MISMATCH", f"{label} directory is not trusted", 70)


def make_directory(path, mode, uid, gid):
    if path.exists() or path.is_symlink():
        require_directory(path, str(path), uid, gid, mode)
        return False
    path.mkdir(mode=mode)
    os.chmod(path, mode, follow_symlinks=False)
    os.chown(path, uid, gid, follow_symlinks=False)
    return True


def exclusive_publish(path, content, mode, uid, gid):
    token = secrets.token_hex(12)
    temporary = path.with_name(f".{path.name}.{token}.tmp")
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    fd = os.open(temporary, flags, mode)
    try:
        os.write(fd, content)
        os.fsync(fd)
        os.fchmod(fd, mode)
        os.fchown(fd, uid, gid)
    finally:
        os.close(fd)
    try:
        os.link(temporary, path, follow_symlinks=False)
    except Exception:
        temporary.unlink(missing_ok=True)
        raise
    temporary.unlink()
    fsync_directory(path.parent)


def fsync_directory(path):
    descriptor = os.open(path, os.O_RDONLY | (getattr(os, "O_DIRECTORY", 0)))
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def unlink_durable(path):
    path.unlink()
    fsync_directory(path.parent)


def forced_key_line(key, user, helper, run_id):
    command = f"/usr/bin/sudo -n -- {helper} request"
    return f'restrict,command="{command}" ssh-ed25519 {key["encoded"]} nelos:{user}:{run_id}\n'.encode("ascii")


def sudoers_line(user, helper):
    return f"{user} ALL=(root) NOPASSWD: {helper} request\n".encode("ascii")


def environment(packet):
    controller = packet["controller"]
    binding = packet["runBinding"]
    template = packet["provider"]["sourceTemplateVmId"]
    common = {
        "SSH_HOST": controller["sshHost"],
        "SSH_PORT": str(controller["sshPort"]),
        "KNOWN_HOSTS": controller["knownHostsFile"],
        "HOST_FINGERPRINT": controller["hostFingerprint"],
        "HOST_ID": binding["hostId"],
        "GATEWAY_ID": binding["gatewayId"],
        "MAC_ADDRESS": binding["macAddress"],
        "NETWORK_ID": binding["networkId"],
        "NETWORK_POLICY_DIGEST": binding["networkPolicyDigest"],
        "PROVIDER_ID": binding["providerId"],
        "SOURCE_TEMPLATE_VM_ID": template,
    }
    result = {f"NELOS_PROXMOX_{name}": value for name, value in common.items()}
    result["NELOS_PROXMOX_SSH_USER"] = PROVIDER_USER
    result["NELOS_PROXMOX_IDENTITY_FILE"] = controller["providerIdentityFile"]
    result.update({f"NELOS_PROXMOX_ATTEST_{name}": value for name, value in common.items()})
    result["NELOS_PROXMOX_ATTEST_SSH_USER"] = ATTESTOR_USER
    result["NELOS_PROXMOX_ATTEST_IDENTITY_FILE"] = controller["attestorIdentityFile"]
    return dict(sorted(result.items()))


def desired_contents(validated):
    packet = validated["packet"]
    binding = packet["runBinding"]
    packet_digest = sha256(canonical_bytes(packet))
    operator = {
        "attestorKeyFingerprint": validated["attestorKey"]["fingerprint"],
        "attestorUser": ATTESTOR_USER,
        "packetSha256": packet_digest,
        "providerKeyFingerprint": validated["providerKey"]["fingerprint"],
        "providerUser": PROVIDER_USER,
        "schemaVersion": 1,
    }
    return {
        "/etc/nelos-desktop/run-binding.json": canonical_bytes(binding),
        "/etc/nelos-desktop/provider.json": canonical_bytes(packet["provider"]),
        "/etc/nelos-desktop/operator-binding.json": canonical_bytes(operator),
        "/etc/nelos-desktop/lease-authority-binding.json": canonical_bytes(packet["leaseAuthority"]),
        "/etc/sudoers.d/nelos-desktop-provider": sudoers_line(PROVIDER_USER, PROVIDER_HELPER),
        "/etc/sudoers.d/nelos-desktop-attestor": sudoers_line(ATTESTOR_USER, ATTESTOR_HELPER),
        f"{PROVIDER_HOME}/.ssh/authorized_keys": forced_key_line(validated["providerKey"], PROVIDER_USER, PROVIDER_HELPER, binding["runId"]),
        f"{ATTESTOR_HOME}/.ssh/authorized_keys": forced_key_line(validated["attestorKey"], ATTESTOR_USER, ATTESTOR_HELPER, binding["runId"]),
    }


def host_plan(validated):
    packet = validated["packet"]
    contents = desired_contents(validated)
    host = packet["controller"]["sshHost"]
    port = packet["controller"]["sshPort"]
    known_host_name = host if port == 22 else f"[{host}]:{port}"
    return {
        "accounts": [
            {"group": PROVIDER_USER, "home": PROVIDER_HOME, "shell": "/bin/sh", "user": PROVIDER_USER},
            {"group": ATTESTOR_USER, "home": ATTESTOR_HOME, "shell": "/bin/sh", "user": ATTESTOR_USER},
        ],
        "artifacts": [
            {"group": "root" if path in ROOT_FILES else (PROVIDER_USER if path.startswith(PROVIDER_HOME) else ATTESTOR_USER),
             "mode": f"{(ROOT_FILES.get(path, 0o600)):04o}", "path": path, "sha256": sha256(content),
             "owner": "root" if path in ROOT_FILES else (PROVIDER_USER if path.startswith(PROVIDER_HOME) else ATTESTOR_USER)}
            for path, content in sorted(contents.items())
        ],
        "directories": [
            {"group": "root", "mode": "0700", "owner": "root", "path": "/etc/nelos-desktop"},
            {"group": PROVIDER_USER, "mode": "0700", "owner": PROVIDER_USER, "path": PROVIDER_HOME},
            {"group": PROVIDER_USER, "mode": "0700", "owner": PROVIDER_USER, "path": PROVIDER_HOME + "/.ssh"},
            {"group": ATTESTOR_USER, "mode": "0700", "owner": ATTESTOR_USER, "path": ATTESTOR_HOME},
            {"group": ATTESTOR_USER, "mode": "0700", "owner": ATTESTOR_USER, "path": ATTESTOR_HOME + "/.ssh"},
        ],
        "controllerEnvironment": environment(packet),
        "knownHostsLine": f"{known_host_name} ssh-ed25519 {validated['hostKey']['encoded']}\n",
        "packetSha256": sha256(canonical_bytes(packet)),
        "receiptPath": RECEIPT_PATH,
        "schemaVersion": 1,
    }


def fake_record_path(root, user):
    return root_path(root, f"/var/lib/nelos-desktop/operator-test-accounts/{user}.json")


def create_account(root, fake, user, home, fake_uid):
    root_uid = os.geteuid() if fake else 0
    root_gid = os.getegid() if fake else 0
    if fake:
        record = fake_record_path(root, user)
        if record.exists() or record.is_symlink():
            fail("CONFLICTING_RUN", f"account {user} already exists")
        make_directory(record.parent.parent, 0o700, root_uid, root_gid) if not record.parent.parent.exists() else require_directory(record.parent.parent, "fake account state", root_uid, root_gid, 0o700)
        make_directory(record.parent, 0o700, root_uid, root_gid)
        value = {"gid": fake_uid, "home": home, "locked": True, "shell": "/bin/sh", "uid": fake_uid, "user": user}
        home_path = root_path(root, home)
        try:
            exclusive_publish(record, canonical_bytes(value), 0o400, root_uid, root_gid)
            make_directory(home_path, 0o700, root_uid, root_gid)
            return value
        except Exception:
            record.unlink(missing_ok=True)
            try:
                home_path.rmdir()
            except OSError:
                pass
            raise
    if any(candidate.pw_name == user for candidate in pwd.getpwall()) or any(candidate.gr_name == user for candidate in grp.getgrall()):
        fail("CONFLICTING_RUN", f"account or group {user} already exists")
    created = False
    home_path = pathlib.Path(home)
    try:
        subprocess.run(["/usr/sbin/useradd", "--system", "--user-group", "--home-dir", home, "--no-create-home", "--shell", "/bin/sh", user], check=True,
                       stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, timeout=30, env={"PATH": "/usr/sbin:/usr/bin:/sbin:/bin"})
        created = True
        subprocess.run(["/usr/sbin/usermod", "--lock", user], check=True, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
                       timeout=30, env={"PATH": "/usr/sbin:/usr/bin:/sbin:/bin"})
        account = pwd.getpwnam(user)
        group = grp.getgrnam(user)
        if account.pw_gid != group.gr_gid or account.pw_dir != home or account.pw_shell != "/bin/sh":
            fail("HOST_STATE_MISMATCH", f"private group for {user} differs", 70)
        home_path.mkdir(mode=0o700)
        os.chown(home_path, account.pw_uid, account.pw_gid)
        os.chmod(home_path, 0o700)
        return {"gid": account.pw_gid, "home": home, "locked": True, "shell": "/bin/sh", "uid": account.pw_uid, "user": user}
    except Exception:
        if home_path.exists() and home_path.is_dir():
            try:
                home_path.rmdir()
            except OSError:
                pass
        if created:
            subprocess.run(["/usr/sbin/userdel", user], check=False, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                           timeout=30, env={"PATH": "/usr/sbin:/usr/bin:/sbin:/bin"})
            if any(candidate.gr_name == user for candidate in grp.getgrall()):
                subprocess.run(["/usr/sbin/groupdel", user], check=False, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                               timeout=30, env={"PATH": "/usr/sbin:/usr/bin:/sbin:/bin"})
        raise


def read_account(root, fake, user):
    if fake:
        record = fake_record_path(root, user)
        uid = os.geteuid()
        gid = os.getegid()
        require_regular(record, 0o400, uid, gid, f"fake account {user}")
        value, _ = read_closed_json(record, f"fake account {user}", sealed=True, fake=True)
        exact(value, {"gid", "home", "locked", "shell", "uid", "user"}, f"fake account {user}")
        return value
    try:
        account = pwd.getpwnam(user)
        group = grp.getgrnam(user)
    except KeyError:
        fail("HOST_STATE_MISMATCH", f"account {user} is unavailable", 70)
    locked = False
    try:
        for line in pathlib.Path("/etc/shadow").read_text(encoding="utf-8").splitlines():
            fields = line.split(":")
            if fields[0] == user:
                locked = fields[1].startswith(("!", "*"))
                break
    except OSError:
        fail("HOST_STATE_MISMATCH", f"password state for {user} is unavailable", 70)
    supplementary = [candidate.gr_name for candidate in grp.getgrall() if user in candidate.gr_mem and candidate.gr_gid != account.pw_gid]
    if account.pw_gid != group.gr_gid or group.gr_mem or supplementary:
        fail("HOST_STATE_MISMATCH", f"private group for {user} differs", 70)
    return {"gid": account.pw_gid, "home": account.pw_dir, "locked": locked, "shell": account.pw_shell, "uid": account.pw_uid, "user": user}


def owner_for(path, accounts, fake):
    if fake or path in ROOT_FILES:
        return (os.geteuid(), os.getegid()) if fake else (0, 0)
    user = PROVIDER_USER if path.startswith(PROVIDER_HOME) else ATTESTOR_USER
    account = next(value for value in accounts if value["user"] == user)
    return account["uid"], account["gid"]


def receipt_for(validated, accounts, contents):
    artifacts = []
    for path, content in sorted(contents.items()):
        owner = "root" if path in ROOT_FILES else (PROVIDER_USER if path.startswith(PROVIDER_HOME) else ATTESTOR_USER)
        artifacts.append({"group": owner, "mode": f"{ROOT_FILES.get(path, 0o600):04o}", "owner": owner, "path": path, "sha256": sha256(content)})
    return {
        "accounts": sorted(accounts, key=lambda value: value["user"]),
        "artifacts": artifacts,
        "attestorKeyFingerprint": validated["attestorKey"]["fingerprint"],
        "directories": [
            {"group": "root", "mode": "0700", "owner": "root", "path": "/etc/nelos-desktop"},
            {"group": PROVIDER_USER, "mode": "0700", "owner": PROVIDER_USER, "path": PROVIDER_HOME},
            {"group": PROVIDER_USER, "mode": "0700", "owner": PROVIDER_USER, "path": PROVIDER_HOME + "/.ssh"},
            {"group": ATTESTOR_USER, "mode": "0700", "owner": ATTESTOR_USER, "path": ATTESTOR_HOME},
            {"group": ATTESTOR_USER, "mode": "0700", "owner": ATTESTOR_USER, "path": ATTESTOR_HOME + "/.ssh"},
        ],
        "kind": RECEIPT_KIND,
        "packetSha256": sha256(canonical_bytes(validated["packet"])),
        "providerKeyFingerprint": validated["providerKey"]["fingerprint"],
        "schemaVersion": 1,
    }


def validate_receipt(value, validated):
    exact(value, {"accounts", "artifacts", "attestorKeyFingerprint", "directories", "kind", "packetSha256", "providerKeyFingerprint", "schemaVersion"}, "receipt")
    if (value["schemaVersion"] != 1 or value["kind"] != RECEIPT_KIND or
            value["packetSha256"] != sha256(canonical_bytes(validated["packet"])) or
            value["providerKeyFingerprint"] != validated["providerKey"]["fingerprint"] or
            value["attestorKeyFingerprint"] != validated["attestorKey"]["fingerprint"]):
        fail("RECEIPT_MISMATCH", "receipt is not bound to the exact packet")
    if (not isinstance(value["accounts"], list) or len(value["accounts"]) != 2 or not isinstance(value["artifacts"], list) or
            not isinstance(value["directories"], list) or len(value["directories"]) != 5):
        fail("RECEIPT_MISMATCH", "receipt collections are invalid")
    return value


def verify_state(root, fake, validated, supplied_receipt=None):
    contents = desired_contents(validated)
    installed_path = root_path(root, RECEIPT_PATH)
    installed, installed_bytes = read_closed_json(installed_path, "installed receipt", sealed=True, fake=fake)
    validate_receipt(installed, validated)
    if supplied_receipt is not None and canonical_bytes(supplied_receipt) != installed_bytes:
        fail("RECEIPT_MISMATCH", "supplied receipt differs byte-for-byte from the installed receipt")
    accounts = [read_account(root, fake, PROVIDER_USER), read_account(root, fake, ATTESTOR_USER)]
    expected_receipt = receipt_for(validated, accounts, contents)
    if installed != expected_receipt:
        fail("RECEIPT_MISMATCH", "installed receipt differs from current account identities")
    root_uid, root_gid = ((os.geteuid(), os.getegid()) if fake else (0, 0))
    require_directory(root_path(root, "/etc/nelos-desktop"), "/etc/nelos-desktop", root_uid, root_gid, 0o700)
    require_directory(root_path(root, "/etc/sudoers.d"), "/etc/sudoers.d", root_uid, root_gid)
    for account in accounts:
        if (account["home"] not in {PROVIDER_HOME, ATTESTOR_HOME} or account["shell"] != "/bin/sh" or account["locked"] is not True or
                not isinstance(account["uid"], int) or isinstance(account["uid"], bool) or not isinstance(account["gid"], int) or isinstance(account["gid"], bool)):
            fail("HOST_STATE_MISMATCH", f"account {account['user']} differs from the sealed identity", 70)
        uid, gid = ((os.geteuid(), os.getegid()) if fake else (account["uid"], account["gid"]))
        require_directory(root_path(root, account["home"]), account["home"], uid, gid, 0o700)
        require_directory(root_path(root, account["home"] + "/.ssh"), account["home"] + "/.ssh", uid, gid, 0o700)
    if {artifact["path"] for artifact in installed["artifacts"]} != set(contents):
        fail("RECEIPT_MISMATCH", "receipt artifact inventory differs")
    for path, expected in contents.items():
        artifact = next(item for item in installed["artifacts"] if item["path"] == path)
        exact(artifact, {"group", "mode", "owner", "path", "sha256"}, "receipt artifact")
        mode = ROOT_FILES.get(path, 0o600)
        uid, gid = owner_for(path, accounts, fake)
        physical = root_path(root, path)
        require_regular(physical, mode, uid, gid, path)
        if physical.read_bytes() != expected or artifact["sha256"] != sha256(expected):
            fail("HOST_STATE_MISMATCH", f"{path} content differs", 70)
    receipt_uid, receipt_gid = ((os.geteuid(), os.getegid()) if fake else (0, 0))
    require_regular(installed_path, 0o400, receipt_uid, receipt_gid, RECEIPT_PATH)
    helper = root_path(root, LEASE_AUTHORITY_HELPER)
    command = ([sys.executable, str(helper), "observe-bound", "--fake-root", root]
               if fake else [str(helper), "observe-bound"])
    try:
        completed = subprocess.run(
            command,
            check=True,
            stdin=subprocess.DEVNULL,
            capture_output=True,
            timeout=30,
            env={"PATH": "/usr/sbin:/usr/bin:/sbin:/bin"},
        )
        observed = json.loads(completed.stdout)
    except (OSError, subprocess.SubprocessError, UnicodeDecodeError, json.JSONDecodeError):
        fail("LEASE_AUTHORITY_MISMATCH", "independent current lease does not admit this host binding", 70)
    authority = validated["packet"]["leaseAuthority"]
    if (completed.stderr or observed.get("authorityId") != authority["authorityId"] or
            observed.get("trustDigest") != authority["trustDigest"] or
            observed.get("record", {}).get("epoch") != authority["epoch"] or
            observed.get("record", {}).get("revision", 0) < authority["issuedRevision"]):
        fail("LEASE_AUTHORITY_MISMATCH", "lease authority observation differs from the host packet", 70)
    return installed, installed_bytes, accounts, contents


def require_runtime(root, fake):
    uid, gid = ((os.geteuid(), os.getegid()) if fake else (0, 0))
    for helper in (PROVIDER_HELPER, ATTESTOR_HELPER, LEASE_AUTHORITY_HELPER):
        require_regular(root_path(root, helper), 0o750, uid, gid, helper)
    if not fake:
        for executable in ("/usr/sbin/useradd", "/usr/sbin/usermod", "/usr/sbin/userdel", "/usr/sbin/groupdel", "/usr/sbin/visudo", "/usr/bin/sudo"):
            path = pathlib.Path(executable)
            try:
                info = path.lstat()
            except OSError:
                fail("HOST_STATE_MISMATCH", f"{executable} is unavailable", 70)
            if (not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_uid != 0 or info.st_gid != 0 or
                    not info.st_mode & stat.S_IXUSR or info.st_mode & 0o022):
                fail("HOST_STATE_MISMATCH", f"{executable} is not a trusted root executable", 70)


def prepare_dirs(root, fake):
    uid, gid = ((os.geteuid(), os.getegid()) if fake else (0, 0))
    for base in ("/etc", "/var", "/var/lib", "/usr", "/usr/libexec"):
        physical = root_path(root, base)
        if not physical.exists():
            physical.mkdir(mode=0o755)
            os.chown(physical, uid, gid)
        require_directory(physical, base, uid, gid)
    sudoers = root_path(root, "/etc/sudoers.d")
    if not sudoers.exists():
        sudoers.mkdir(mode=0o750)
        os.chown(sudoers, uid, gid)
    require_directory(sudoers, "/etc/sudoers.d", uid, gid)
    etc_nelos = root_path(root, "/etc/nelos-desktop")
    if not etc_nelos.exists():
        make_directory(etc_nelos, 0o700, uid, gid)
    else:
        require_directory(etc_nelos, "/etc/nelos-desktop", uid, gid, 0o700)


def validate_sudoers(content, directory):
    temporary = directory / f".nelos-sudoers-{secrets.token_hex(12)}.check"
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    fd = os.open(temporary, flags, 0o440)
    try:
        os.write(fd, content)
        os.fsync(fd)
        os.fchmod(fd, 0o440)
        os.fchown(fd, 0, 0)
    finally:
        os.close(fd)
    try:
        subprocess.run(["/usr/sbin/visudo", "-cf", str(temporary)], check=True, stdin=subprocess.DEVNULL,
                       stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, timeout=30, env={"PATH": "/usr/sbin:/usr/bin:/sbin:/bin"})
    finally:
        temporary.unlink(missing_ok=True)


def rollback_install(root, fake, accounts, published):
    for path in reversed(published):
        try:
            root_path(root, path).unlink()
        except OSError:
            pass
    for account in reversed(accounts):
        home = root_path(root, account["home"])
        try:
            (home / ".ssh").rmdir()
        except OSError:
            pass
        try:
            home.rmdir()
        except OSError:
            pass
        try:
            remove_account(root, fake, account)
        except (BoundaryError, OSError, subprocess.SubprocessError):
            pass
    if fake:
        for directory in (
            root_path(root, "/var/lib/nelos-desktop/operator-test-accounts"),
            root_path(root, "/var/lib/nelos-desktop"),
        ):
            try:
                directory.rmdir()
            except OSError:
                pass


def install(root, fake, validated):
    require_runtime(root, fake)
    packet_sha = sha256(canonical_bytes(validated["packet"]))
    _, cleanup_receipt_path, cleanup_uid, cleanup_gid = cleanup_state_paths(root, fake, packet_sha)
    prior_cleanup, _ = read_optional_sealed(cleanup_receipt_path, "cleanup receipt", cleanup_uid, cleanup_gid)
    if prior_cleanup is not None:
        validate_cleanup_receipt(prior_cleanup, packet_sha)
        fail("RUN_TERMINAL", "a terminal cleanup receipt forbids reinstalling this exact run packet", 70)
    installed_receipt = root_path(root, RECEIPT_PATH)
    if installed_receipt.exists() or installed_receipt.is_symlink():
        prepare_dirs(root, fake)
        receipt, receipt_bytes, _, _ = verify_state(root, fake, validated)
        return receipt, receipt_bytes
    managed_paths = set(desired_contents(validated))
    for path in managed_paths:
        physical = root_path(root, path)
        if physical.exists() or physical.is_symlink():
            fail("CONFLICTING_RUN", f"managed path {path} exists without the exact receipt")
    for home in (PROVIDER_HOME, ATTESTOR_HOME):
        physical = root_path(root, home)
        if physical.exists() or physical.is_symlink():
            fail("CONFLICTING_RUN", f"managed home {home} exists without the exact receipt")
    if fake:
        account_conflicts = any(fake_record_path(root, user).exists() or fake_record_path(root, user).is_symlink() for user in (PROVIDER_USER, ATTESTOR_USER))
    else:
        account_conflicts = any(candidate.pw_name in {PROVIDER_USER, ATTESTOR_USER} for candidate in pwd.getpwall()) or any(candidate.gr_name in {PROVIDER_USER, ATTESTOR_USER} for candidate in grp.getgrall())
    if account_conflicts:
        fail("CONFLICTING_RUN", "managed account exists without the exact receipt")
    prepare_dirs(root, fake)
    contents = desired_contents(validated)
    if not fake:
        for path in ("/etc/sudoers.d/nelos-desktop-provider", "/etc/sudoers.d/nelos-desktop-attestor"):
            validate_sudoers(contents[path], root_path(root, "/etc/sudoers.d"))
    accounts = []
    published = []
    try:
        accounts.append(create_account(root, fake, PROVIDER_USER, PROVIDER_HOME, 29_001))
        accounts.append(create_account(root, fake, ATTESTOR_USER, ATTESTOR_HOME, 29_002))
        for account in accounts:
            uid, gid = ((os.geteuid(), os.getegid()) if fake else (account["uid"], account["gid"]))
            make_directory(root_path(root, account["home"] + "/.ssh"), 0o700, uid, gid)
        for path, content in contents.items():
            uid, gid = owner_for(path, accounts, fake)
            exclusive_publish(root_path(root, path), content, ROOT_FILES.get(path, 0o600), uid, gid)
            published.append(path)
        receipt = receipt_for(validated, accounts, contents)
        receipt_bytes = canonical_bytes(receipt)
        uid, gid = ((os.geteuid(), os.getegid()) if fake else (0, 0))
        exclusive_publish(installed_receipt, receipt_bytes, 0o400, uid, gid)
        published.append(RECEIPT_PATH)
        verify_state(root, fake, validated, receipt)
        return receipt, receipt_bytes
    except Exception:
        rollback_install(root, fake, accounts, published)
        raise


def cleanup_effects():
    return [
        "revoke-provider-key", "revoke-attestor-key", "revoke-provider-sudo", "revoke-attestor-sudo",
        "remove-provider-ssh-directory", "remove-attestor-ssh-directory", "remove-provider-home", "remove-attestor-home",
        "remove-provider-account", "remove-attestor-account", "remove-lease-authority-binding", "remove-operator-binding",
        "remove-provider-binding", "remove-run-binding", "remove-installation-receipt", "remove-fake-account-state",
        "remove-empty-binding-directory", "confirm-exact-absence", "publish-cleanup-receipt",
    ]


def validate_cleanup_materials(validated, supplied):
    validate_receipt(supplied, validated)
    contents = desired_contents(validated)
    expected_users = {PROVIDER_USER: PROVIDER_HOME, ATTESTOR_USER: ATTESTOR_HOME}
    if not isinstance(supplied["accounts"], list) or {item.get("user") for item in supplied["accounts"] if isinstance(item, dict)} != set(expected_users):
        fail("RECEIPT_MISMATCH", "cleanup receipt account inventory differs", 70)
    accounts = []
    for account in supplied["accounts"]:
        exact(account, {"gid", "home", "locked", "shell", "uid", "user"}, "cleanup receipt account")
        if (account["home"] != expected_users[account["user"]] or account["shell"] != "/bin/sh" or account["locked"] is not True or
                not isinstance(account["uid"], int) or isinstance(account["uid"], bool) or account["uid"] < 1 or
                not isinstance(account["gid"], int) or isinstance(account["gid"], bool) or account["gid"] < 1):
            fail("RECEIPT_MISMATCH", "cleanup receipt account identity differs", 70)
        accounts.append(account)
    expected_artifacts = receipt_for(validated, accounts, contents)["artifacts"]
    if supplied["artifacts"] != expected_artifacts or supplied["directories"] != receipt_for(validated, accounts, contents)["directories"]:
        fail("RECEIPT_MISMATCH", "cleanup receipt artifact or directory inventory differs", 70)
    return sorted(accounts, key=lambda value: value["user"]), contents


def cleanup_state_paths(root, fake, packet_sha):
    directory = root_path(root, CLEANUP_ROOT)
    uid, gid = ((os.geteuid(), os.getegid()) if fake else (0, 0))
    parent = directory.parent
    require_directory(parent, str(parent), uid, gid)
    if directory.exists() or directory.is_symlink():
        require_directory(directory, CLEANUP_ROOT, uid, gid, 0o700)
    stem = packet_sha.removeprefix("sha256:")
    return directory / f"{stem}.intent.json", directory / f"{stem}.receipt.json", uid, gid


def ensure_cleanup_state_directory(path, uid, gid):
    directory = path.parent
    if not directory.exists():
        make_directory(directory, 0o700, uid, gid); fsync_directory(directory.parent)
    else:
        require_directory(directory, CLEANUP_ROOT, uid, gid, 0o700)


def read_optional_sealed(path, label, uid, gid):
    try:
        info = path.lstat()
    except FileNotFoundError:
        return None, None
    if (not stat.S_ISREG(info.st_mode) or stat.S_ISLNK(info.st_mode) or info.st_nlink != 1 or info.st_uid != uid or info.st_gid != gid or
            (info.st_mode & 0o777) != 0o400 or info.st_size > MAX_JSON_BYTES):
        fail("CLEANUP_RECONCILIATION_REQUIRED", f"{label} is not one sealed file", 70)
    data = path.read_bytes()
    try:
        value = json.loads(data)
    except (UnicodeDecodeError, json.JSONDecodeError):
        fail("CLEANUP_RECONCILIATION_REQUIRED", f"{label} is malformed", 70)
    if data != canonical_bytes(value):
        fail("CLEANUP_RECONCILIATION_REQUIRED", f"{label} is not canonical", 70)
    return value, data


def replace_sealed(path, value, uid, gid):
    content = canonical_bytes(value)
    temporary = path.with_name(f".{path.name}.{secrets.token_hex(12)}.replace")
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0)
    fd = os.open(temporary, flags, 0o400)
    try:
        os.write(fd, content); os.fsync(fd); os.fchmod(fd, 0o400); os.fchown(fd, uid, gid)
    finally:
        os.close(fd)
    try:
        os.replace(temporary, path); fsync_directory(path.parent)
    except Exception:
        temporary.unlink(missing_ok=True)
        raise


def cleanup_intent(packet_sha, installation_receipt_sha, completed=None):
    return {
        "completedEffects": list(completed or []), "installationReceiptSha256": installation_receipt_sha,
        "kind": CLEANUP_INTENT_KIND, "packetSha256": packet_sha, "schemaVersion": 1,
    }


def validate_cleanup_intent(value, packet_sha, installation_receipt_sha):
    exact(value, {"completedEffects", "installationReceiptSha256", "kind", "packetSha256", "schemaVersion"}, "cleanup intent")
    effects = cleanup_effects()
    if (value["schemaVersion"] != 1 or value["kind"] != CLEANUP_INTENT_KIND or value["packetSha256"] != packet_sha or
            value["installationReceiptSha256"] != installation_receipt_sha or not isinstance(value["completedEffects"], list) or
            len(value["completedEffects"]) != len(set(value["completedEffects"])) or any(effect not in effects for effect in value["completedEffects"]) or
            [effects.index(effect) for effect in value["completedEffects"]] != sorted(effects.index(effect) for effect in value["completedEffects"])):
        fail("CLEANUP_RECONCILIATION_REQUIRED", "cleanup intent differs from the exact receipt or effect graph", 70)
    return value


def cleanup_receipt(packet_sha, installation_receipt_sha):
    unsigned = {
        "completedEffects": cleanup_effects(), "installationReceiptSha256": installation_receipt_sha,
        "kind": CLEANUP_RECEIPT_KIND, "packetSha256": packet_sha, "removed": True, "schemaVersion": 1,
    }
    return {**unsigned, "receiptSha256": sha256(canonical_bytes(unsigned))}


def validate_cleanup_receipt(value, packet_sha, installation_receipt_sha=None):
    exact(value, {"completedEffects", "installationReceiptSha256", "kind", "packetSha256", "receiptSha256", "removed", "schemaVersion"}, "cleanup receipt")
    receipt_sha = value["receiptSha256"]
    unsigned = {key: child for key, child in value.items() if key != "receiptSha256"}
    if (value["schemaVersion"] != 1 or value["kind"] != CLEANUP_RECEIPT_KIND or value["packetSha256"] != packet_sha or
            (installation_receipt_sha is not None and value["installationReceiptSha256"] != installation_receipt_sha) or
            DIGEST.fullmatch(str(value["installationReceiptSha256"])) is None or value["completedEffects"] != cleanup_effects() or
            value["removed"] is not True or receipt_sha != sha256(canonical_bytes(unsigned))):
        fail("CLEANUP_RECONCILIATION_REQUIRED", "cleanup receipt differs from the exact terminal operation", 70)
    return value


def checkpoint(fake, crash_at, label):
    if fake and crash_at == label:
        fail("SYNTHETIC_CRASH", f"synthetic process death at {label}", 86)


def record_cleanup_effect(path, intent, effect, uid, gid):
    if effect in intent["completedEffects"]:
        return intent
    order = cleanup_effects()
    if any(order.index(item) > order.index(effect) for item in intent["completedEffects"]):
        fail("CLEANUP_RECONCILIATION_REQUIRED", "cleanup effect order is inconsistent", 70)
    intent = {**intent, "completedEffects": [*intent["completedEffects"], effect]}
    replace_sealed(path, intent, uid, gid)
    return intent


def remove_expected_file(path, content, mode, uid, gid, label):
    try:
        path.lstat()
    except FileNotFoundError:
        return
    require_regular(path, mode, uid, gid, label)
    if path.read_bytes() != content:
        fail("HOST_STATE_MISMATCH", f"{label} content differs during cleanup", 70)
    unlink_durable(path)


def remove_expected_directory(path, uid, gid, label):
    try:
        path.lstat()
    except FileNotFoundError:
        return
    require_directory(path, label, uid, gid, 0o700)
    if any(path.iterdir()):
        fail("UNOWNED_HOME_CONTENT", f"{label} contains content not owned by this receipt")
    path.rmdir(); fsync_directory(path.parent)


def optional_account(root, fake, expected):
    user = expected["user"]
    if fake:
        record = fake_record_path(root, user)
        if not record.exists() and not record.is_symlink():
            return None, None
        observed = read_account(root, fake, user)
        return observed, observed
    try:
        account = pwd.getpwnam(user)
    except KeyError:
        account = None
    try:
        group = grp.getgrnam(user)
    except KeyError:
        group = None
    if account is not None:
        observed = read_account(root, fake, user)
        if observed != expected:
            fail("HOST_STATE_MISMATCH", f"account {user} differs during cleanup", 70)
    if group is not None and (group.gr_gid != expected["gid"] or group.gr_mem):
        fail("HOST_STATE_MISMATCH", f"private group for {user} differs during cleanup", 70)
    return account, group


def remove_account(root, fake, account):
    user = account["user"]
    observed, group = optional_account(root, fake, account)
    if fake:
        if observed is not None:
            unlink_durable(fake_record_path(root, user))
        return
    if observed is not None:
        processes = subprocess.run(["/usr/bin/pgrep", "-u", user], check=False, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                   timeout=30, env={"PATH": "/usr/sbin:/usr/bin:/sbin:/bin"})
        if processes.returncode == 0:
            fail("HOST_STATE_MISMATCH", f"account {user} still owns a process", 70)
        if processes.returncode != 1 or processes.stderr:
            fail("HOST_STATE_MISMATCH", f"process ownership for {user} is ambiguous", 70)
        subprocess.run(["/usr/sbin/userdel", user], check=True, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
                       timeout=30, env={"PATH": "/usr/sbin:/usr/bin:/sbin:/bin"})
    try:
        group = grp.getgrnam(user)
    except KeyError:
        group = None
    if group is not None:
        if group.gr_gid != account["gid"] or group.gr_mem:
            fail("HOST_STATE_MISMATCH", f"private group for {user} changed during cleanup", 70)
        subprocess.run(["/usr/sbin/groupdel", user], check=True, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
                       timeout=30, env={"PATH": "/usr/sbin:/usr/bin:/sbin:/bin"})
    remaining, remaining_group = optional_account(root, fake, account)
    if remaining is not None or remaining_group is not None:
        fail("HOST_STATE_MISMATCH", f"account or private group for {user} remains after cleanup", 70)


def verify_cleanup_absence(root, fake, accounts, contents):
    for path in [*contents, RECEIPT_PATH]:
        physical = root_path(root, path)
        if physical.exists() or physical.is_symlink():
            fail("CLEANUP_RECONCILIATION_REQUIRED", f"managed artifact {path} remains after cleanup", 70)
    for account in accounts:
        for path in (root_path(root, account["home"] + "/.ssh"), root_path(root, account["home"])):
            if path.exists() or path.is_symlink():
                fail("CLEANUP_RECONCILIATION_REQUIRED", f"managed directory {path} remains after cleanup", 70)
        observed, group = optional_account(root, fake, account)
        if observed is not None or group is not None:
            fail("CLEANUP_RECONCILIATION_REQUIRED", f"managed account {account['user']} remains after cleanup", 70)


def cleanup(root, fake, validated, supplied_receipt, crash_at=None):
    accounts, contents = validate_cleanup_materials(validated, supplied_receipt)
    packet_sha = supplied_receipt["packetSha256"]
    installation_receipt_sha = sha256(canonical_bytes(supplied_receipt))
    intent_path, terminal_path, uid, gid = cleanup_state_paths(root, fake, packet_sha)
    terminal, _ = read_optional_sealed(terminal_path, "cleanup receipt", uid, gid)
    if terminal is not None:
        validate_cleanup_receipt(terminal, packet_sha, installation_receipt_sha)
        verify_cleanup_absence(root, fake, accounts, contents)
        pending, _ = read_optional_sealed(intent_path, "cleanup intent", uid, gid)
        if pending is not None:
            validate_cleanup_intent(pending, packet_sha, installation_receipt_sha)
            if pending["completedEffects"] not in (cleanup_effects()[:-1], cleanup_effects()):
                fail("CLEANUP_RECONCILIATION_REQUIRED", "cleanup receipt exists beside an incomplete effect journal", 70)
            unlink_durable(intent_path)
        return terminal
    intent, _ = read_optional_sealed(intent_path, "cleanup intent", uid, gid)
    if intent is None:
        checkpoint(fake, crash_at, "before:intent")
        verify_state(root, fake, validated, supplied_receipt)
        ensure_cleanup_state_directory(intent_path, uid, gid)
        intent = cleanup_intent(packet_sha, installation_receipt_sha)
        exclusive_publish(intent_path, canonical_bytes(intent), 0o400, uid, gid)
        checkpoint(fake, crash_at, "after:intent")
    else:
        validate_cleanup_intent(intent, packet_sha, installation_receipt_sha)

    account_by_user = {account["user"]: account for account in accounts}
    # Every restart rechecks that all surviving home content is still receipt-owned.
    for account in accounts:
        home = root_path(root, account["home"]); ssh = home / ".ssh"; key = ssh / "authorized_keys"
        if home.exists() or home.is_symlink():
            uid_value, gid_value = ((os.geteuid(), os.getegid()) if fake else (account["uid"], account["gid"]))
            require_directory(home, account["home"], uid_value, gid_value, 0o700)
            if any(item.name != ".ssh" for item in home.iterdir()):
                fail("UNOWNED_HOME_CONTENT", f"{account['home']} contains content not owned by this receipt")
        if ssh.exists() or ssh.is_symlink():
            uid_value, gid_value = ((os.geteuid(), os.getegid()) if fake else (account["uid"], account["gid"]))
            require_directory(ssh, str(ssh), uid_value, gid_value, 0o700)
            if any(item.name != "authorized_keys" for item in ssh.iterdir()):
                fail("UNOWNED_HOME_CONTENT", f"{account['home']}/.ssh contains content not owned by this receipt")

    operations = {
        "revoke-provider-key": lambda: remove_expected_file(root_path(root, f"{PROVIDER_HOME}/.ssh/authorized_keys"), contents[f"{PROVIDER_HOME}/.ssh/authorized_keys"], 0o600, uid if fake else account_by_user[PROVIDER_USER]["uid"], gid if fake else account_by_user[PROVIDER_USER]["gid"], "provider authorized key"),
        "revoke-attestor-key": lambda: remove_expected_file(root_path(root, f"{ATTESTOR_HOME}/.ssh/authorized_keys"), contents[f"{ATTESTOR_HOME}/.ssh/authorized_keys"], 0o600, uid if fake else account_by_user[ATTESTOR_USER]["uid"], gid if fake else account_by_user[ATTESTOR_USER]["gid"], "attestor authorized key"),
        "revoke-provider-sudo": lambda: remove_expected_file(root_path(root, "/etc/sudoers.d/nelos-desktop-provider"), contents["/etc/sudoers.d/nelos-desktop-provider"], 0o440, uid, gid, "provider sudoers"),
        "revoke-attestor-sudo": lambda: remove_expected_file(root_path(root, "/etc/sudoers.d/nelos-desktop-attestor"), contents["/etc/sudoers.d/nelos-desktop-attestor"], 0o440, uid, gid, "attestor sudoers"),
        "remove-provider-ssh-directory": lambda: remove_expected_directory(root_path(root, PROVIDER_HOME + "/.ssh"), uid if fake else account_by_user[PROVIDER_USER]["uid"], gid if fake else account_by_user[PROVIDER_USER]["gid"], PROVIDER_HOME + "/.ssh"),
        "remove-attestor-ssh-directory": lambda: remove_expected_directory(root_path(root, ATTESTOR_HOME + "/.ssh"), uid if fake else account_by_user[ATTESTOR_USER]["uid"], gid if fake else account_by_user[ATTESTOR_USER]["gid"], ATTESTOR_HOME + "/.ssh"),
        "remove-provider-home": lambda: remove_expected_directory(root_path(root, PROVIDER_HOME), uid if fake else account_by_user[PROVIDER_USER]["uid"], gid if fake else account_by_user[PROVIDER_USER]["gid"], PROVIDER_HOME),
        "remove-attestor-home": lambda: remove_expected_directory(root_path(root, ATTESTOR_HOME), uid if fake else account_by_user[ATTESTOR_USER]["uid"], gid if fake else account_by_user[ATTESTOR_USER]["gid"], ATTESTOR_HOME),
        "remove-provider-account": lambda: remove_account(root, fake, account_by_user[PROVIDER_USER]),
        "remove-attestor-account": lambda: remove_account(root, fake, account_by_user[ATTESTOR_USER]),
        "remove-lease-authority-binding": lambda: remove_expected_file(root_path(root, "/etc/nelos-desktop/lease-authority-binding.json"), contents["/etc/nelos-desktop/lease-authority-binding.json"], 0o400, uid, gid, "lease authority binding"),
        "remove-operator-binding": lambda: remove_expected_file(root_path(root, "/etc/nelos-desktop/operator-binding.json"), contents["/etc/nelos-desktop/operator-binding.json"], 0o400, uid, gid, "operator binding"),
        "remove-provider-binding": lambda: remove_expected_file(root_path(root, "/etc/nelos-desktop/provider.json"), contents["/etc/nelos-desktop/provider.json"], 0o400, uid, gid, "provider binding"),
        "remove-run-binding": lambda: remove_expected_file(root_path(root, "/etc/nelos-desktop/run-binding.json"), contents["/etc/nelos-desktop/run-binding.json"], 0o400, uid, gid, "run binding"),
        "remove-installation-receipt": lambda: remove_expected_file(root_path(root, RECEIPT_PATH), canonical_bytes(supplied_receipt), 0o400, uid, gid, "installation receipt"),
        "remove-fake-account-state": lambda: remove_fake_account_state(root, fake, uid, gid),
        "remove-empty-binding-directory": lambda: remove_empty_binding_directory(root, uid, gid),
        "confirm-exact-absence": lambda: verify_cleanup_absence(root, fake, accounts, contents),
    }
    for effect in cleanup_effects()[:-1]:
        checkpoint(fake, crash_at, f"before:{effect}")
        operations[effect]()
        checkpoint(fake, crash_at, f"after-effect:{effect}")
        intent = record_cleanup_effect(intent_path, intent, effect, uid, gid)
        checkpoint(fake, crash_at, f"after-journal:{effect}")
    effect = "publish-cleanup-receipt"
    checkpoint(fake, crash_at, f"before:{effect}")
    terminal = cleanup_receipt(packet_sha, installation_receipt_sha)
    existing, existing_bytes = read_optional_sealed(terminal_path, "cleanup receipt", uid, gid)
    if existing is None:
        exclusive_publish(terminal_path, canonical_bytes(terminal), 0o400, uid, gid)
    elif existing_bytes != canonical_bytes(terminal):
        fail("CLEANUP_RECONCILIATION_REQUIRED", "existing cleanup receipt differs", 70)
    checkpoint(fake, crash_at, f"after-effect:{effect}")
    intent = record_cleanup_effect(intent_path, intent, effect, uid, gid)
    checkpoint(fake, crash_at, f"after-journal:{effect}")
    checkpoint(fake, crash_at, "before:intent-clear")
    unlink_durable(intent_path)
    checkpoint(fake, crash_at, "after:intent-clear")
    return terminal


def remove_fake_account_state(root, fake, uid, gid):
    if not fake:
        return
    records = root_path(root, "/var/lib/nelos-desktop/operator-test-accounts")
    if records.exists() or records.is_symlink():
        require_directory(records, str(records), uid, gid, 0o700)
        if any(records.iterdir()):
            fail("CLEANUP_RECONCILIATION_REQUIRED", "fake account state remains nonempty", 70)
        records.rmdir(); fsync_directory(records.parent)
    parent = root_path(root, "/var/lib/nelos-desktop")
    if parent.exists() and not any(parent.iterdir()):
        parent.rmdir(); fsync_directory(parent.parent)


def remove_empty_binding_directory(root, uid, gid):
    directory = root_path(root, "/etc/nelos-desktop")
    if not directory.exists() and not directory.is_symlink():
        return
    require_directory(directory, "/etc/nelos-desktop", uid, gid, 0o700)
    if not any(directory.iterdir()):
        directory.rmdir(); fsync_directory(directory.parent)


def execution_root(fake_root):
    if fake_root is None:
        if os.geteuid() != 0:
            fail("ROOT_REQUIRED", "install, check, and cleanup require root", 77)
        return "/", False
    path = pathlib.Path(fake_root)
    if not path.is_absolute() or str(path) == "/":
        fail("INVALID_FAKE_ROOT", "fake root must be one explicit non-root absolute path", 64)
    try:
        info = path.lstat()
        marker = (path / ".nelos-operator-fake-root").read_bytes()
        marker_info = (path / ".nelos-operator-fake-root").lstat()
    except OSError:
        fail("INVALID_FAKE_ROOT", "fake root marker is unavailable", 64)
    if (not stat.S_ISDIR(info.st_mode) or stat.S_ISLNK(info.st_mode) or info.st_uid != os.geteuid() or
            not stat.S_ISREG(marker_info.st_mode) or marker_info.st_uid != os.geteuid() or (marker_info.st_mode & 0o777) not in {0o400, 0o600} or marker != FAKE_MARKER):
        fail("INVALID_FAKE_ROOT", "fake root marker or ownership is invalid", 64)
    return str(path), True


def parser():
    result = argparse.ArgumentParser(prog="nelos-proxmox-run-binding")
    commands = result.add_subparsers(dest="command", required=True)
    for name in ("render", "env", "install", "check", "cleanup"):
        command = commands.add_parser(name)
        command.add_argument("--packet", required=True)
        if name in {"check", "cleanup"}:
            command.add_argument("--receipt", required=True)
        if name in {"install", "check", "cleanup"}:
            command.add_argument("--fake-root")
        if name == "cleanup":
            command.add_argument("--test-crash-at", help=argparse.SUPPRESS)
    return result


def main():
    arguments = parser().parse_args()
    fake_hint = arguments.fake_root is not None if hasattr(arguments, "fake_root") else os.geteuid() != 0
    packet, _ = read_closed_json(arguments.packet, "run packet", sealed=True, fake=fake_hint)
    validated = validate_packet(packet)
    if arguments.command == "render":
        sys.stdout.buffer.write(canonical_bytes(host_plan(validated)))
        return
    if arguments.command == "env":
        for name, value in environment(packet).items():
            print(f"export {name}={shlex.quote(value)}")
        return
    root, fake = execution_root(arguments.fake_root)
    if getattr(arguments, "test_crash_at", None) is not None and not fake:
        fail("INVALID_FAKE_ROOT", "synthetic crash checkpoints require the marker-gated fake root", 64)
    if arguments.command == "install":
        receipt, receipt_bytes = install(root, fake, validated)
        sys.stdout.buffer.write(canonical_bytes({"receipt": receipt, "sha256": sha256(receipt_bytes)}))
        return
    supplied, _ = read_closed_json(arguments.receipt, "supplied receipt", sealed=True, fake=fake)
    validate_receipt(supplied, validated)
    if arguments.command == "check":
        receipt, receipt_bytes, _, _ = verify_state(root, fake, validated, supplied)
        sys.stdout.buffer.write(canonical_bytes({"receipt": receipt, "sha256": sha256(receipt_bytes), "valid": True}))
        return
    sys.stdout.buffer.write(canonical_bytes(cleanup(root, fake, validated, supplied, getattr(arguments, "test_crash_at", None))))


if __name__ == "__main__":
    try:
        main()
    except BoundaryError as error:
        sys.stderr.buffer.write(canonical_bytes({"error": error.code, "message": error.message}))
        raise SystemExit(error.exit_code)
    except (OSError, subprocess.SubprocessError) as error:
        sys.stderr.buffer.write(canonical_bytes({"error": "HOST_OPERATION_FAILED", "message": "bounded host operation failed"}))
        raise SystemExit(70) from error
