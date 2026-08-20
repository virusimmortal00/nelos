#!/usr/bin/python3
"""Fixed-command Proxmox VE transport for one disposable golden builder.

Install one identical root-owned copy at
``/usr/libexec/nelos-proxmox-golden-builder-helper``.  Separate forced SSH
principals invoke either ``provider request`` or ``attestor request``.  The
provider is mutation-capable but idempotency-journaled; the attestor accepts
only the exact independent VM/name/volume absence query.
"""

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


BINDING_PATH = pathlib.Path("/etc/nelos-golden/builder-host-binding.json")
HELPER_PATH = pathlib.Path("/usr/libexec/nelos-proxmox-golden-builder-helper")
STATE_ROOT = pathlib.Path("/var/lib/nelos-golden-builder")
MAX_INPUT = 65_536
MAX_OUTPUT = 16_777_216
SHA256 = re.compile(r"sha256:[0-9a-f]{64}\Z")
FINGERPRINT = re.compile(r"SHA256:[A-Za-z0-9+/]{43}\Z")
VMID = re.compile(r"[1-9][0-9]{2,8}\Z")
MAC = re.compile(r"02(?::[0-9A-F]{2}){5}\Z")
OWNERSHIP = re.compile(r"nelos-golden-builder-v1:[0-9a-f]{32}\Z")
PROVIDER_ID = "proxmox-lab"
SOURCE_TEMPLATE_VMID = 9024
BUILDER_VMID = 9026
OUTPUT_TEMPLATE_VMID = 9027
BUILDER_MAC = "02:4E:45:4C:90:26"
OUTPUT_MAC = "02:4E:45:4C:90:27"
ROLE_USER = {"provider": "nelos-golden-provider", "attestor": "nelos-golden-attestor"}
ROLE_HOME = {"provider": pathlib.Path("/var/lib/nelos-golden-provider"), "attestor": pathlib.Path("/var/lib/nelos-golden-attestor")}
PROVIDER_OPERATIONS = {"preflight", "provision", "observe", "stop", "quarantine", "destroy"}
READ_OPERATIONS = {"preflight", "observe", "confirm-absent"}
CLEANUP_OPERATIONS = {"observe", "stop", "quarantine", "destroy", "confirm-absent"}


class BoundaryError(Exception):
    def __init__(self, code, message, exit_code=77):
        super().__init__(message)
        self.code = code
        self.message = message
        self.exit_code = exit_code


def fail(code, message, exit_code=77):
    raise BoundaryError(code, message, exit_code)


def exact(value, fields, label):
    if not isinstance(value, dict) or set(value) != set(fields):
        fail("INVALID_CONTRACT", f"{label} fields differ from the closed contract", 65)


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode("utf-8")


def digest(value):
    data = value if isinstance(value, bytes) else canonical(value)
    return "sha256:" + hashlib.sha256(data).hexdigest()


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


def iso_now():
    return datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def parse_time(value, label):
    if not isinstance(value, str):
        fail("INVALID_CONTRACT", f"{label} is invalid", 65)
    try:
        parsed = datetime.datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        fail("INVALID_CONTRACT", f"{label} is invalid", 65)
    if parsed.tzinfo is None:
        fail("INVALID_CONTRACT", f"{label} must include a timezone", 65)
    return parsed.timestamp()


def read_root_json(path, label):
    try:
        info = path.lstat()
        data = path.read_bytes()
    except OSError:
        fail("HOST_BINDING_UNAVAILABLE", f"{label} is unavailable", 66)
    if (not stat.S_ISREG(info.st_mode) or stat.S_ISLNK(info.st_mode) or info.st_nlink != 1 or
            info.st_uid != 0 or info.st_gid != 0 or (info.st_mode & 0o777) not in {0o400, 0o440} or
            not 2 <= len(data) <= 1_048_576):
        fail("HOST_BINDING_UNTRUSTED", f"{label} ownership, mode, type, link count, or size differs", 66)
    try:
        value = json.loads(data)
    except (UnicodeDecodeError, json.JSONDecodeError):
        fail("INVALID_JSON", f"{label} is not valid JSON", 65)
    if data != canonical(value) + b"\n":
        fail("NONCANONICAL_INPUT", f"{label} is not canonical JSON", 65)
    return value


def validate_lifecycle(value):
    exact(value, {"bindingDigest", "bridge", "builderVm", "cleanupExpiresAt", "expiresAt", "hostId", "kind", "networkAclPath", "outputTemplateMacAddress", "outputTemplateName", "outputTemplateVmId", "providerId",
                  "reservationDigest", "schemaVersion", "sourceTemplate", "storage"}, "lifecycle binding")
    exact(value["builderVm"], {"mac", "name", "ownership", "sshPublicKey", "sshPublicKeyFingerprint", "sshUser", "vmId"}, "builder VM")
    exact(value["sourceTemplate"], {"configDigest", "name", "vmId", "volumeMeasurementDigest"}, "source template")
    unsigned = dict(value)
    claimed = unsigned.pop("bindingDigest")
    if (value["schemaVersion"] != 1 or value["kind"] != "nelos-golden-builder-lifecycle" or claimed != digest(unsigned) or
            not SHA256.fullmatch(value["reservationDigest"] or "") or not SHA256.fullmatch(value["sourceTemplate"]["configDigest"] or "") or
            not SHA256.fullmatch(value["sourceTemplate"]["volumeMeasurementDigest"] or "") or
            value["builderVm"]["vmId"] != BUILDER_VMID or value["sourceTemplate"]["vmId"] != SOURCE_TEMPLATE_VMID or
            value["outputTemplateVmId"] != OUTPUT_TEMPLATE_VMID or
            value["providerId"] != PROVIDER_ID or value["outputTemplateName"] != "nelos-desktop-ubuntu-24-04-v1" or
            value["outputTemplateMacAddress"] != OUTPUT_MAC or value["builderVm"]["mac"] != BUILDER_MAC or
            not MAC.fullmatch(value["builderVm"]["mac"] or "") or not OWNERSHIP.fullmatch(value["builderVm"]["ownership"] or "") or
            value["builderVm"]["sshUser"] != "codex" or value["storage"] != "local-lvm" or value["bridge"] != "nelosbld" or
            value["networkAclPath"] != "/sdn/zones/nelosbld/nelosbld"):
        fail("INVALID_CONTRACT", "lifecycle binding identity or digest differs", 65)
    active_expiry = parse_time(value["expiresAt"], "lifecycle expiry")
    cleanup_expiry = parse_time(value["cleanupExpiresAt"], "cleanup expiry")
    if cleanup_expiry <= active_expiry or cleanup_expiry - active_expiry > 3600.001:
        fail("INVALID_CONTRACT", "cleanup expiry is outside the sealed one-hour bound", 65)
    return value


def validate_binding(value):
    exact(value, {"attestorKeyFingerprint", "attestorPublicKey", "attestorUser", "cleanupExpiresAt", "expiresAt", "helperDigest", "hostBindingDigest", "kind", "lifecycleBinding",
                  "providerKeyFingerprint", "providerPublicKey", "providerUser", "schemaVersion"}, "host binding")
    lifecycle = validate_lifecycle(value["lifecycleBinding"])
    unsigned = dict(value)
    claimed = unsigned.pop("hostBindingDigest")
    if (value["schemaVersion"] != 1 or value["kind"] != "nelos-golden-builder-host-binding" or claimed != digest(unsigned) or
            value["providerUser"] != ROLE_USER["provider"] or value["attestorUser"] != ROLE_USER["attestor"] or
            not FINGERPRINT.fullmatch(value["providerKeyFingerprint"] or "") or not FINGERPRINT.fullmatch(value["attestorKeyFingerprint"] or "") or
            public_key_fingerprint(value["providerPublicKey"], "provider public key") != value["providerKeyFingerprint"] or
            public_key_fingerprint(value["attestorPublicKey"], "attestor public key") != value["attestorKeyFingerprint"] or
            value["providerKeyFingerprint"] == value["attestorKeyFingerprint"] or not SHA256.fullmatch(value["helperDigest"] or "") or
            lifecycle["builderVm"]["sshPublicKeyFingerprint"] in {value["providerKeyFingerprint"], value["attestorKeyFingerprint"]} or
            value["expiresAt"] != lifecycle["expiresAt"] or value["cleanupExpiresAt"] != lifecycle["cleanupExpiresAt"]):
        fail("INVALID_CONTRACT", "host binding identity or digest differs", 65)
    return value


def read_request(role, binding):
    data = sys.stdin.buffer.read(MAX_INPUT + 1)
    if not 2 <= len(data) <= MAX_INPUT:
        fail("INPUT_LIMIT", "request size is outside the admitted bound", 65)
    try:
        value = json.loads(data)
    except (UnicodeDecodeError, json.JSONDecodeError):
        fail("INVALID_JSON", "request is not valid JSON", 65)
    if data != canonical(value) + b"\n":
        fail("NONCANONICAL_INPUT", "request is not canonical JSON", 65)
    exact(value, {"bindingDigest", "deadlineAt", "kind", "operation", "operationId", "requestedAt", "role", "schemaVersion"}, "request")
    lifecycle = binding["lifecycleBinding"]
    expected_operation_id = digest({"schemaVersion": 1, "kind": "nelos-golden-builder-operation", "bindingDigest": lifecycle["bindingDigest"], "operation": value["operation"]})
    allowed = PROVIDER_OPERATIONS if role == "provider" else {"preflight", "confirm-absent"}
    deadline = parse_time(value["deadlineAt"], "request deadline")
    requested = parse_time(value["requestedAt"], "request issue time")
    now = time.time()
    if (value["schemaVersion"] != 1 or value["kind"] != "nelos-golden-builder-provider-request" or value["role"] != role or
            value["operation"] not in allowed or value["bindingDigest"] != lifecycle["bindingDigest"] or value["operationId"] != expected_operation_id):
        fail("IDENTITY_MISMATCH", "request differs from the sealed role, resource, or operation", 77)
    admitted_expiry = parse_time(binding["cleanupExpiresAt"] if value["operation"] in CLEANUP_OPERATIONS else binding["expiresAt"], "host binding expiry")
    if requested > now + 1 or now - requested > 601 or requested >= deadline or now >= deadline or deadline - now > 601 or deadline > admitted_expiry + 0.001:
        fail("DEADLINE_EXPIRED", "request deadline is expired or outside the sealed lifecycle", 75)
    return value, deadline


def require_directory(path, uid, gid, mode, label):
    try:
        info = path.lstat()
    except OSError:
        fail("HOST_AUTHORITY_MISMATCH", f"{label} is unavailable", 70)
    if (not stat.S_ISDIR(info.st_mode) or stat.S_ISLNK(info.st_mode) or info.st_uid != uid or info.st_gid != gid or
            (info.st_mode & 0o777) != mode):
        fail("HOST_AUTHORITY_MISMATCH", f"{label} ownership, type, or mode differs", 70)


def require_file(path, uid, gid, modes, expected, label):
    try:
        info = path.lstat()
        data = path.read_bytes()
    except OSError:
        fail("HOST_AUTHORITY_MISMATCH", f"{label} is unavailable", 70)
    if (not stat.S_ISREG(info.st_mode) or stat.S_ISLNK(info.st_mode) or info.st_nlink != 1 or info.st_uid != uid or info.st_gid != gid or
            (info.st_mode & 0o777) not in modes or data != expected):
        fail("HOST_AUTHORITY_MISMATCH", f"{label} ownership, content, type, link count, or mode differs", 70)


def verify_helper_and_principal(binding, role):
    if pathlib.Path(os.path.realpath(sys.argv[0])) != HELPER_PATH:
        fail("HELPER_IDENTITY_MISMATCH", "forced helper path differs", 70)
    try:
        helper_info = HELPER_PATH.lstat()
        helper_bytes = HELPER_PATH.read_bytes()
    except OSError:
        fail("HELPER_IDENTITY_MISMATCH", "forced helper is unavailable", 70)
    if (not stat.S_ISREG(helper_info.st_mode) or stat.S_ISLNK(helper_info.st_mode) or helper_info.st_nlink != 1 or helper_info.st_uid != 0 or
            helper_info.st_gid != 0 or (helper_info.st_mode & 0o777) not in {0o555, 0o755} or digest(helper_bytes) != binding["helperDigest"]):
        fail("HELPER_IDENTITY_MISMATCH", "forced helper bytes, ownership, type, link count, or mode differs", 70)
    try:
        account = pwd.getpwnam(ROLE_USER[role])
    except KeyError:
        fail("HOST_AUTHORITY_MISMATCH", "forced principal account is unavailable", 70)
    home = ROLE_HOME[role]
    if pathlib.Path(account.pw_dir) != home or account.pw_shell != "/bin/sh":
        fail("HOST_AUTHORITY_MISMATCH", "forced principal home or shell differs", 70)
    require_directory(home, account.pw_uid, account.pw_gid, 0o700, "forced principal home")
    require_directory(home / ".ssh", account.pw_uid, account.pw_gid, 0o700, "forced principal SSH directory")
    suffix = binding["hostBindingDigest"][7:23]
    helper = f"/usr/libexec/nelos-proxmox-golden-builder-helper {role} request"
    key = binding["providerPublicKey"] if role == "provider" else binding["attestorPublicKey"]
    authorized = f'restrict,command="/usr/bin/sudo -n -- {helper}" {key.strip()} nelos:{role}:{suffix}\n'.encode("ascii")
    require_file(home / ".ssh" / "authorized_keys", account.pw_uid, account.pw_gid, {0o600}, authorized, "forced principal authorized_keys")
    sudoers = f"{ROLE_USER[role]} ALL=(root) NOPASSWD: {helper}\n".encode("ascii")
    require_file(pathlib.Path(f"/etc/sudoers.d/nelos-golden-builder-{role}"), 0, 0, {0o440}, sudoers, "forced principal sudoers")


def command_json(arguments, deadline, allow_404=False):
    remaining = deadline - time.time()
    if remaining <= 0:
        fail("DEADLINE_EXPIRED", "provider deadline expired", 75)
    try:
        result = subprocess.run(arguments, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                env={"PATH": "/usr/sbin:/usr/bin:/sbin:/bin", "LC_ALL": "C"}, timeout=remaining,
                                check=False, close_fds=True)
    except subprocess.TimeoutExpired:
        fail("DEADLINE_EXPIRED", "bounded Proxmox operation timed out", 75)
    if result.returncode != 0:
        stderr = result.stderr.decode("utf-8", "replace")[:4096]
        if allow_404 and ("does not exist" in stderr or "not found" in stderr.lower()):
            return None
        fail("PVE_OPERATION_FAILED", "bounded Proxmox command failed", 70)
    if len(result.stdout) > MAX_OUTPUT:
        fail("OUTPUT_LIMIT", "Proxmox response exceeds its bound", 75)
    try:
        return json.loads(result.stdout)
    except (UnicodeDecodeError, json.JSONDecodeError):
        text = result.stdout.decode("utf-8", "strict").strip()
        return text


def pvesh(verb, path, deadline, parameters=None, allow_404=False):
    args = ["/usr/bin/pvesh", verb, path, "--output-format", "json"]
    for name, value in sorted((parameters or {}).items()):
        args.extend(["--" + name, str(value)])
    return command_json(args, deadline, allow_404=allow_404)


def wait_task(node, upid, deadline):
    if not isinstance(upid, str) or not 1 <= len(upid) <= 512:
        fail("PVE_TASK_INVALID", "provider did not return one bounded task identity", 70)
    while time.time() < deadline:
        status = pvesh("get", f"/nodes/{node}/tasks/{upid}/status", deadline)
        if not isinstance(status, dict) or not isinstance(status.get("status"), str):
            fail("PVE_TASK_INVALID", "provider task status is malformed", 70)
        if status["status"] == "stopped":
            if status.get("exitstatus") not in {"OK", "completed"}:
                fail("PVE_TASK_FAILED", "provider task did not commit successfully", 70)
            return upid
        time.sleep(min(0.5, max(0, deadline - time.time())))
    fail("DEADLINE_EXPIRED", "provider task did not terminate before its deadline", 75)


def strip_digest(value):
    return {key: item for key, item in value.items() if key != "digest"} if isinstance(value, dict) else value


def inventory(lifecycle, deadline):
    items = pvesh("get", "/cluster/resources", deadline, {"type": "vm"})
    if not isinstance(items, list):
        fail("PVE_RESPONSE_INVALID", "cluster VM inventory is malformed", 70)
    result = []
    for item in items:
        if not isinstance(item, dict):
            fail("PVE_RESPONSE_INVALID", "cluster VM inventory entry is malformed", 70)
        result.append({key: item.get(key) for key in ["vmid", "name", "node", "template", "type"]})
    return result


def cluster_network_inventory(lifecycle, items, deadline):
    scanned = []
    for item in sorted((entry for entry in items if entry.get("type") == "qemu"), key=lambda entry: (str(entry.get("node")), int(entry.get("vmid") or -1))):
        node = item.get("node")
        vmid = item.get("vmid")
        if not isinstance(node, str) or not isinstance(vmid, int) or not VMID.fullmatch(str(vmid)):
            fail("PVE_RESPONSE_INVALID", "cluster QEMU identity is malformed", 70)
        vm_config = strip_digest(pvesh("get", f"/nodes/{node}/qemu/{vmid}/config", deadline))
        if not isinstance(vm_config, dict):
            fail("PVE_RESPONSE_INVALID", "cluster QEMU configuration is malformed", 70)
        macs = []
        for key, encoded in vm_config.items():
            if re.fullmatch(r"net[0-9]+", str(key)) is None:
                continue
            first = str(encoded).split(",", 1)[0]
            match = re.fullmatch(r"[A-Za-z0-9_-]+=([0-9A-Fa-f]{2}(?::[0-9A-Fa-f]{2}){5})", first)
            if match is None:
                fail("PVE_RESPONSE_INVALID", "cluster QEMU network identity is malformed", 70)
            macs.append(match.group(1).upper())
        if len(macs) != len(set(macs)):
            fail("PVE_RESPONSE_INVALID", "cluster QEMU configuration repeats a MAC address", 70)
        scanned.append({"configDigest": digest(vm_config), "macAddresses": sorted(macs), "node": node, "vmId": vmid})
    unsigned = {"complete": True, "scannedVms": scanned}
    return {**unsigned, "digest": digest(unsigned)}


def storage_content(lifecycle, deadline):
    node = lifecycle["hostId"]
    storage = lifecycle["storage"]
    items = pvesh("get", f"/nodes/{node}/storage/{storage}/content", deadline)
    if not isinstance(items, list):
        fail("PVE_RESPONSE_INVALID", "storage content is malformed", 70)
    return [{key: item.get(key) for key in ["vmid", "volid", "format", "size"] if key in item} for item in items]


def source_config(lifecycle, deadline):
    return strip_digest(pvesh("get", f"/nodes/{lifecycle['hostId']}/qemu/{lifecycle['sourceTemplate']['vmId']}/config", deadline))


def preflight(lifecycle, deadline):
    node = lifecycle["hostId"]
    storage = lifecycle["storage"]
    config = source_config(lifecycle, deadline)
    source_status = pvesh("get", f"/nodes/{node}/qemu/{lifecycle['sourceTemplate']['vmId']}/status/current", deadline)
    storage_config = pvesh("get", f"/storage/{storage}", deadline)
    storage_status = pvesh("get", f"/nodes/{node}/storage/{storage}/status", deadline)
    vnets = pvesh("get", "/cluster/sdn/vnets", deadline)
    if not all(isinstance(value, dict) for value in [config, source_status, storage_config, storage_status]) or not isinstance(vnets, list):
        fail("PVE_RESPONSE_INVALID", "preflight provider response is malformed", 70)
    matches = [item for item in vnets if isinstance(item, dict) and item.get("vnet") == lifecycle["bridge"]]
    items = inventory(lifecycle, deadline)
    return {
        "inventory": items,
        "networkInventory": cluster_network_inventory(lifecycle, items, deadline),
        "sourceConfig": config,
        "sourceStatus": {"status": source_status.get("status")},
        "storage": {
            "storage": storage, "node": node, "type": storage_config.get("type"),
            "shared": bool(storage_config.get("shared", 0)), "active": bool(storage_status.get("active", 0)),
            "enabled": not bool(storage_config.get("disable", 0)),
        },
        "storageContent": storage_content(lifecycle, deadline),
        "vnet": {
            "vnet": lifecycle["bridge"],
            "zone": matches[0].get("zone") if len(matches) == 1 else None,
            "aclPath": f"/sdn/zones/{matches[0].get('zone')}/{lifecycle['bridge']}" if len(matches) == 1 else None,
            "active": len(matches) == 1 and not bool(matches[0].get("pending", 0)),
        },
    }


def validate_provision_preflight(snapshot, lifecycle, existing_builder):
    source_vmid = lifecycle["sourceTemplate"]["vmId"]
    builder_vmid = lifecycle["builderVm"]["vmId"]
    output_vmid = lifecycle["outputTemplateVmId"]
    source_matches = [item for item in snapshot["inventory"] if int(item.get("vmid") or -1) == source_vmid or item.get("name") == lifecycle["sourceTemplate"]["name"]]
    if (len(source_matches) != 1 or int(source_matches[0].get("vmid") or -1) != source_vmid or source_matches[0].get("name") != lifecycle["sourceTemplate"]["name"] or
            source_matches[0].get("node") != lifecycle["hostId"] or int(source_matches[0].get("template") or 0) != 1 or source_matches[0].get("type") != "qemu" or
            snapshot["sourceConfig"].get("name") != lifecycle["sourceTemplate"]["name"] or int(snapshot["sourceConfig"].get("template") or 0) != 1 or
            digest(snapshot["sourceConfig"]) != lifecycle["sourceTemplate"]["configDigest"] or snapshot["sourceStatus"].get("status") != "stopped"):
        fail("SOURCE_IDENTITY_MISMATCH", "source template identity changed immediately before provision", 77)
    collisions = [item for item in snapshot["inventory"] if int(item.get("vmid") or -1) == output_vmid or item.get("name") == lifecycle["outputTemplateName"]]
    collisions += [item for item in snapshot["inventory"] if item.get("name") == lifecycle["builderVm"]["name"] and existing_builder is None]
    collisions += [item for item in snapshot["inventory"] if int(item.get("vmid") or -1) == builder_vmid and existing_builder is None]
    volume_pattern = re.compile(rf"(?:base|vm)-(?:{builder_vmid}|{output_vmid})-")
    volume_collisions = [item for item in snapshot["storageContent"] if int(item.get("vmid") or -1) == output_vmid or
                         (existing_builder is None and int(item.get("vmid") or -1) == builder_vmid) or
                         (volume_pattern.search(str(item.get("volid", ""))) is not None and
                          (existing_builder is None or f"-{output_vmid}-" in str(item.get("volid", ""))))]
    if collisions or volume_collisions:
        fail("RESOURCE_COLLISION", "builder or output identity changed immediately before provision", 77)
    scanned_macs = [mac for item in snapshot["networkInventory"]["scannedVms"] for mac in item["macAddresses"]]
    if lifecycle["builderVm"]["mac"] in scanned_macs or lifecycle["outputTemplateMacAddress"] in scanned_macs:
        fail("RESOURCE_COLLISION", "builder or output MAC changed immediately before provision", 77)
    storage = snapshot["storage"]
    if (storage != {"storage": lifecycle["storage"], "node": lifecycle["hostId"], "type": "lvmthin", "shared": False, "active": True, "enabled": True} or
            snapshot["vnet"] != {"vnet": lifecycle["bridge"], "zone": "nelosbld", "aclPath": lifecycle["networkAclPath"], "active": True}):
        fail("INFRASTRUCTURE_IDENTITY_MISMATCH", "storage or VNet changed immediately before provision", 77)


def status(lifecycle, deadline, allow_absent=False):
    return pvesh("get", f"/nodes/{lifecycle['hostId']}/qemu/{lifecycle['builderVm']['vmId']}/status/current", deadline, allow_404=allow_absent)


def config(lifecycle, deadline, allow_absent=False):
    return strip_digest(pvesh("get", f"/nodes/{lifecycle['hostId']}/qemu/{lifecycle['builderVm']['vmId']}/config", deadline, allow_404=allow_absent))


def config_owned(value, lifecycle, allow_quarantined=False):
    if not isinstance(value, dict):
        return False
    expected_tags = {"disposable", "nelos-golden-builder", "nelos-builder-" + lifecycle["builderVm"]["ownership"][-32:]}
    actual_tags = set(str(value.get("tags", "")).split(";")) - {""}
    network = str(value.get("net0", "")).split(",")
    base = (value.get("name") == lifecycle["builderVm"]["name"] and value.get("description") == lifecycle["builderVm"]["ownership"] and
            int(value.get("template", 0)) == 0 and int(value.get("onboot", 0)) == 0 and value.get("ciuser") == lifecycle["builderVm"]["sshUser"] and
            f"virtio={lifecycle['builderVm']['mac']}" in network and f"bridge={lifecycle['bridge']}" in network and "firewall=1" in network)
    if allow_quarantined and base and int(value.get("protection", 0)) == 1 and "link_down=1" in network:
        return actual_tags == expected_tags | {"quarantined", "do-not-reuse"}
    return base and int(value.get("protection", 0)) == 0 and actual_tags == expected_tags


def state_dir(binding):
    path = STATE_ROOT / binding["hostBindingDigest"][7:]
    try:
        STATE_ROOT.mkdir(mode=0o700)
    except FileExistsError:
        pass
    require_directory(STATE_ROOT, 0, 0, 0o700, "builder state root")
    try:
        path.mkdir(mode=0o700)
    except FileExistsError:
        pass
    require_directory(path, 0, 0, 0o700, "builder binding state")
    return path


def atomic_json(path, value):
    data = canonical(value) + b"\n"
    temporary = path.with_name("." + path.name + "." + os.urandom(8).hex() + ".tmp")
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0), 0o400)
    try:
        os.write(fd, data)
        os.fsync(fd)
        os.fchmod(fd, 0o400)
    finally:
        os.close(fd)
    os.replace(temporary, path)
    directory_fd = os.open(path.parent, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
    try:
        os.fsync(directory_fd)
    finally:
        os.close(directory_fd)


def guest_cache_path(binding):
    return state_dir(binding) / "guest-identity.json"


def qm_guest(lifecycle, command, arguments, deadline):
    args = ["/usr/sbin/qm", "guest", "exec", str(lifecycle["builderVm"]["vmId"]), "--", command] + arguments
    result = command_json(args, deadline)
    if isinstance(result, dict):
        output = result.get("out-data", result.get("stdout", ""))
    else:
        output = result
    if not isinstance(output, str) or len(output) > 65_536:
        fail("QGA_RESPONSE_INVALID", "guest command response is malformed", 70)
    return output.strip()


def collect_guest(binding, lifecycle, deadline):
    while time.time() < deadline:
        try:
            pvesh("get", f"/nodes/{lifecycle['hostId']}/qemu/{lifecycle['builderVm']['vmId']}/agent/ping", deadline)
            os_release = qm_guest(lifecycle, "/usr/bin/cat", ["/etc/os-release"], deadline)
            release = next((line.split("=", 1)[1].strip('"') for line in os_release.splitlines() if line.startswith("VERSION_ID=")), None)
            operating_system = next((line.split("=", 1)[1].strip('"') for line in os_release.splitlines() if line.startswith("ID=")), None)
            architecture = qm_guest(lifecycle, "/usr/bin/uname", ["-m"], deadline)
            cloud_status = qm_guest(lifecycle, "/usr/bin/cloud-init", ["status"], deadline)
            host_key = qm_guest(lifecycle, "/usr/bin/ssh-keygen", ["-lf", "/etc/ssh/ssh_host_ed25519_key.pub", "-E", "sha256"], deadline)
            host_public_key = qm_guest(lifecycle, "/usr/bin/awk", ["NR == 1 { print $1, $2 }", "/etc/ssh/ssh_host_ed25519_key.pub"], deadline)
            network_json = qm_guest(lifecycle, "/usr/bin/ip", ["-j", "-4", "address", "show", "scope", "global"], deadline)
            host_fingerprint = host_key.split()[1] if len(host_key.split()) >= 2 else None
            try:
                network = json.loads(network_json)
            except json.JSONDecodeError:
                network = []
            addresses = sorted({entry.get("local") for interface in network if isinstance(interface, dict)
                                for entry in interface.get("addr_info", []) if isinstance(entry, dict) and entry.get("family") == "inet" and
                                isinstance(entry.get("local"), str) and re.fullmatch(r"10\.77\.77\.(?:[1-9]|[1-9][0-9]|1[0-9]{2}|2[0-4][0-9]|25[0-4])", entry["local"])})
            if (operating_system == "ubuntu" and release == "24.04" and architecture == "x86_64" and "done" in cloud_status and
                    FINGERPRINT.fullmatch(host_fingerprint or "") and re.fullmatch(r"ssh-ed25519 [A-Za-z0-9+/]+={0,2}", host_public_key) and len(addresses) == 1):
                guest = {"architecture": architecture, "cloudInitStatus": "done", "hostKeyFingerprint": host_fingerprint,
                         "hostPublicKey": host_public_key, "operatingSystem": "linux", "qga": True, "release": release, "sshAddress": addresses[0]}
                atomic_json(guest_cache_path(binding), guest)
                return guest
        except BoundaryError as error:
            if error.code == "DEADLINE_EXPIRED":
                raise
        time.sleep(min(1, max(0, deadline - time.time())))
    fail("DEADLINE_EXPIRED", "builder QGA or Cloud-Init readiness did not converge", 75)


def read_guest_cache(binding):
    path = guest_cache_path(binding)
    try:
        info = path.lstat()
        value = json.loads(path.read_bytes())
    except (OSError, json.JSONDecodeError):
        return None
    if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_uid != 0 or (info.st_mode & 0o777) != 0o400:
        return None
    exact_fields = {"architecture", "cloudInitStatus", "hostKeyFingerprint", "hostPublicKey", "operatingSystem", "qga", "release", "sshAddress"}
    return value if isinstance(value, dict) and set(value) == exact_fields and FINGERPRINT.fullmatch(value.get("hostKeyFingerprint", "")) else None


def observe(binding, lifecycle, deadline):
    current_config = config(lifecycle, deadline, allow_absent=True)
    if current_config is None:
        return {"config": None, "guest": None, "status": "absent"}
    current_status = status(lifecycle, deadline)
    if not isinstance(current_status, dict) or current_status.get("status") not in {"running", "stopped"}:
        fail("PVE_RESPONSE_INVALID", "builder status is malformed", 70)
    guest = collect_guest(binding, lifecycle, deadline) if current_status["status"] == "running" else read_guest_cache(binding)
    if guest is None:
        fail("BUILDER_IDENTITY_UNAVAILABLE", "stopped builder has no sealed prior guest identity", 70)
    return {"config": current_config, "guest": guest, "status": current_status["status"]}


def task_result(value, node, deadline, tasks):
    upid = value.get("data") if isinstance(value, dict) else value
    tasks.append(wait_task(node, upid, deadline))


def operation_paths(binding, request):
    root = state_dir(binding)
    name = request["operation"]
    return root / f"{name}.intent.json", root / f"{name}.receipt.json"


def existing_receipt(path, request):
    if not path.exists():
        return None
    value = read_root_json(path, "operation receipt")
    if value.get("operationId") != request["operationId"] or value.get("bindingDigest") != request["bindingDigest"]:
        fail("JOURNAL_MISMATCH", "existing operation receipt belongs to another identity", 70)
    return value


def ensure_intent(path, request):
    value = {"schemaVersion": 1, "kind": "nelos-golden-builder-mutation-intent", "bindingDigest": request["bindingDigest"],
             "operation": request["operation"], "operationId": request["operationId"]}
    if path.exists():
        if read_root_json(path, "mutation intent") != value:
            fail("JOURNAL_MISMATCH", "existing mutation intent differs", 70)
    else:
        atomic_json(path, value)


def receipt(request, status_value, provider_operation_id, payload):
    unsigned = {"schemaVersion": 1, "kind": "nelos-golden-builder-provider-receipt", "role": request["role"],
                "operation": request["operation"], "operationId": request["operationId"], "bindingDigest": request["bindingDigest"],
                "status": status_value, "providerOperationId": provider_operation_id, "observedAt": iso_now(),
                "payload": payload, "payloadDigest": digest(payload)}
    return {**unsigned, "receiptDigest": digest(unsigned)}


def mutation(binding, lifecycle, request, deadline):
    intent_path, receipt_path = operation_paths(binding, request)
    previous = existing_receipt(receipt_path, request)
    if previous is not None:
        return previous
    node = lifecycle["hostId"]
    vmid = lifecycle["builderVm"]["vmId"]
    tasks = []
    operation = request["operation"]
    current = config(lifecycle, deadline, allow_absent=True)

    if operation == "provision":
        validate_provision_preflight(preflight(lifecycle, deadline), lifecycle, current)
    ensure_intent(intent_path, request)

    if operation == "provision":
        if current is None:
            result = pvesh("create", f"/nodes/{node}/qemu/{lifecycle['sourceTemplate']['vmId']}/clone", deadline, {
                "newid": vmid, "target": node, "full": 1, "storage": lifecycle["storage"], "name": lifecycle["builderVm"]["name"],
                "description": lifecycle["builderVm"]["ownership"],
            })
            task_result(result, node, deadline, tasks)
            current = config(lifecycle, deadline)
        if current.get("name") != lifecycle["builderVm"]["name"] or current.get("description") != lifecycle["builderVm"]["ownership"]:
            fail("BUILDER_OWNERSHIP_UNPROVEN", "existing builder cannot be adopted by the mutation intent", 77)
        tags = ";".join(sorted({"disposable", "nelos-golden-builder", "nelos-builder-" + lifecycle["builderVm"]["ownership"][-32:]}))
        configured = pvesh("set", f"/nodes/{node}/qemu/{vmid}/config", deadline, {
            "agent": "enabled=1,fstrim_cloned_disks=1", "onboot": 0, "protection": 0, "ciuser": lifecycle["builderVm"]["sshUser"],
            "sshkeys": lifecycle["builderVm"]["sshPublicKey"], "tags": tags,
            "net0": f"virtio={lifecycle['builderVm']['mac']},bridge={lifecycle['bridge']},firewall=1", "ipconfig0": "ip=dhcp",
            "description": lifecycle["builderVm"]["ownership"],
        })
        if configured is not None and configured != "" and configured is not True:
            task_result(configured, node, deadline, tasks)
        current_status = status(lifecycle, deadline)
        if current_status.get("status") != "running":
            task_result(pvesh("create", f"/nodes/{node}/qemu/{vmid}/status/start", deadline), node, deadline, tasks)
        observed = observe(binding, lifecycle, deadline)
        if not config_owned(observed["config"], lifecycle) or observed["status"] != "running":
            fail("BUILDER_OWNERSHIP_UNPROVEN", "provisioned builder identity differs", 77)
        payload = {"taskDigests": [digest(item) for item in tasks], "observationDigest": digest(observed)}
        result = receipt(request, "committed", "pve:provision:" + request["operationId"][7:23], payload)
    elif operation == "stop":
        if current is None or not config_owned(current, lifecycle):
            fail("BUILDER_OWNERSHIP_UNPROVEN", "builder ownership cannot authorize stop", 77)
        current_status = status(lifecycle, deadline)
        if current_status.get("status") == "running":
            task_result(pvesh("create", f"/nodes/{node}/qemu/{vmid}/status/stop", deadline), node, deadline, tasks)
        elif current_status.get("status") != "stopped":
            fail("PVE_RESPONSE_INVALID", "builder state cannot reconcile stop", 70)
        result = receipt(request, "committed", "pve:stop:" + request["operationId"][7:23], {"taskDigests": [digest(item) for item in tasks]})
    elif operation == "quarantine":
        if current is None or not config_owned(current, lifecycle):
            fail("BUILDER_OWNERSHIP_UNPROVEN", "builder ownership cannot authorize quarantine", 77)
        current_status = status(lifecycle, deadline)
        if current_status.get("status") == "running":
            task_result(pvesh("create", f"/nodes/{node}/qemu/{vmid}/status/stop", deadline), node, deadline, tasks)
        tags = ";".join(sorted({"disposable", "nelos-golden-builder", "nelos-builder-" + lifecycle["builderVm"]["ownership"][-32:], "quarantined", "do-not-reuse"}))
        changed = pvesh("set", f"/nodes/{node}/qemu/{vmid}/config", deadline, {
            "onboot": 0, "protection": 1, "tags": tags,
            "net0": f"virtio={lifecycle['builderVm']['mac']},bridge={lifecycle['bridge']},firewall=1,link_down=1",
            "description": lifecycle["builderVm"]["ownership"],
        })
        if changed is not None and changed != "" and changed is not True:
            task_result(changed, node, deadline, tasks)
        if not config_owned(config(lifecycle, deadline), lifecycle, allow_quarantined=True):
            fail("BUILDER_QUARANTINE_UNPROVEN", "builder quarantine identity differs", 70)
        result = receipt(request, "quarantined", "pve:quarantine:" + request["operationId"][7:23], {"taskDigests": [digest(item) for item in tasks]})
    elif operation == "destroy":
        if current is not None:
            if not config_owned(current, lifecycle) or status(lifecycle, deadline).get("status") != "stopped":
                fail("BUILDER_OWNERSHIP_UNPROVEN", "exact stopped builder identity is required for destroy", 77)
            task_result(pvesh("delete", f"/nodes/{node}/qemu/{vmid}", deadline, {"purge": 1, "destroy-unreferenced-disks": 1}), node, deadline, tasks)
        result = receipt(request, "committed", "pve:destroy:" + request["operationId"][7:23], {"taskDigests": [digest(item) for item in tasks]})
    else:
        fail("INVALID_OPERATION", "mutation operation is unavailable", 64)
    atomic_json(receipt_path, result)
    return result


def absence(lifecycle, deadline):
    vmid = lifecycle["builderVm"]["vmId"]
    name = lifecycle["builderVm"]["name"]
    items = inventory(lifecycle, deadline)
    contents = storage_content(lifecycle, deadline)
    vm_absent = all(int(item.get("vmid") or -1) != vmid for item in items)
    name_absent = all(item.get("name") != name for item in items)
    volume_pattern = re.compile(rf"(?:base|vm)-{vmid}-")
    volumes_absent = all(int(item.get("vmid") or -1) != vmid and volume_pattern.search(str(item.get("volid", ""))) is None for item in contents)
    return {"vmAbsent": vm_absent, "nameAbsent": name_absent, "volumesAbsent": volumes_absent,
            "inventoryDigest": digest(items), "storageContentDigest": digest(contents)}


def main():
    if os.geteuid() != 0:
        fail("ROOT_REQUIRED", "golden-builder helper requires root", 77)
    if len(sys.argv) != 3 or sys.argv[1] not in ROLE_USER or sys.argv[2] != "request":
        fail("INVALID_OPERATION", "only one fixed role request is supported", 64)
    role = sys.argv[1]
    if os.environ.get("SUDO_USER") != ROLE_USER[role]:
        fail("CALLER_IDENTITY_MISMATCH", "forced helper caller differs from the sealed role", 77)
    binding = validate_binding(read_root_json(BINDING_PATH, "builder host binding"))
    verify_helper_and_principal(binding, role)
    request, deadline = read_request(role, binding)
    lifecycle = binding["lifecycleBinding"]
    operation = request["operation"]
    if operation == "preflight":
        result = receipt(request, "observed", None, preflight(lifecycle, deadline))
    elif operation == "observe":
        result = receipt(request, "observed", None, observe(binding, lifecycle, deadline))
    elif operation == "confirm-absent":
        result = receipt(request, "observed", None, absence(lifecycle, deadline))
    else:
        result = mutation(binding, lifecycle, request, deadline)
    data = canonical(result) + b"\n"
    if len(data) > MAX_OUTPUT:
        fail("OUTPUT_LIMIT", "helper receipt exceeds its output bound", 75)
    sys.stdout.buffer.write(data)


if __name__ == "__main__":
    try:
        main()
    except BoundaryError as error:
        sys.stderr.write(json.dumps({"error": error.code, "message": error.message}, separators=(",", ":")) + "\n")
        sys.exit(error.exit_code)
    except Exception:
        sys.stderr.write('{"error":"HELPER_FAILED","message":"golden-builder helper failed closed"}\n')
        sys.exit(70)
