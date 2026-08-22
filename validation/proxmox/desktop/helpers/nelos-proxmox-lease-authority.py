#!/usr/bin/python3
"""Independent, host-local lease authority for disposable Desktop VMs.

The authority is deliberately separate from the per-run host binder.  A run
may name a lease, but only the highest valid record in this root-owned store
can authorize a provider effect.  ``--fake-root`` is a marker-gated test
boundary and is never accepted by the production path.
"""

import argparse
import base64
import datetime
import fcntl
import hashlib
import json
import os
import pathlib
import re
import secrets
import stat
import sys


TRUST_KIND = "nelos.proxmox-desktop.lease-authority-trust.v1"
RECORD_KIND = "nelos.proxmox-desktop.lease-authority-record.v1"
OBSERVATION_KIND = "nelos.proxmox-desktop.lease-authority-observation.v1"
FAKE_MARKER = b"nelos-proxmox-lease-authority-fake-root-v1\n"
TRUST_PATH = "/etc/nelos-lease-authority/trust.json"
RUN_BINDING_PATH = "/etc/nelos-desktop/run-binding.json"
RUN_AUTHORITY_PATH = "/etc/nelos-desktop/lease-authority-binding.json"
DEFAULT_STATE_ROOT = "/var/lib/nelos-lease-authority"
PRODUCTION_PROVIDER_ID = "proxmox-lab"
PRODUCTION_HOST_ID = "prox2"
PRODUCTION_GATEWAY_ID = "9023"
PRODUCTION_NETWORK_ID = "nelosbld"
MAX_JSON_BYTES = 65_536
SAFE_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9._:-]{0,127}\Z")
VMID = re.compile(r"[1-9][0-9]{2,8}\Z")
MAC_ADDRESS = re.compile(r"02(?::[0-9A-F]{2}){5}\Z")
DIGEST = re.compile(r"sha256:[0-9a-f]{64}\Z")
UTC_MILLISECONDS = re.compile(r"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z\Z")
STATES = {"active", "cleanup-only", "revoked", "completed"}
RUN_FIELDS = {
    "automationUser", "fencingToken", "hostId", "imageId", "leaseId",
    "gatewayId", "macAddress", "networkId", "networkPolicyDigest", "providerId", "runId", "stateRoot", "vmId",
}
AUTHORITY_BINDING_FIELDS = {
    "authorityId", "epoch", "issuedRecordDigest", "issuedRecordFileDigest", "issuedRevision", "trustDigest",
}
RESOURCE_FIELDS = {"hostId", "providerId", "vmid"}
LEASE_FIELDS = {
    "cleanupExpiresAt", "expiresAt", "fencingToken", "holderId", "issuedAt",
    "leaseId", "runId",
}


class AuthorityError(Exception):
    def __init__(self, code, message, exit_code=77):
        super().__init__(message)
        self.code = code
        self.message = message
        self.exit_code = exit_code


def fail(code, message, exit_code=77):
    raise AuthorityError(code, message, exit_code)


def exact(value, fields, label):
    if not isinstance(value, dict) or set(value) != set(fields):
        fail("INVALID_AUTHORITY_CONTRACT", f"{label} fields differ from the closed contract", 65)


def canonical_bytes(value):
    return (json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True) + "\n").encode("utf-8")


def digest_bytes(value):
    return "sha256:" + hashlib.sha256(value).hexdigest()


def digest_value(value):
    return digest_bytes(canonical_bytes(value))


def parse_time(value, label):
    if not isinstance(value, str) or UTC_MILLISECONDS.fullmatch(value) is None:
        fail("INVALID_AUTHORITY_CONTRACT", f"{label} must be one millisecond UTC timestamp", 65)
    try:
        parsed = datetime.datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        fail("INVALID_AUTHORITY_CONTRACT", f"{label} must be one millisecond UTC timestamp", 65)
    if parsed.tzinfo is None or parsed.utcoffset() != datetime.timedelta(0):
        fail("INVALID_AUTHORITY_CONTRACT", f"{label} must be one millisecond UTC timestamp", 65)
    return parsed


def now_utc(fake):
    override = os.environ.get("NELOS_LEASE_AUTHORITY_TEST_NOW")
    if override is not None:
        if not fake:
            fail("UNSAFE_CLOCK_OVERRIDE", "production authority clock cannot be overridden", 77)
        return parse_time(override, "test clock")
    return datetime.datetime.now(datetime.timezone.utc)


def timestamp(value):
    return value.astimezone(datetime.timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def root_path(root, logical):
    return pathlib.Path(logical) if root == "/" else pathlib.Path(root, logical.lstrip("/"))


def safe_absolute(value, label):
    if (not isinstance(value, str) or not value.startswith("/") or len(value) > 4096 or
            "\x00" in value or "\n" in value or pathlib.PurePosixPath(value).as_posix() != value or
            ".." in pathlib.PurePosixPath(value).parts):
        fail("INVALID_AUTHORITY_CONTRACT", f"{label} must be one normalized absolute path", 65)
    return value


def require_directory(path, uid, gid, mode, label):
    try:
        info = path.lstat()
    except OSError:
        fail("AUTHORITY_STATE_UNAVAILABLE", f"{label} is unavailable", 70)
    if (not stat.S_ISDIR(info.st_mode) or stat.S_ISLNK(info.st_mode) or info.st_uid != uid or
            info.st_gid != gid or (info.st_mode & 0o777) != mode):
        fail("UNTRUSTED_AUTHORITY_STATE", f"{label} ownership, mode, or type differs", 70)


def require_regular(path, uid, gid, mode, maximum, label):
    try:
        info = path.lstat()
    except OSError:
        fail("AUTHORITY_STATE_UNAVAILABLE", f"{label} is unavailable", 70)
    if (not stat.S_ISREG(info.st_mode) or stat.S_ISLNK(info.st_mode) or info.st_nlink != 1 or
            info.st_uid != uid or info.st_gid != gid or (info.st_mode & 0o777) != mode or
            not 2 <= info.st_size <= maximum):
        fail("UNTRUSTED_AUTHORITY_STATE", f"{label} ownership, mode, link count, size, or type differs", 70)
    return info


def read_json(path, uid, gid, mode, label, maximum=MAX_JSON_BYTES):
    before = require_regular(path, uid, gid, mode, maximum, label)
    flags = os.O_RDONLY | (os.O_NOFOLLOW if hasattr(os, "O_NOFOLLOW") else 0)
    fd = os.open(path, flags)
    try:
        opened = os.fstat(fd)
        data = b""
        while len(data) <= maximum:
            chunk = os.read(fd, min(16_384, maximum + 1 - len(data)))
            if not chunk:
                break
            data += chunk
        after = os.fstat(fd)
    finally:
        os.close(fd)
    fields = ("st_dev", "st_ino", "st_mode", "st_nlink", "st_uid", "st_gid", "st_size", "st_mtime_ns", "st_ctime_ns")
    if any(getattr(before, field) != getattr(opened, field) or getattr(opened, field) != getattr(after, field) for field in fields) or len(data) != before.st_size:
        fail("AUTHORITY_STATE_CHANGED", f"{label} changed while it was read", 70)
    try:
        value = json.loads(data)
    except (UnicodeDecodeError, json.JSONDecodeError):
        fail("INVALID_AUTHORITY_STATE", f"{label} is not JSON", 70)
    if data != canonical_bytes(value):
        fail("INVALID_AUTHORITY_STATE", f"{label} is not canonical JSON", 70)
    return value, data


def write_exclusive(path, data, uid, gid, mode):
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | (os.O_NOFOLLOW if hasattr(os, "O_NOFOLLOW") else 0)
    fd = os.open(path, flags, mode)
    try:
        os.write(fd, data)
        os.fsync(fd)
        os.fchmod(fd, mode)
        os.fchown(fd, uid, gid)
    finally:
        os.close(fd)


def publish_current(path, data, uid, gid):
    temporary = path.with_name(f".{path.name}.{secrets.token_hex(16)}.tmp")
    write_exclusive(temporary, data, uid, gid, 0o400)
    os.replace(temporary, path)
    directory = os.open(path.parent, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
    try:
        os.fsync(directory)
    finally:
        os.close(directory)


def execution_root(fake_root):
    if fake_root is None:
        if os.geteuid() != 0:
            fail("ROOT_REQUIRED", "the production lease authority requires root", 77)
        return "/", False, 0, 0
    root = pathlib.Path(fake_root)
    marker = root / ".nelos-lease-authority-fake-root"
    try:
        root_info = root.lstat()
        marker_info = marker.lstat()
        marker_bytes = marker.read_bytes()
    except OSError:
        fail("INVALID_FAKE_ROOT", "fake-root marker is unavailable", 64)
    if (not root.is_absolute() or str(root) == "/" or not stat.S_ISDIR(root_info.st_mode) or stat.S_ISLNK(root_info.st_mode) or
            root_info.st_uid != os.geteuid() or not stat.S_ISREG(marker_info.st_mode) or marker_info.st_uid != os.geteuid() or
            marker_info.st_gid != root_info.st_gid or
            (marker_info.st_mode & 0o777) not in {0o400, 0o600} or marker_bytes != FAKE_MARKER):
        fail("INVALID_FAKE_ROOT", "fake-root marker or ownership is invalid", 64)
    # APFS and other test filesystems may inherit the temporary root's group
    # rather than the caller's primary group.  The fake boundary therefore
    # pins every artifact to the already verified fake-root owner and group.
    # Production remains fixed to root:root above.
    return str(root), True, root_info.st_uid, root_info.st_gid


def validate_trust(value):
    exact(value, {"authorityId", "effectMarginMs", "hostId", "kind", "providerId", "schemaVersion", "stateRoot"}, "trust")
    if value["schemaVersion"] != 1 or value["kind"] != TRUST_KIND:
        fail("INVALID_AUTHORITY_CONTRACT", "trust kind or schema is unsupported", 65)
    for field in ("authorityId", "hostId", "providerId"):
        if not isinstance(value[field], str) or SAFE_ID.fullmatch(value[field]) is None:
            fail("INVALID_AUTHORITY_CONTRACT", f"trust {field} is invalid", 65)
    safe_absolute(value["stateRoot"], "trust stateRoot")
    if value["stateRoot"] != DEFAULT_STATE_ROOT:
        fail("INVALID_AUTHORITY_CONTRACT", "trust stateRoot must use the fixed production root", 65)
    if (not isinstance(value["effectMarginMs"], int) or isinstance(value["effectMarginMs"], bool) or
            not 1_000 <= value["effectMarginMs"] <= 60_000):
        fail("INVALID_AUTHORITY_CONTRACT", "effectMarginMs is outside the fixed bound", 65)
    return value


def read_trust(root, uid, gid):
    value, data = read_json(root_path(root, TRUST_PATH), uid, gid, 0o400, "authority trust")
    validate_trust(value)
    return value, data, digest_bytes(data)


def validate_resource(value, trust):
    exact(value, RESOURCE_FIELDS, "resource")
    if value.get("providerId") != trust["providerId"] or value.get("hostId") != trust["hostId"] or not isinstance(value.get("vmid"), str) or VMID.fullmatch(value["vmid"]) is None:
        fail("AUTHORITY_RESOURCE_MISMATCH", "resource is outside the authority trust", 77)
    return value


def resource_key(resource):
    return hashlib.sha256(canonical_bytes(resource)).hexdigest()


def unsigned_record(record):
    value = dict(record)
    value.pop("recordDigest", None)
    return value


def validate_record(value, trust, trust_digest):
    exact(value, {"authority", "epoch", "kind", "lease", "previousRecordDigest", "recordDigest", "resource", "revision", "schemaVersion", "state", "transition"}, "record")
    if value["schemaVersion"] != 1 or value["kind"] != RECORD_KIND or value["state"] not in STATES:
        fail("INVALID_AUTHORITY_STATE", "record kind, schema, or state differs", 70)
    exact(value["authority"], {"authorityId", "trustDigest"}, "record authority")
    if value["authority"] != {"authorityId": trust["authorityId"], "trustDigest": trust_digest}:
        fail("AUTHORITY_TRUST_MISMATCH", "record belongs to another authority trust", 70)
    validate_resource(value["resource"], trust)
    exact(value["lease"], LEASE_FIELDS, "record lease")
    for field in ("fencingToken", "holderId", "leaseId", "runId"):
        if not isinstance(value["lease"].get(field), str) or SAFE_ID.fullmatch(value["lease"][field]) is None:
            fail("INVALID_AUTHORITY_STATE", f"record lease {field} is invalid", 70)
    issued = parse_time(value["lease"].get("issuedAt"), "record issuedAt")
    expires = parse_time(value["lease"].get("expiresAt"), "record expiresAt")
    cleanup = parse_time(value["lease"].get("cleanupExpiresAt"), "record cleanupExpiresAt")
    if not issued < expires <= cleanup:
        fail("INVALID_AUTHORITY_STATE", "record lease times are not ordered", 70)
    if (not isinstance(value["epoch"], int) or isinstance(value["epoch"], bool) or value["epoch"] < 1 or
            not isinstance(value["revision"], int) or isinstance(value["revision"], bool) or value["revision"] < 1):
        fail("INVALID_AUTHORITY_STATE", "record epoch or revision is invalid", 70)
    if value["previousRecordDigest"] is not None and (not isinstance(value["previousRecordDigest"], str) or DIGEST.fullmatch(value["previousRecordDigest"]) is None):
        fail("INVALID_AUTHORITY_STATE", "previousRecordDigest is invalid", 70)
    exact(value["transition"], {"at", "operation", "reason"}, "record transition")
    parse_time(value["transition"].get("at"), "record transition time")
    if value["transition"].get("operation") not in {"issue", "cleanup-only", "revoke", "complete"} or not isinstance(value["transition"].get("reason"), str) or not 1 <= len(value["transition"]["reason"]) <= 256:
        fail("INVALID_AUTHORITY_STATE", "record transition identity is invalid", 70)
    if not isinstance(value["recordDigest"], str) or DIGEST.fullmatch(value["recordDigest"]) is None or digest_value(unsigned_record(value)) != value["recordDigest"]:
        fail("AUTHORITY_DIGEST_MISMATCH", "record digest differs", 70)
    return value


def state_paths(root, trust, resource):
    base = root_path(root, trust["stateRoot"])
    key = resource_key(resource)
    return base, key, base / "history" / key, base / "current" / f"{key}.json"


def read_history(root, uid, gid, trust, trust_digest, resource, require=True):
    base, key, history, current = state_paths(root, trust, resource)
    require_directory(base, uid, gid, 0o700, "authority state root")
    require_directory(base / "history", uid, gid, 0o700, "authority history root")
    require_directory(base / "current", uid, gid, 0o700, "authority current root")
    if not history.exists():
        if require:
            fail("LEASE_NOT_ISSUED", "resource has no authority history", 77)
        return [], current
    require_directory(history, uid, gid, 0o700, "resource history")
    entries = []
    for path in sorted(history.iterdir(), key=lambda item: item.name):
        if not re.fullmatch(r"[0-9]{20}-[0-9a-f]{64}\.json", path.name):
            fail("UNTRUSTED_AUTHORITY_STATE", "resource history contains an unknown entry", 70)
        record, data = read_json(path, uid, gid, 0o400, "authority history record")
        validate_record(record, trust, trust_digest)
        expected_name = f"{record['revision']:020d}-{record['recordDigest'][7:]}.json"
        if path.name != expected_name or record["resource"] != resource:
            fail("AUTHORITY_ROLLBACK_DETECTED", "history record path or resource differs", 70)
        entries.append((record, data))
    if not entries:
        fail("AUTHORITY_ROLLBACK_DETECTED", "resource history is empty", 70)
    for index, (record, _) in enumerate(entries):
        if record["revision"] != index + 1:
            fail("AUTHORITY_ROLLBACK_DETECTED", "authority revision chain is not contiguous", 70)
        if index == 0:
            if (record["epoch"] != 1 or record["previousRecordDigest"] is not None or
                    record["transition"]["operation"] != "issue" or record["state"] != "active" or
                    record["lease"]["issuedAt"] != record["transition"]["at"]):
                fail("AUTHORITY_ROLLBACK_DETECTED", "authority genesis record is invalid", 70)
            continue
        previous = entries[index - 1][0]
        if record["previousRecordDigest"] != previous["recordDigest"]:
            fail("AUTHORITY_ROLLBACK_DETECTED", "authority digest chain is broken", 70)
        if parse_time(record["transition"]["at"], "record transition time") < parse_time(previous["transition"]["at"], "previous transition time"):
            fail("AUTHORITY_CLOCK_ROLLBACK", "authority transition time moved backwards", 70)
        operation = record["transition"]["operation"]
        if operation == "issue":
            if (previous["state"] != "completed" or record["epoch"] != previous["epoch"] + 1 or
                    record["state"] != "active" or record["lease"]["issuedAt"] != record["transition"]["at"]):
                fail("AUTHORITY_REASSIGNMENT_BLOCKED", "lease reassignment did not follow a completed epoch", 70)
        else:
            allowed = {
                "cleanup-only": ({"active"}, "cleanup-only"),
                "revoke": ({"active", "cleanup-only"}, "revoked"),
                "complete": ({"active", "cleanup-only", "revoked"}, "completed"),
            }
            prior_states, target_state = allowed[operation]
            if (record["epoch"] != previous["epoch"] or record["lease"] != previous["lease"] or
                    previous["state"] not in prior_states or record["state"] != target_state):
                fail("AUTHORITY_ROLLBACK_DETECTED", "lease transition changed its epoch, identity, or state machine", 70)
    latest, latest_bytes = entries[-1]
    current_value, current_bytes = read_json(current, uid, gid, 0o400, "canonical current authority record")
    validate_record(current_value, trust, trust_digest)
    if current_bytes != latest_bytes or current_value["recordDigest"] != latest["recordDigest"]:
        fail("AUTHORITY_ROLLBACK_DETECTED", "canonical current record is not the highest authority revision", 70)
    return entries, current


def lock_authority(root, uid, gid, trust, shared=False):
    base = root_path(root, trust["stateRoot"])
    require_directory(base, uid, gid, 0o700, "authority state root")
    lock_path = base / ".lock"
    require_regular(lock_path, uid, gid, 0o600, 16, "authority lock")
    fd = os.open(lock_path, os.O_RDWR | (os.O_NOFOLLOW if hasattr(os, "O_NOFOLLOW") else 0))
    fcntl.flock(fd, fcntl.LOCK_SH if shared else fcntl.LOCK_EX)
    return fd


def validate_issue(value, trust):
    exact(value, {"authorityId", "cleanupExpiresAt", "expiresAt", "fencingToken", "holderId", "leaseId", "previousRecordDigest", "reason", "resource", "runId"}, "issue request")
    if value["authorityId"] != trust["authorityId"]:
        fail("AUTHORITY_TRUST_MISMATCH", "issue request belongs to another authority", 77)
    validate_resource(value["resource"], trust)
    for field in ("fencingToken", "holderId", "leaseId", "runId"):
        if not isinstance(value[field], str) or SAFE_ID.fullmatch(value[field]) is None:
            fail("INVALID_AUTHORITY_CONTRACT", f"issue request {field} is invalid", 65)
    if value["previousRecordDigest"] is not None and (not isinstance(value["previousRecordDigest"], str) or DIGEST.fullmatch(value["previousRecordDigest"]) is None):
        fail("INVALID_AUTHORITY_CONTRACT", "issue previousRecordDigest is invalid", 65)
    if not isinstance(value["reason"], str) or not 1 <= len(value["reason"]) <= 256:
        fail("INVALID_AUTHORITY_CONTRACT", "issue reason is invalid", 65)
    parse_time(value["expiresAt"], "issue expiresAt")
    parse_time(value["cleanupExpiresAt"], "issue cleanupExpiresAt")
    return value


def validate_transition(value, trust):
    exact(value, {"authorityId", "currentRecordDigest", "fencingToken", "holderId", "leaseId", "reason", "resource", "runId"}, "transition request")
    if value["authorityId"] != trust["authorityId"]:
        fail("AUTHORITY_TRUST_MISMATCH", "transition belongs to another authority", 77)
    validate_resource(value["resource"], trust)
    for field in ("currentRecordDigest", "fencingToken", "holderId", "leaseId", "runId"):
        pattern = DIGEST if field == "currentRecordDigest" else SAFE_ID
        if not isinstance(value[field], str) or pattern.fullmatch(value[field]) is None:
            fail("INVALID_AUTHORITY_CONTRACT", f"transition request {field} is invalid", 65)
    if not isinstance(value["reason"], str) or not 1 <= len(value["reason"]) <= 256:
        fail("INVALID_AUTHORITY_CONTRACT", "transition reason is invalid", 65)
    return value


def record_for(trust, trust_digest, resource, lease, epoch, revision, state, operation, reason, at, previous):
    unsigned = {
        "authority": {"authorityId": trust["authorityId"], "trustDigest": trust_digest},
        "epoch": epoch,
        "kind": RECORD_KIND,
        "lease": lease,
        "previousRecordDigest": previous,
        "resource": resource,
        "revision": revision,
        "schemaVersion": 1,
        "state": state,
        "transition": {"at": timestamp(at), "operation": operation, "reason": reason},
    }
    return {**unsigned, "recordDigest": digest_value(unsigned)}


def publish_record(root, uid, gid, trust, trust_digest, record):
    validate_record(record, trust, trust_digest)
    data = canonical_bytes(record)
    _, _, history, current = state_paths(root, trust, record["resource"])
    if not history.exists():
        history.mkdir(mode=0o700)
        os.chown(history, uid, gid)
    require_directory(history, uid, gid, 0o700, "resource history")
    path = history / f"{record['revision']:020d}-{record['recordDigest'][7:]}.json"
    write_exclusive(path, data, uid, gid, 0o400)
    history_fd = os.open(history, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
    try:
        os.fsync(history_fd)
    finally:
        os.close(history_fd)
    publish_current(current, data, uid, gid)
    return observation_for(
        trust, trust_digest, record, data,
        parse_time(record["transition"]["at"], "record transition time"),
    )


def observation_for(trust, trust_digest, record, data, observed_at):
    return {
        "authorityId": trust["authorityId"],
        "kind": OBSERVATION_KIND,
        "observedAt": timestamp(observed_at),
        "record": record,
        "recordBytesBase64": base64.b64encode(data).decode("ascii"),
        "recordDigest": record["recordDigest"],
        "recordFileDigest": digest_bytes(data),
        "resourceKey": resource_key(record["resource"]),
        "schemaVersion": 1,
        "trustDigest": trust_digest,
    }


def issue(root, fake, uid, gid, trust, trust_digest, request):
    validate_issue(request, trust)
    at = now_utc(fake)
    expires = parse_time(request["expiresAt"], "issue expiresAt")
    cleanup_expires = parse_time(request["cleanupExpiresAt"], "issue cleanupExpiresAt")
    margin = datetime.timedelta(milliseconds=trust["effectMarginMs"])
    if not at + margin < expires <= cleanup_expires or expires - at > datetime.timedelta(days=1) or cleanup_expires - at > datetime.timedelta(days=7):
        fail("INVALID_LEASE_WINDOW", "issue expiry or cleanup expiry is outside the authority bounds", 77)
    lock_fd = lock_authority(root, uid, gid, trust)
    try:
        entries, _ = read_history(root, uid, gid, trust, trust_digest, request["resource"], require=False)
        previous = entries[-1][0] if entries else None
        expected_previous = previous["recordDigest"] if previous else None
        if request["previousRecordDigest"] != expected_previous:
            fail("AUTHORITY_ROLLBACK_DETECTED", "issue does not name the current authority record", 77)
        if previous is not None and previous["state"] != "completed":
            fail("AUTHORITY_REASSIGNMENT_BLOCKED", "resource must be manually reconciled and completed before reassignment", 77)
        if previous is not None and at < parse_time(previous["transition"]["at"], "previous transition time"):
            fail("AUTHORITY_CLOCK_ROLLBACK", "authority clock moved behind the current revision", 77)
        if previous is not None and any(
                request[field] == historical["lease"][field]
                for historical, _ in entries
                for field in ("leaseId", "fencingToken", "runId")):
            fail("AUTHORITY_REASSIGNMENT_BLOCKED", "new epoch must use globally fresh lease, fence, and run identities", 77)
        epoch = 1 if previous is None else previous["epoch"] + 1
        revision = 1 if previous is None else previous["revision"] + 1
        lease = {
            "cleanupExpiresAt": request["cleanupExpiresAt"],
            "expiresAt": request["expiresAt"],
            "fencingToken": request["fencingToken"],
            "holderId": request["holderId"],
            "issuedAt": timestamp(at),
            "leaseId": request["leaseId"],
            "runId": request["runId"],
        }
        return publish_record(root, uid, gid, trust, trust_digest, record_for(
            trust, trust_digest, request["resource"], lease, epoch, revision, "active", "issue", request["reason"], at,
            previous["recordDigest"] if previous else None,
        ))
    finally:
        os.close(lock_fd)


def transition(root, fake, uid, gid, trust, trust_digest, request, operation):
    validate_transition(request, trust)
    lock_fd = lock_authority(root, uid, gid, trust)
    try:
        entries, _ = read_history(root, uid, gid, trust, trust_digest, request["resource"])
        current = entries[-1][0]
        if current["recordDigest"] != request["currentRecordDigest"]:
            fail("AUTHORITY_ROLLBACK_DETECTED", "transition does not name the current authority record", 77)
        exact_identity = {field: request[field] for field in ("fencingToken", "holderId", "leaseId", "runId")}
        if any(current["lease"][field] != value for field, value in exact_identity.items()):
            fail("LEASE_SUPERSEDED", "transition lease identity is no longer current", 77)
        allowed = {
            "cleanup-only": {"active"},
            "revoke": {"active", "cleanup-only"},
            "complete": {"active", "cleanup-only", "revoked"},
        }
        if current["state"] not in allowed[operation]:
            fail("INVALID_LEASE_TRANSITION", f"cannot transition {current['state']} to {operation}", 77)
        at = now_utc(fake)
        if at < parse_time(current["transition"]["at"], "current transition time"):
            fail("AUTHORITY_CLOCK_ROLLBACK", "authority clock moved behind the current revision", 77)
        if operation == "cleanup-only" and at + datetime.timedelta(milliseconds=trust["effectMarginMs"]) >= parse_time(current["lease"]["cleanupExpiresAt"], "cleanupExpiresAt"):
            fail("CLEANUP_LEASE_EXPIRED", "cleanup authorization has insufficient remaining time", 77)
        target_state = {"complete": "completed", "revoke": "revoked"}.get(operation, operation)
        record = record_for(
            trust, trust_digest, current["resource"], current["lease"], current["epoch"], current["revision"] + 1,
            target_state, operation, request["reason"], at, current["recordDigest"],
        )
        return publish_record(root, uid, gid, trust, trust_digest, record)
    finally:
        os.close(lock_fd)


def observe(root, fake, uid, gid, trust, trust_digest, resource):
    lock_fd = lock_authority(root, uid, gid, trust, shared=True)
    try:
        entries, _ = read_history(root, uid, gid, trust, trust_digest, resource)
        record, record_bytes = entries[-1]
        return observation_for(trust, trust_digest, record, record_bytes, now_utc(fake))
    finally:
        os.close(lock_fd)


def bound_resource_and_authority(root, uid, gid, trust):
    run, _ = read_json(root_path(root, RUN_BINDING_PATH), uid, gid, 0o400, "run binding")
    authority, _ = read_json(root_path(root, RUN_AUTHORITY_PATH), uid, gid, 0o400, "run authority binding")
    exact(run, RUN_FIELDS, "run binding")
    exact(authority, AUTHORITY_BINDING_FIELDS, "run authority binding")
    resource = {"hostId": run.get("hostId"), "providerId": run.get("providerId"), "vmid": run.get("vmId")}
    validate_resource(resource, trust)
    for field in ("fencingToken", "gatewayId", "leaseId", "networkId", "runId"):
        if not isinstance(run.get(field), str) or SAFE_ID.fullmatch(run[field]) is None:
            fail("INVALID_AUTHORITY_BINDING", f"run binding {field} is invalid", 70)
    if (not isinstance(run.get("macAddress"), str) or MAC_ADDRESS.fullmatch(run["macAddress"]) is None or
            VMID.fullmatch(run["gatewayId"]) is None or run["gatewayId"] == run["vmId"] or
            run["providerId"] != PRODUCTION_PROVIDER_ID or run["hostId"] != PRODUCTION_HOST_ID or
            run["gatewayId"] != PRODUCTION_GATEWAY_ID or run["networkId"] != PRODUCTION_NETWORK_ID or
            not isinstance(run.get("networkPolicyDigest"), str) or DIGEST.fullmatch(run["networkPolicyDigest"]) is None):
        fail("INVALID_AUTHORITY_BINDING", "run network binding is invalid", 70)
    if (authority.get("authorityId") != trust["authorityId"] or authority.get("trustDigest") != digest_value(trust) or
            not isinstance(authority.get("epoch"), int) or isinstance(authority.get("epoch"), bool) or authority["epoch"] < 1 or
            not isinstance(authority.get("issuedRevision"), int) or isinstance(authority.get("issuedRevision"), bool) or authority["issuedRevision"] < 1 or
            not isinstance(authority.get("issuedRecordDigest"), str) or DIGEST.fullmatch(authority["issuedRecordDigest"]) is None or
            not isinstance(authority.get("issuedRecordFileDigest"), str) or DIGEST.fullmatch(authority["issuedRecordFileDigest"]) is None):
        fail("AUTHORITY_TRUST_MISMATCH", "run authority binding differs from host trust", 70)
    return run, authority, resource


def observe_bound_unlocked(root, uid, gid, trust, trust_digest, observed_at):
    run, authority, resource = bound_resource_and_authority(root, uid, gid, trust)
    entries, _ = read_history(root, uid, gid, trust, trust_digest, resource)
    record, record_bytes = entries[-1]
    issued_index = authority["issuedRevision"] - 1
    issued, issued_bytes = entries[issued_index] if 0 <= issued_index < len(entries) else (None, None)
    if (issued is None or issued["recordDigest"] != authority["issuedRecordDigest"] or issued["epoch"] != authority["epoch"] or
            digest_bytes(issued_bytes) != authority["issuedRecordFileDigest"] or
            issued["transition"]["operation"] != "issue" or record["epoch"] != authority["epoch"] or
            record["revision"] < authority["issuedRevision"] or record["authority"]["trustDigest"] != authority["trustDigest"] or
            record["lease"]["leaseId"] != run["leaseId"] or record["lease"]["fencingToken"] != run["fencingToken"] or
            record["lease"]["runId"] != run["runId"]):
        fail("LEASE_SUPERSEDED", "bound run is not the canonical current authority record", 77)
    return observation_for(trust, trust_digest, record, record_bytes, observed_at)


def observe_bound(root, fake, uid, gid, trust, trust_digest):
    lock_fd = lock_authority(root, uid, gid, trust, shared=True)
    try:
        return observe_bound_unlocked(root, uid, gid, trust, trust_digest, now_utc(fake))
    finally:
        os.close(lock_fd)


def authorize_bound(root, fake, uid, gid, trust, trust_digest, mode):
    lock_fd = lock_authority(root, uid, gid, trust, shared=True)
    try:
        now = now_utc(fake)
        observed = observe_bound_unlocked(root, uid, gid, trust, trust_digest, now)
        record = observed["record"]
        margin = datetime.timedelta(milliseconds=trust["effectMarginMs"])
        if record["state"] in {"revoked", "completed"}:
            fail("LEASE_MANUAL_RECONCILIATION_REQUIRED", "revoked, completed, or superseded leases cannot mutate automatically", 77)
        if mode == "active":
            if record["state"] != "active" or now + margin >= parse_time(record["lease"]["expiresAt"], "expiresAt"):
                fail("LEASE_NOT_ACTIVE", "active provider work is not authorized within the required margin", 77)
        elif mode == "cleanup":
            deadline_field = "expiresAt" if record["state"] == "active" else "cleanupExpiresAt"
            if record["state"] not in {"active", "cleanup-only"} or now + margin >= parse_time(record["lease"][deadline_field], deadline_field):
                fail("CLEANUP_LEASE_EXPIRED", "exact cleanup is not authorized within the required margin", 77)
        else:
            fail("INVALID_OPERATION", "authorization mode is invalid", 64)
        return {**observed, "authorizedMode": mode}
    finally:
        os.close(lock_fd)


def prepare(root, uid, gid, trust_path, fake):
    source, source_bytes = read_json(pathlib.Path(trust_path), uid, gid, 0o400 if not fake else 0o600, "authority trust input")
    validate_trust(source)
    etc = root_path(root, "/etc/nelos-lease-authority")
    state = root_path(root, source["stateRoot"])
    for path in (etc, state, state / "history", state / "current"):
        if not path.exists():
            path.mkdir(mode=0o700, parents=True)
            os.chown(path, uid, gid)
        require_directory(path, uid, gid, 0o700, str(path))
    lock_path = state / ".lock"
    if not lock_path.exists():
        write_exclusive(lock_path, b"lock\n", uid, gid, 0o600)
    require_regular(lock_path, uid, gid, 0o600, 16, "authority lock")
    target = root_path(root, TRUST_PATH)
    if target.exists():
        installed, installed_bytes = read_json(target, uid, gid, 0o400, "installed authority trust")
        validate_trust(installed)
        if installed_bytes != source_bytes:
            fail("AUTHORITY_TRUST_MISMATCH", "installed authority trust differs", 77)
    else:
        write_exclusive(target, source_bytes, uid, gid, 0o400)
    return {"authorityId": source["authorityId"], "prepared": True, "schemaVersion": 1, "trustDigest": digest_bytes(source_bytes)}


def read_request(path, uid, gid, fake, label):
    return read_json(pathlib.Path(path), uid, gid, 0o400 if not fake else 0o600, label)[0]


def parser():
    result = argparse.ArgumentParser(prog="nelos-proxmox-lease-authority")
    commands = result.add_subparsers(dest="command", required=True)
    prepare_command = commands.add_parser("prepare")
    prepare_command.add_argument("--trust", required=True)
    prepare_command.add_argument("--fake-root")
    for name in ("issue", "cleanup-only", "revoke", "complete"):
        command = commands.add_parser(name)
        command.add_argument("--request", required=True)
        command.add_argument("--fake-root")
    observe_command = commands.add_parser("observe")
    observe_command.add_argument("--resource", required=True)
    observe_command.add_argument("--fake-root")
    for name in ("observe-bound", "authorize-bound"):
        command = commands.add_parser(name)
        if name == "authorize-bound":
            command.add_argument("mode", choices=("active", "cleanup"))
        command.add_argument("--fake-root")
    return result


def main():
    arguments = parser().parse_args()
    fake_root = getattr(arguments, "fake_root", None)
    root, fake, uid, gid = execution_root(fake_root)
    if arguments.command == "prepare":
        if not pathlib.Path(arguments.trust).is_absolute():
            fail("INVALID_AUTHORITY_CONTRACT", "trust path must be absolute", 64)
        result = prepare(root, uid, gid, arguments.trust, fake)
    else:
        trust, trust_bytes, trust_digest = read_trust(root, uid, gid)
        if trust_digest != digest_value(trust):
            fail("AUTHORITY_TRUST_MISMATCH", "authority trust digest is noncanonical", 70)
        if arguments.command == "issue":
            result = issue(root, fake, uid, gid, trust, trust_digest, read_request(arguments.request, uid, gid, fake, "issue request"))
        elif arguments.command in {"cleanup-only", "revoke", "complete"}:
            result = transition(root, fake, uid, gid, trust, trust_digest, read_request(arguments.request, uid, gid, fake, "transition request"), arguments.command)
        elif arguments.command == "observe":
            result = observe(root, fake, uid, gid, trust, trust_digest, read_request(arguments.resource, uid, gid, fake, "resource request"))
        elif arguments.command == "observe-bound":
            result = observe_bound(root, fake, uid, gid, trust, trust_digest)
        else:
            result = authorize_bound(root, fake, uid, gid, trust, trust_digest, arguments.mode)
    sys.stdout.buffer.write(canonical_bytes(result))


if __name__ == "__main__":
    try:
        main()
    except AuthorityError as error:
        sys.stderr.buffer.write(canonical_bytes({"error": error.code, "message": error.message}))
        raise SystemExit(error.exit_code)
    except OSError as error:
        sys.stderr.buffer.write(canonical_bytes({"error": "AUTHORITY_OPERATION_FAILED", "message": "bounded lease-authority operation failed"}))
        raise SystemExit(70) from error
