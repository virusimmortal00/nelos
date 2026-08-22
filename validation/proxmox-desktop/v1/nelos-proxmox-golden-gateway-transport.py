#!/usr/bin/python3
"""Forced Proxmox/QGA transport for the nonce-bound golden gateway helper."""

import base64
import binascii
import datetime
import hashlib
import json
import os
import pathlib
import pwd
import re
import stat
import subprocess
import sys
import time


BINDING_PATH = pathlib.Path("/etc/nelos-golden/gateway-transport-binding.json")
HELPER_PATH = pathlib.Path("/usr/libexec/nelos-proxmox-golden-gateway-transport")
GUEST_HELPER = "/usr/libexec/nelos-golden-gateway-policy"
MAX_INPUT = 65_536
MAX_OUTPUT = 1_048_576
SHA256 = re.compile(r"sha256:[0-9a-f]{64}\Z")
FINGERPRINT = re.compile(r"SHA256:[A-Za-z0-9+/]{43}\Z")
ROLE_USER = {"provider": "nelos-golden-gateway-provider", "attestor": "nelos-golden-gateway-attestor"}
ROLE_HOME = {"provider": pathlib.Path("/var/lib/nelos-golden-gateway-provider"), "attestor": pathlib.Path("/var/lib/nelos-golden-gateway-attestor")}
PROVIDER_OPERATIONS = {"preflight", "apply", "observe", "restore"}
ATTESTOR_OPERATIONS = {"confirm-restored"}


class TransportError(Exception):
    def __init__(self, code, message, exit_code=77):
        super().__init__(message)
        self.code = code
        self.message = message
        self.exit_code = exit_code


def fail(code, message, exit_code=77):
    raise TransportError(code, message, exit_code)


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode("utf-8")


def digest(value):
    data = value if isinstance(value, bytes) else canonical(value)
    return "sha256:" + hashlib.sha256(data).hexdigest()


def exact(value, fields, label):
    if not isinstance(value, dict) or set(value) != set(fields):
        fail("INVALID_CONTRACT", f"{label} fields differ", 65)


def parse_time(value, label):
    if not isinstance(value, str):
        fail("INVALID_CONTRACT", f"{label} is invalid", 65)
    try:
        parsed = datetime.datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        fail("INVALID_CONTRACT", f"{label} is invalid", 65)
    if parsed.tzinfo is None:
        fail("INVALID_CONTRACT", f"{label} lacks a timezone", 65)
    return parsed.timestamp()


def public_key_fingerprint(value, label):
    if not isinstance(value, str) or len(value) > 4096 or not value.isascii() or "\n" in value or "\r" in value:
        fail("INVALID_CONTRACT", f"{label} is invalid", 65)
    fields = value.strip().split(None, 2)
    if len(fields) < 2 or fields[0] != "ssh-ed25519" or re.fullmatch(r"[A-Za-z0-9+/]+={0,2}", fields[1]) is None:
        fail("INVALID_CONTRACT", f"{label} is invalid", 65)
    try:
        blob = base64.b64decode(fields[1], validate=True)
    except binascii.Error:
        fail("INVALID_CONTRACT", f"{label} is invalid", 65)
    if len(blob) != 51 or base64.b64encode(blob).decode("ascii") != fields[1]:
        fail("INVALID_CONTRACT", f"{label} is invalid", 65)
    return "SHA256:" + base64.b64encode(hashlib.sha256(blob).digest()).decode("ascii").rstrip("=")


def read_root_json(path, label):
    try:
        info = path.lstat()
        data = path.read_bytes()
    except OSError:
        fail("HOST_BINDING_UNAVAILABLE", f"{label} is unavailable", 66)
    if (not stat.S_ISREG(info.st_mode) or stat.S_ISLNK(info.st_mode) or info.st_nlink != 1 or info.st_uid != 0 or info.st_gid != 0 or
            (info.st_mode & 0o777) not in {0o400, 0o440} or not 2 <= len(data) <= MAX_INPUT):
        fail("HOST_BINDING_UNTRUSTED", f"{label} metadata differs", 66)
    try:
        value = json.loads(data)
    except (UnicodeDecodeError, json.JSONDecodeError):
        fail("INVALID_JSON", f"{label} is not JSON", 65)
    if data != canonical(value) + b"\n":
        fail("NONCANONICAL_INPUT", f"{label} is not canonical", 65)
    return value


def validate_host_binding(value):
    exact(value, {"attestorKeyFingerprint", "attestorPublicKey", "attestorUser", "expiresAt", "hostBindingDigest", "hostHelperDigest", "kind",
                  "policyBinding", "providerKeyFingerprint", "providerPublicKey", "providerUser", "schemaVersion"}, "gateway host binding")
    policy = value["policyBinding"]
    exact(policy, {"apiAllow", "bindingDigest", "buildNonce", "expiresAt", "gateway", "helper", "httpsAllow", "kind", "nft", "originalRulesetDigest",
                   "reservationDigest", "schemaVersion"}, "gateway policy")
    exact(policy["gateway"], {"configDigest", "hostId", "providerId", "vmId"}, "gateway identity")
    exact(policy["helper"], {"digest", "path"}, "guest helper identity")
    unsigned_policy = dict(policy)
    policy_digest = unsigned_policy.pop("bindingDigest")
    unsigned = dict(value)
    host_digest = unsigned.pop("hostBindingDigest")
    if (value["schemaVersion"] != 1 or value["kind"] != "nelos-golden-builder-gateway-host-binding" or host_digest != digest(unsigned) or
            policy["schemaVersion"] != 1 or policy["kind"] != "nelos-golden-builder-gateway-policy" or policy_digest != digest(unsigned_policy) or
            policy["gateway"].get("providerId") != "proxmox-lab" or policy["gateway"].get("hostId") != "prox2" or policy["gateway"].get("vmId") != 9023 or
            not SHA256.fullmatch(policy["gateway"].get("configDigest") or "") or policy["helper"].get("path") != GUEST_HELPER or
            not SHA256.fullmatch(policy["helper"].get("digest") or "") or not SHA256.fullmatch(policy.get("originalRulesetDigest") or "") or
            value["providerUser"] != ROLE_USER["provider"] or value["attestorUser"] != ROLE_USER["attestor"] or
            public_key_fingerprint(value["providerPublicKey"], "provider public key") != value["providerKeyFingerprint"] or
            public_key_fingerprint(value["attestorPublicKey"], "attestor public key") != value["attestorKeyFingerprint"] or
            value["providerKeyFingerprint"] == value["attestorKeyFingerprint"] or not SHA256.fullmatch(value["hostHelperDigest"] or "") or
            value["expiresAt"] != policy["expiresAt"]):
        fail("INVALID_CONTRACT", "gateway host binding identity or digest differs", 65)
    return value


def require_directory(path, uid, gid, mode, label):
    try:
        info = path.lstat()
    except OSError:
        fail("HOST_AUTHORITY_MISMATCH", f"{label} is unavailable", 70)
    if not stat.S_ISDIR(info.st_mode) or stat.S_ISLNK(info.st_mode) or info.st_uid != uid or info.st_gid != gid or (info.st_mode & 0o777) != mode:
        fail("HOST_AUTHORITY_MISMATCH", f"{label} metadata differs", 70)


def require_file(path, uid, gid, mode, expected, label):
    try:
        info = path.lstat()
        data = path.read_bytes()
    except OSError:
        fail("HOST_AUTHORITY_MISMATCH", f"{label} is unavailable", 70)
    if (not stat.S_ISREG(info.st_mode) or stat.S_ISLNK(info.st_mode) or info.st_nlink != 1 or info.st_uid != uid or info.st_gid != gid or
            (info.st_mode & 0o777) != mode or data != expected):
        fail("HOST_AUTHORITY_MISMATCH", f"{label} metadata or content differs", 70)


def verify_helper_and_principal(binding, role):
    if os.geteuid() != 0 or pathlib.Path(os.path.realpath(sys.argv[0])) != HELPER_PATH:
        fail("HELPER_IDENTITY_MISMATCH", "gateway transport helper must run as installed root", 70)
    try:
        helper_info = HELPER_PATH.lstat()
        helper_data = HELPER_PATH.read_bytes()
    except OSError:
        fail("HELPER_IDENTITY_MISMATCH", "gateway transport helper is unavailable", 70)
    if (not stat.S_ISREG(helper_info.st_mode) or stat.S_ISLNK(helper_info.st_mode) or helper_info.st_nlink != 1 or helper_info.st_uid != 0 or helper_info.st_gid != 0 or
            (helper_info.st_mode & 0o777) not in {0o555, 0o755} or digest(helper_data) != binding["hostHelperDigest"]):
        fail("HELPER_IDENTITY_MISMATCH", "gateway transport helper identity differs", 70)
    if os.environ.get("SUDO_USER") != ROLE_USER[role]:
        fail("HOST_AUTHORITY_MISMATCH", "gateway forced principal differs", 70)
    try:
        account = pwd.getpwnam(ROLE_USER[role])
    except KeyError:
        fail("HOST_AUTHORITY_MISMATCH", "gateway forced principal is unavailable", 70)
    home = ROLE_HOME[role]
    if pathlib.Path(account.pw_dir) != home or account.pw_shell != "/bin/sh":
        fail("HOST_AUTHORITY_MISMATCH", "gateway principal home or shell differs", 70)
    require_directory(home, account.pw_uid, account.pw_gid, 0o700, "gateway principal home")
    require_directory(home / ".ssh", account.pw_uid, account.pw_gid, 0o700, "gateway principal SSH directory")
    suffix = binding["hostBindingDigest"][7:23]
    key = binding["providerPublicKey"] if role == "provider" else binding["attestorPublicKey"]
    command = f"{HELPER_PATH} {role} request"
    authorized = f'restrict,command="/usr/bin/sudo -n -- {command}" {key.strip()} nelos:gateway:{role}:{suffix}\n'.encode("ascii")
    require_file(home / ".ssh" / "authorized_keys", account.pw_uid, account.pw_gid, 0o600, authorized, "gateway authorized_keys")
    sudoers = f"{ROLE_USER[role]} ALL=(root) NOPASSWD: {command}\n".encode("ascii")
    require_file(pathlib.Path(f"/etc/sudoers.d/nelos-golden-gateway-{role}"), 0, 0, 0o440, sudoers, "gateway sudoers")


def read_request(binding, role):
    data = sys.stdin.buffer.read(MAX_INPUT + 1)
    if not 2 <= len(data) <= MAX_INPUT:
        fail("INPUT_LIMIT", "gateway request size differs", 65)
    try:
        value = json.loads(data)
    except (UnicodeDecodeError, json.JSONDecodeError):
        fail("INVALID_JSON", "gateway request is not JSON", 65)
    if data != canonical(value) + b"\n":
        fail("NONCANONICAL_INPUT", "gateway request is not canonical", 65)
    exact(value, {"binding", "deadlineAt", "kind", "operation", "operationId", "requestedAt", "role", "schemaVersion"}, "gateway request")
    policy = binding["policyBinding"]
    expected_id = digest({"schemaVersion": 1, "kind": "nelos-golden-builder-gateway-operation", "bindingDigest": policy["bindingDigest"], "operation": value["operation"]})
    allowed = PROVIDER_OPERATIONS if role == "provider" else ATTESTOR_OPERATIONS
    now = time.time()
    requested = parse_time(value["requestedAt"], "request issue time")
    deadline = parse_time(value["deadlineAt"], "request deadline")
    cleanup = value["operation"] in {"restore", "confirm-restored"}
    if (value["schemaVersion"] != 1 or value["kind"] != "nelos-golden-builder-gateway-request" or value["role"] != role or value["operation"] not in allowed or
            value["binding"] != policy or value["operationId"] != expected_id or requested > now + 1 or now - requested > 301 or requested >= deadline or now >= deadline or deadline - now > 301 or
            (not cleanup and now >= parse_time(policy["expiresAt"], "policy expiry"))):
        fail("IDENTITY_MISMATCH", "gateway request identity, role, or deadline differs", 77)
    return data, value, deadline


def command_json(arguments, deadline):
    remaining = deadline - time.time()
    if remaining <= 0:
        fail("DEADLINE_EXPIRED", "gateway host deadline expired", 75)
    try:
        result = subprocess.run(arguments, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                env={"PATH": "/usr/sbin:/usr/bin:/sbin:/bin", "LC_ALL": "C"}, timeout=remaining,
                                check=False, close_fds=True)
    except subprocess.TimeoutExpired:
        fail("DEADLINE_EXPIRED", "gateway host command timed out", 75)
    if result.returncode != 0 or len(result.stdout) + len(result.stderr) > MAX_OUTPUT:
        fail("PVE_OPERATION_FAILED", "bounded gateway Proxmox command failed", 70)
    try:
        return json.loads(result.stdout)
    except (UnicodeDecodeError, json.JSONDecodeError):
        fail("PVE_RESPONSE_INVALID", "gateway Proxmox response is not JSON", 70)


def pvesh(verb, path, deadline, parameters=None):
    args = ["/usr/bin/pvesh", verb, path, "--output-format", "json"]
    for name, value in sorted((parameters or {}).items()):
        args.extend(["--" + name, json.dumps(value, separators=(",", ":")) if isinstance(value, list) else str(value)])
    return command_json(args, deadline)


def validate_gateway_config(policy, deadline):
    config = pvesh("get", "/nodes/prox2/qemu/9023/config", deadline)
    status_value = pvesh("get", "/nodes/prox2/qemu/9023/status/current", deadline)
    if not isinstance(config, dict) or not isinstance(status_value, dict):
        fail("PVE_RESPONSE_INVALID", "gateway identity response is malformed", 70)
    config.pop("digest", None)
    if (digest(config) != policy["gateway"]["configDigest"] or status_value.get("status") != "running" or
            str(config.get("agent", "")) not in {"1", "enabled=1", "enabled=1,fstrim_cloned_disks=1"}):
        fail("GATEWAY_IDENTITY_MISMATCH", "gateway VM config, QGA, or running state differs", 77)


def invoke_guest(request_data, role, deadline):
    started = pvesh("create", "/nodes/prox2/qemu/9023/agent/exec", deadline, {
        "capture-output": 1,
        "command": GUEST_HELPER,
        "extra-args": [role, "request"],
        "input-data": base64.b64encode(request_data).decode("ascii"),
    })
    pid = started.get("pid") if isinstance(started, dict) else None
    if not isinstance(pid, int) or isinstance(pid, bool) or pid < 1:
        fail("QGA_RESPONSE_INVALID", "gateway QGA did not return one process identity", 70)
    while time.time() < deadline:
        status_value = pvesh("get", "/nodes/prox2/qemu/9023/agent/exec-status", deadline, {"pid": pid})
        if not isinstance(status_value, dict) or status_value.get("exited") not in {0, 1, False, True}:
            fail("QGA_RESPONSE_INVALID", "gateway QGA status is malformed", 70)
        if status_value.get("exited") in {1, True}:
            if status_value.get("out-truncated") in {1, True} or status_value.get("err-truncated") in {1, True} or status_value.get("exitcode") != 0:
                fail("QGA_HELPER_FAILED", "gateway guest helper failed or truncated output", 70)
            try:
                stdout = base64.b64decode(status_value.get("out-data", ""), validate=True)
                stderr = base64.b64decode(status_value.get("err-data", ""), validate=True)
            except binascii.Error:
                fail("QGA_RESPONSE_INVALID", "gateway QGA output is not canonical base64", 70)
            if stderr or not 2 <= len(stdout) <= MAX_OUTPUT:
                fail("QGA_HELPER_FAILED", "gateway guest helper emitted invalid output", 70)
            try:
                value = json.loads(stdout)
            except (UnicodeDecodeError, json.JSONDecodeError):
                fail("QGA_RESPONSE_INVALID", "gateway guest helper output is not JSON", 70)
            if stdout != canonical(value) + b"\n":
                fail("QGA_RESPONSE_INVALID", "gateway guest helper output is not canonical", 70)
            return value
        time.sleep(min(0.25, max(0, deadline - time.time())))
    fail("DEADLINE_EXPIRED", "gateway QGA process did not finish", 75)


def main():
    if len(sys.argv) != 3 or sys.argv[1] not in {"provider", "attestor"} or sys.argv[2] != "request":
        fail("INVALID_OPERATION", "gateway transport accepts only a fixed role request", 64)
    role = sys.argv[1]
    binding = validate_host_binding(read_root_json(BINDING_PATH, "gateway host binding"))
    verify_helper_and_principal(binding, role)
    request_data, _, deadline = read_request(binding, role)
    validate_gateway_config(binding["policyBinding"], deadline)
    value = invoke_guest(request_data, role, deadline)
    sys.stdout.buffer.write(canonical(value) + b"\n")


if __name__ == "__main__":
    try:
        main()
    except TransportError as error:
        sys.stderr.buffer.write(canonical({"error": error.code, "message": error.message}) + b"\n")
        raise SystemExit(error.exit_code)
