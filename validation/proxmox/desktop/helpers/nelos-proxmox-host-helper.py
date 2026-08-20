#!/usr/bin/python3
import base64
import binascii
import datetime
import fcntl
import json
import os
import re
import stat
import subprocess
import sys
import time
import urllib.parse

ROOT = os.environ.get("NELOS_DESKTOP_HELPER_ROOT", "/")
BINDING_FIELDS = ["automationUser", "fencingToken", "gatewayId", "hostId", "imageId", "leaseId", "macAddress", "networkId", "networkPolicyDigest", "providerId", "runId", "stateRoot", "vmId"]
ATSPI_OPERATIONS = {
    "list_tasks", "activate_expected_task", "active_task", "click", "keypress", "scroll", "select_menu", "type_text", "wait_for",
    "accessibility_tree", "window_state", "query_element", "task_state", "text_present", "window_count", "protected_capture_regions",
    "capture_evidence", "expected_task_visible", "observe_task_surface", "observe_archive_surface", "health", "gui_ready", "auth_status", "diagnostics",
    "prepare_expected_task", "read_prepared_task", "reconcile_prepared_task", "observe_native_task", "observe_mcp_task", "observe_native_archive", "observe_mcp_archive",
}
ARCHIVE_OPERATIONS = {"archive_tasks", "restart_desktop", "reconcile_convergence"}
AUTH_OPERATIONS = {"start", "status", "cancel"}
CREDENTIAL_BOUNDARY_OPERATIONS = {"prepare", "attest", "scrub"}
MAX_REQUEST_BYTES = 33_554_432
LEASE_AUTHORITY_HELPER = "/usr/libexec/nelos-proxmox-lease-authority"
LEASE_AUTHORITY_LOCK = "/var/lib/nelos-lease-authority/.lock"
PRODUCTION_PROVIDER_ID = "proxmox-lab"
PRODUCTION_HOST_ID = "prox2"
PRODUCTION_GATEWAY_ID = "9023"
PRODUCTION_NETWORK_ID = "nelosbld"


def at(path):
    return path if ROOT == "/" else f"{ROOT}{path}"


def die(exit_code, code, message):
    sys.stderr.write(json.dumps({"error": code, "message": message}, separators=(",", ":")) + "\n")
    raise SystemExit(exit_code)


def same_fields(value, fields):
    return isinstance(value, dict) and set(value) == set(fields)


def safe_id(value):
    return isinstance(value, str) and re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._:-]{0,127}", value) is not None


def parse_time(value):
    if not isinstance(value, str):
        return None
    try:
        return datetime.datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp() * 1000
    except ValueError:
        return None


def observe_mac_absence(expected, pvesh, deadline_ms, maximum):
    def pve_get(path, query=()):
        remaining = (deadline_ms - datetime.datetime.now(datetime.timezone.utc).timestamp() * 1000) / 1000
        if remaining <= 0:
            die(75, "DEADLINE_EXPIRED", "MAC absence scan exceeded its deadline")
        args = [pvesh, "get", path, "--output-format", "json"]
        for key, value in query:
            args.extend([f"--{key}", value])
        try:
            result = subprocess.run(args, stdin=subprocess.DEVNULL, capture_output=True, timeout=remaining, check=True,
                                    env={"PATH": "/usr/sbin:/usr/bin:/sbin:/bin"})
        except (subprocess.TimeoutExpired, subprocess.CalledProcessError):
            die(70, "MAC_ABSENCE_UNAVAILABLE", "complete Proxmox MAC inventory is unavailable")
        if result.stderr or len(result.stdout) > maximum:
            die(70, "MAC_ABSENCE_UNAVAILABLE", "bounded Proxmox MAC inventory is invalid")
        try:
            return json.loads(result.stdout.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            die(70, "MAC_ABSENCE_UNAVAILABLE", "Proxmox MAC inventory is not JSON")

    resources = pve_get("/cluster/resources", (("type", "vm"),))
    if not isinstance(resources, list) or len(resources) > 512:
        die(70, "MAC_ABSENCE_UNAVAILABLE", "cluster VM inventory is incomplete or exceeds its bound")
    qemu = []
    seen = set()
    for item in resources:
        if not isinstance(item, dict) or item.get("type") not in {"qemu", "lxc"}:
            die(70, "MAC_ABSENCE_UNAVAILABLE", "cluster VM inventory contains an unknown resource")
        if item["type"] != "qemu":
            continue
        node = item.get("node")
        vmid = str(item.get("vmid"))
        identity = (node, vmid)
        if not safe_id(node) or re.fullmatch(r"[1-9][0-9]{2,8}", vmid) is None or identity in seen:
            die(70, "MAC_ABSENCE_UNAVAILABLE", "cluster QEMU inventory identity is invalid or duplicated")
        seen.add(identity)
        qemu.append(identity)
    target = expected["macAddress"].upper()
    present = False
    for node, vmid in qemu:
        config = pve_get(f"/nodes/{node}/qemu/{vmid}/config")
        if not isinstance(config, dict):
            die(70, "MAC_ABSENCE_UNAVAILABLE", "QEMU network configuration is invalid")
        for key, value in config.items():
            if re.fullmatch(r"net[0-9]+", key) is None:
                continue
            if not isinstance(value, str):
                die(70, "MAC_ABSENCE_UNAVAILABLE", "QEMU network configuration is invalid")
            for token in value.split(","):
                if "=" in token and token.split("=", 1)[1].upper() == target:
                    present = True
    return {
        "absent": not present,
        "complete": True,
        "kind": "nelos.proxmox-desktop.mac-absence.v1",
        "macAddress": expected["macAddress"],
        "networkId": expected["networkId"],
        "scannedQemuCount": len(qemu),
        "schemaVersion": 1,
    }
def canonical_base64(value, max_bytes, label, allow_empty=False):
    if not isinstance(value, str) or (not value and not allow_empty) or len(value) % 4 != 0 or re.fullmatch(r"(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?", value) is None:
        die(65, "INVALID_CONTRACT", f"{label} is not canonical base64")
    try:
        decoded = base64.b64decode(value, validate=True)
    except binascii.Error:
        die(65, "INVALID_CONTRACT", f"{label} is not canonical base64")
    if len(decoded) > max_bytes or base64.b64encode(decoded).decode("ascii") != value:
        die(65, "INPUT_LIMIT", f"{label} exceeds its decoded bound")
    return decoded


def trusted_json(path):
    info = os.lstat(path)
    if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or (ROOT == "/" and (info.st_uid != 0 or info.st_mode & 0o022)) or info.st_size > 16_384:
        raise ValueError("untrusted configuration")
    with open(path, "r", encoding="utf-8") as handle:
        return json.load(handle)


def exact_body(body, fields, label):
    if not same_fields(body, fields):
        die(77, "FORBIDDEN_PROVIDER_OPERATION", f"{label} body fields differ from the allowlist")


def owned_description(value, fields, label):
    prefix = "nelos-desktop-v1:"
    if not isinstance(value, str) or not value.startswith(prefix):
        die(77, "IDENTITY_MISMATCH", f"{label} ownership description is invalid")
    encoded = value[len(prefix):]
    if not encoded or re.fullmatch(r"[A-Za-z0-9_-]{1,21846}", encoded) is None:
        die(77, "IDENTITY_MISMATCH", f"{label} ownership description is invalid")
    try:
        payload = base64.urlsafe_b64decode(encoded + "=" * (-len(encoded) % 4))
        if base64.urlsafe_b64encode(payload).decode("ascii").rstrip("=") != encoded or len(payload) > 16_384:
            raise ValueError("noncanonical description")
        value = json.loads(payload)
    except (ValueError, binascii.Error, UnicodeDecodeError, json.JSONDecodeError):
        die(77, "IDENTITY_MISMATCH", f"{label} ownership description is invalid")
    if not same_fields(value, fields):
        die(77, "IDENTITY_MISMATCH", f"{label} ownership description fields differ")
    return value


def provider_identity(description, expected):
    return all(description.get(field) == expected[field] for field in (
        "providerId", "hostId", "vmId", "macAddress", "networkId", "gatewayId", "networkPolicyDigest", "leaseId", "fencingToken",
    ))


def validate_guest_envelope(encoded, expected, operation, max_deadline_ms):
    payload = canonical_base64(encoded, 16_777_216, "QGA input-data")
    newline = payload.find(b"\n")
    if newline < 0 or newline > 65_536:
        die(65, "INVALID_CONTRACT", "QGA helper header is missing")
    try:
        header = json.loads(payload[:newline])
    except (UnicodeDecodeError, json.JSONDecodeError):
        die(65, "INVALID_CONTRACT", "QGA helper header is invalid")
    if (not same_fields(header, ["binding", "byteLength", "deadlineAt", "maxOutputBytes", "operation", "payload", "schemaVersion"]) or
            header.get("schemaVersion") != 1 or not same_fields(header.get("binding"), BINDING_FIELDS) or header.get("binding") != expected or
            header.get("operation") != operation or not isinstance(header.get("byteLength"), int) or isinstance(header.get("byteLength"), bool) or
            header.get("byteLength") != len(payload) - newline - 1 or not isinstance(header.get("maxOutputBytes"), int) or
            isinstance(header.get("maxOutputBytes"), bool) or not 1 <= header.get("maxOutputBytes") <= 16_777_216 or
            not isinstance(header.get("payload"), dict)):
        die(77, "IDENTITY_MISMATCH", "QGA helper envelope differs from the admitted operation")
    deadline = parse_time(header.get("deadlineAt"))
    remaining = deadline - datetime.datetime.now(datetime.timezone.utc).timestamp() * 1000 if deadline is not None else -1
    if remaining <= 0 or remaining > max_deadline_ms:
        die(75, "DEADLINE_EXPIRED", "QGA helper deadline is invalid")


def validate_body(method, path, body, body_present, expected, template):
    vm_base = f"/nodes/{expected['hostId']}/qemu/{expected['vmId']}"
    if method == "GET":
        if body_present:
            die(77, "FORBIDDEN_PROVIDER_OPERATION", "GET requests cannot contain a body")
        return
    if path == f"/nodes/{expected['hostId']}/qemu/{template}/clone":
        exact_body(body, ["description", "full", "name", "newid", "node", "target"], "clone")
        description = owned_description(body.get("description"), ["fencingToken", "gatewayId", "hostId", "imageId", "leaseId", "macAddress", "networkId", "networkPolicyDigest", "providerId", "state", "vmId"], "clone")
        if (str(body.get("newid")) != expected["vmId"] or body.get("node") != expected["hostId"] or body.get("target") != expected["hostId"] or
                body.get("full") not in (0, 1) or re.fullmatch(r"nelos-desktop-[1-9][0-9]{2,8}", body.get("name", "")) is None or
                not provider_identity(description, expected) or description.get("imageId") != expected["imageId"] or description.get("state") != "created"):
            die(77, "IDENTITY_MISMATCH", "clone body differs from the admitted VM")
        return
    if path == f"{vm_base}/config":
        configuring = "agent" in body
        fields = (["agent", "ciuser", "description", "net0", "node", "onboot", "protection", "tags"] if configuring else
                  ["description", "net0", "node", "onboot", "protection", "tags"])
        exact_body(body, fields, "VM configuration")
        description_fields = (["automationUser", "fencingToken", "gatewayId", "hostId", "imageId", "leaseId", "macAddress", "networkId", "networkPolicyDigest", "providerId", "runId", "state", "stateRoot", "vmId"]
                              if configuring else
                              ["fencingToken", "gatewayId", "hostId", "imageId", "leaseId", "macAddress", "networkId", "networkPolicyDigest", "providerId", "quarantined", "reason", "state", "vmId"])
        description = owned_description(body.get("description"), description_fields, "VM configuration")
        common = body.get("node") == expected["hostId"] and provider_identity(description, expected) and body.get("onboot") == 0
        configured = (configuring and body.get("agent") == "enabled=1,fstrim_cloned_disks=1" and
                      body.get("ciuser") == expected["automationUser"] and body.get("protection") == 0 and
                      body.get("tags") == "nelos-desktop;disposable;automation-only" and
                      body.get("net0") == f"virtio={expected['macAddress']},bridge={expected['networkId']},firewall=1" and
                      all(description.get(field) == expected[field] for field in ("automationUser", "imageId", "runId", "stateRoot")) and
                      description.get("state") == "configured")
        quarantined = (not configuring and body.get("net0") == f"virtio={expected['macAddress']},bridge={expected['networkId']},link_down=1,firewall=1" and body.get("protection") == 1 and
                       body.get("tags") == "nelos-desktop;quarantined;do-not-reuse" and description.get("imageId") == expected["imageId"] and
                       description.get("quarantined") is True and description.get("state") == "quarantined" and
                       isinstance(description.get("reason"), str) and 1 <= len(description["reason"]) <= 128)
        if not common or not (configured or quarantined):
            die(77, "IDENTITY_MISMATCH", "VM configuration body is not allowlisted")
        return
    if path in (f"{vm_base}/status/start", f"{vm_base}/status/stop"):
        exact_body(body, ["node"], "VM power")
        if body.get("node") != expected["hostId"]:
            die(77, "IDENTITY_MISMATCH", "VM power node differs")
        return
    if method == "DELETE" and path == vm_base:
        exact_body(body, ["destroy-unreferenced-disks", "node", "purge"], "VM destroy")
        if body.get("node") != expected["hostId"] or body.get("purge") != 1 or body.get("destroy-unreferenced-disks") != 1:
            die(77, "IDENTITY_MISMATCH", "VM destroy body differs")
        return
    if path.startswith(f"{vm_base}/agent/") and path != f"{vm_base}/agent/exec":
        if body_present:
            die(77, "FORBIDDEN_PROVIDER_OPERATION", "QGA read control cannot contain a body")
        return
    if path == f"{vm_base}/agent/exec":
        command = body.get("command")
        arguments = body.get("extra-args")
        if command == "/usr/libexec/nelos-bind-runtime":
            exact_body(body, ["capture-output", "command", "extra-args"], "runtime bind")
            if body.get("capture-output") not in (1, True) or not isinstance(arguments, list) or len(arguments) != 1:
                die(65, "INVALID_CONTRACT", "runtime bind arguments are invalid")
            try:
                binding = json.loads(canonical_base64(arguments[0], 16_384, "runtime binding"))
            except (UnicodeDecodeError, json.JSONDecodeError):
                die(65, "INVALID_CONTRACT", "runtime binding is invalid")
            if not same_fields(binding, BINDING_FIELDS) or binding != expected:
                die(77, "IDENTITY_MISMATCH", "runtime binding differs")
            return
        if command == "/usr/libexec/nelos-device-auth":
            exact_body(body, ["capture-output", "command", "extra-args"], "device auth")
            if body.get("capture-output") not in (1, True) or not isinstance(arguments, list) or len(arguments) != 1 or arguments[0] not in AUTH_OPERATIONS:
                die(77, "FORBIDDEN_PROVIDER_OPERATION", "device-auth operation is not allowlisted")
            return
        if command == "/usr/libexec/nelos-credential-boundary":
            exact_body(body, ["capture-output", "command", "extra-args"], "credential boundary")
            if (body.get("capture-output") not in (1, True) or not isinstance(arguments, list) or len(arguments) != 1 or
                    arguments[0] not in CREDENTIAL_BOUNDARY_OPERATIONS):
                die(77, "FORBIDDEN_PROVIDER_OPERATION", "credential-boundary operation is not allowlisted")
            return
        if command == "/usr/libexec/nelos-desktop-identity":
            exact_body(body, ["capture-output", "command", "extra-args"], "installed Desktop identity")
            if body.get("capture-output") not in (1, True) or arguments != []:
                die(77, "FORBIDDEN_PROVIDER_OPERATION", "installed Desktop identity arguments are not allowlisted")
            return
        operations = ATSPI_OPERATIONS if command == "/usr/libexec/nelos-desktop-atspi" else ARCHIVE_OPERATIONS if command == "/usr/libexec/nelos-desktop-archive" else None
        exact_body(body, ["capture-output", "command", "extra-args", "input-data"], "guest helper")
        if operations is None or body.get("capture-output") not in (1, True) or not isinstance(arguments, list) or len(arguments) != 1 or arguments[0] not in operations:
            die(77, "FORBIDDEN_PROVIDER_OPERATION", "guest command or operation is not allowlisted")
        validate_guest_envelope(body.get("input-data"), expected, arguments[0], 3_600_000 if command.endswith("archive") else 600_000)
        return
    die(77, "FORBIDDEN_PROVIDER_OPERATION", "provider body route is not allowlisted")


def validate_qga_response(path, data, max_output_bytes):
    if path.endswith("/agent/exec"):
        if not same_fields(data, ["pid"]) or not isinstance(data.get("pid"), int) or isinstance(data.get("pid"), bool) or data["pid"] < 1:
            die(70, "HELPER_FAILED", "QGA exec response is invalid")
        return
    if not path.endswith("/agent/exec-status"):
        return
    allowed = {"err-data", "err-truncated", "exitcode", "exited", "out-data", "out-truncated", "signal"}
    if not isinstance(data, dict) or not set(data).issubset(allowed) or data.get("exited") not in (0, 1, False, True):
        die(70, "HELPER_FAILED", "QGA exec-status response is invalid")
    for field in ("out-truncated", "err-truncated"):
        if field in data:
            value = data[field]
            if not isinstance(value, (bool, int)) or isinstance(value, int) and not isinstance(value, bool) and value not in (0, 1):
                die(70, "HELPER_FAILED", "QGA truncation status is invalid")
            if value in (True, 1):
                die(75, "HELPER_OUTPUT_LIMIT", "QGA reported truncated helper output")
    stdout = canonical_base64(data["out-data"], max_output_bytes, "QGA stdout", True) if "out-data" in data else b""
    stderr = canonical_base64(data["err-data"], max_output_bytes, "QGA stderr", True) if "err-data" in data else b""
    if len(stdout) + len(stderr) > max_output_bytes:
        die(75, "HELPER_OUTPUT_LIMIT", "combined QGA output exceeds its bound")
    exited = data.get("exited") in (1, True)
    exit_identities = [field for field in ("exitcode", "signal") if field in data]
    if not exited and set(data) != {"exited"}:
        die(70, "HELPER_FAILED", "nonterminal QGA status contains terminal output")
    if exited and (len(exit_identities) != 1 or isinstance(data[exit_identities[0]], bool) or
                   not isinstance(data[exit_identities[0]], int) or data[exit_identities[0]] < 0):
        die(70, "HELPER_FAILED", "QGA terminal status lacks one valid exit identity")
    if exited and data.get("exitcode") == 0 and stderr:
        die(70, "HELPER_FAILED", "successful QGA helper emitted stderr")


def authority_mode(method, path, body, expected):
    if method == "GET":
        return None
    vm_base = f"/nodes/{expected['hostId']}/qemu/{expected['vmId']}"
    if (method == "DELETE" and path == vm_base) or path == f"{vm_base}/status/stop":
        return "cleanup"
    if method == "PUT" and path == f"{vm_base}/config" and "agent" not in body:
        return "cleanup"
    return "active"


def authorize_provider_effect(mode, timeout_seconds):
    if mode is None:
        return None
    lock_fd = None
    helper = at(LEASE_AUTHORITY_HELPER)
    try:
        lock_path = at(LEASE_AUTHORITY_LOCK)
        lock_info = os.lstat(lock_path)
        expected_uid = 0 if ROOT == "/" else os.geteuid()
        if (not stat.S_ISREG(lock_info.st_mode) or lock_info.st_nlink != 1 or lock_info.st_uid != expected_uid or
                (lock_info.st_mode & 0o777) != 0o600):
            raise ValueError("untrusted lease authority lock")
        lock_fd = os.open(lock_path, os.O_RDWR | (os.O_NOFOLLOW if hasattr(os, "O_NOFOLLOW") else 0))
        lock_deadline = time.monotonic() + timeout_seconds
        while True:
            try:
                fcntl.flock(lock_fd, fcntl.LOCK_SH | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                if time.monotonic() >= lock_deadline:
                    raise subprocess.TimeoutExpired("lease-authority-lock", timeout_seconds)
                time.sleep(min(0.01, max(0.001, lock_deadline - time.monotonic())))
        info = os.lstat(helper)
        if (not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_uid != expected_uid or
                (info.st_mode & 0o777) != 0o750):
            raise ValueError("untrusted lease authority helper")
        command = [helper, "authorize-bound", mode] if ROOT == "/" else [sys.executable, helper, "authorize-bound", mode, "--fake-root", ROOT]
        environment = {"PATH": "/usr/sbin:/usr/bin:/sbin:/bin"}
        if ROOT != "/":
            environment["NELOS_DESKTOP_HELPER_ROOT"] = ROOT
            if "NELOS_LEASE_AUTHORITY_TEST_NOW" in os.environ:
                environment["NELOS_LEASE_AUTHORITY_TEST_NOW"] = os.environ["NELOS_LEASE_AUTHORITY_TEST_NOW"]
        completed = subprocess.run(
            command,
            stdin=subprocess.DEVNULL,
            capture_output=True,
            timeout=timeout_seconds,
            check=True,
            env=environment,
        )
        if completed.stderr or len(completed.stdout) > 1_048_576:
            raise ValueError("invalid lease authority output")
        observation = json.loads(completed.stdout.decode("utf-8"))
        if observation.get("authorizedMode") != mode:
            raise ValueError("lease authority mode differs")
        return lock_fd
    except subprocess.TimeoutExpired:
        die(75, "LEASE_AUTHORITY_TIMEOUT", "lease authority did not answer within the provider deadline")
    except subprocess.CalledProcessError as error:
        try:
            denial = json.loads(error.stderr.decode("utf-8"))
            code = denial["error"] if isinstance(denial.get("error"), str) else "LEASE_AUTHORITY_DENIED"
        except (AttributeError, UnicodeDecodeError, json.JSONDecodeError, KeyError):
            code = "LEASE_AUTHORITY_DENIED"
        die(77, code, "the independent lease authority denied this provider effect")
    except (OSError, ValueError, UnicodeDecodeError, json.JSONDecodeError):
        die(70, "LEASE_AUTHORITY_UNAVAILABLE", "the independent lease authority is unavailable")
    finally:
        if sys.exc_info()[0] is not None and lock_fd is not None:
            os.close(lock_fd)


def main():
    if sys.argv[1:] != ["request"]:
        die(64, "INVALID_OPERATION", "provider transport supports only request")
    raw = sys.stdin.buffer.read(MAX_REQUEST_BYTES + 1)
    if len(raw) > MAX_REQUEST_BYTES:
        die(65, "INPUT_LIMIT", "request exceeds 32 MiB")
    try:
        envelope = json.loads(raw)
        expected = trusted_json(at("/etc/nelos-desktop/run-binding.json"))
        provider = trusted_json(at("/etc/nelos-desktop/provider.json"))
    except (OSError, ValueError, UnicodeDecodeError, json.JSONDecodeError):
        die(70, "HELPER_UNAVAILABLE", "sealed request or trusted binding is unavailable")
    if (not same_fields(envelope, ["binding", "deadlineAt", "maxOutputBytes", "request", "schemaVersion"]) or envelope.get("schemaVersion") != 1 or
            not same_fields(envelope.get("binding"), BINDING_FIELDS) or not same_fields(expected, BINDING_FIELDS) or envelope.get("binding") != expected or
            not same_fields(provider, ["gatewayId", "hostId", "networkId", "networkPolicyDigest", "networkPolicyObserverDigest", "providerId", "sourceTemplateVmId"]) or provider.get("hostId") != expected.get("hostId") or provider.get("providerId") != expected.get("providerId") or provider.get("networkId") != expected.get("networkId") or provider.get("gatewayId") != expected.get("gatewayId") or provider.get("networkPolicyDigest") != expected.get("networkPolicyDigest") or re.fullmatch(r"sha256:[0-9a-f]{64}", provider.get("networkPolicyObserverDigest") or "") is None):
        die(77, "IDENTITY_MISMATCH", "run, provider, host, VMID, lease, fence, or automation binding differs")
    if (not all(isinstance(expected[field], str) if field in {"stateRoot", "macAddress"} else safe_id(expected[field]) for field in BINDING_FIELDS) or
            expected["automationUser"] != "nelosauto" or expected["stateRoot"] != f"/var/lib/nelos-desktop/runs/{expected['runId']}" or
            re.fullmatch(r"[1-9][0-9]{2,8}", expected["vmId"]) is None or re.fullmatch(r"[1-9][0-9]{2,8}", expected["gatewayId"]) is None or
            expected["gatewayId"] == expected["vmId"] or expected["providerId"] != PRODUCTION_PROVIDER_ID or
            expected["hostId"] != PRODUCTION_HOST_ID or expected["gatewayId"] != PRODUCTION_GATEWAY_ID or expected["networkId"] != PRODUCTION_NETWORK_ID or
            re.fullmatch(r"02(?::[0-9A-F]{2}){5}", expected["macAddress"]) is None or
            re.fullmatch(r"sha256:[0-9a-f]{64}", expected["networkPolicyDigest"]) is None):
        die(77, "IDENTITY_MISMATCH", "trusted binding is invalid")
    deadline = parse_time(envelope.get("deadlineAt"))
    now_ms = datetime.datetime.now(datetime.timezone.utc).timestamp() * 1000
    remaining = deadline - now_ms if deadline is not None else -1
    maximum = envelope.get("maxOutputBytes")
    if not isinstance(maximum, int) or isinstance(maximum, bool) or not 1 <= maximum <= 16_777_216 or remaining <= 0 or remaining > 600_000:
        die(75, "DEADLINE_EXPIRED", "deadline or output bound is invalid")
    request = envelope.get("request")
    request_fields = ["body", "method", "path"] if isinstance(request, dict) and "body" in request else ["method", "path"]
    if not same_fields(request, request_fields) or request.get("method") not in ("GET", "POST", "PUT", "DELETE") or not isinstance(request.get("path"), str):
        die(65, "INVALID_CONTRACT", "provider request fields are invalid")
    url = urllib.parse.urlsplit(request["path"])
    if url.scheme or url.netloc:
        die(65, "INVALID_CONTRACT", "provider path must be relative")
    try:
        path = urllib.parse.unquote(url.path, errors="strict")
    except UnicodeDecodeError:
        die(65, "INVALID_CONTRACT", "provider path is invalid")
    node = re.escape(expected["hostId"])
    vm = re.escape(expected["vmId"])
    template = str(provider["sourceTemplateVmId"])
    if isinstance(provider["sourceTemplateVmId"], bool) or re.fullmatch(r"[1-9][0-9]{2,8}", template) is None or template in {expected["vmId"], expected["gatewayId"]}:
        die(77, "IDENTITY_MISMATCH", "source template VMID is invalid")
    patterns = [
        ("GET", rf"^/nodes/{node}/qemu/{vm}/config$"), ("PUT", rf"^/nodes/{node}/qemu/{vm}/config$"),
        ("GET", rf"^/nodes/{node}/qemu/{re.escape(template)}/config$"), ("GET", rf"^/nodes/{node}/qemu/{re.escape(template)}/status/current$"),
        ("POST", rf"^/nodes/{node}/qemu/{re.escape(template)}/clone$"), ("POST", rf"^/nodes/{node}/qemu/{vm}/status/(?:start|stop)$"),
        ("DELETE", rf"^/nodes/{node}/qemu/{vm}$"), ("GET", rf"^/nodes/{node}/tasks/UPID:[A-Za-z0-9:._-]{{1,507}}/status$"),
        ("POST", rf"^/nodes/{node}/qemu/{vm}/agent/exec$"), ("POST", rf"^/nodes/{node}/qemu/{vm}/agent/(?:ping|get-osinfo|get-users)$"),
        ("GET", rf"^/nodes/{node}/qemu/{vm}/agent/exec-status$"), ("GET", r"^/cluster/resources$"),
        ("GET", r"^/nelos/network/mac-absence$"),
    ]
    if not any(method == request["method"] and re.fullmatch(pattern, path) for method, pattern in patterns):
        die(77, "FORBIDDEN_PROVIDER_OPERATION", "provider path or method is not allowlisted")
    query = urllib.parse.parse_qs(url.query, keep_blank_values=True, strict_parsing=True) if url.query else {}
    if path == "/cluster/resources" and query != {"type": ["vm"]}:
        die(77, "FORBIDDEN_PROVIDER_OPERATION", "only VM inventory is allowlisted")
    if path.endswith("/agent/exec-status") and (set(query) != {"pid"} or len(query["pid"]) != 1 or re.fullmatch(r"[1-9][0-9]{0,9}", query["pid"][0]) is None):
        die(65, "INVALID_CONTRACT", "QGA process identity is invalid")
    if path not in ("/cluster/resources",) and not path.endswith("/agent/exec-status") and query:
        die(77, "FORBIDDEN_PROVIDER_OPERATION", "provider query is not allowlisted")
    body = request.get("body", {})
    if not isinstance(body, dict):
        die(77, "FORBIDDEN_PROVIDER_OPERATION", "provider body is invalid")
    validate_body(request["method"], path, body, "body" in request, expected, template)
    verb = {"GET": "get", "POST": "create", "PUT": "set", "DELETE": "delete"}[request["method"]]
    args = [verb, path, "--output-format", "json"]
    for key, values in query.items():
        for value in values:
            args.extend([f"--{key}", value])
    for key, value in body.items():
        args.extend([f"--{key}", value if isinstance(value, str) else json.dumps(value, separators=(",", ":"))])
    pvesh = "/usr/bin/pvesh" if ROOT == "/" else os.environ.get("NELOS_PVESH")
    if not isinstance(pvesh, str) or not pvesh.startswith("/"):
        die(70, "HELPER_UNAVAILABLE", "fixed pvesh executable is unavailable")
    if path == "/nelos/network/mac-absence":
        sys.stdout.write(json.dumps(observe_mac_absence(expected, pvesh, deadline, maximum), separators=(",", ":")) + "\n")
        return
    # This is intentionally the final check before every provider effect.  The
    # authority derives the resource from the sealed host binding; the caller
    # cannot select a lease record or reuse an old fence.
    authority_guard = authorize_provider_effect(authority_mode(request["method"], path, body, expected), remaining / 1000)
    try:
        effect_remaining = (deadline - datetime.datetime.now(datetime.timezone.utc).timestamp() * 1000) / 1000
        if effect_remaining <= 0:
            die(75, "DEADLINE_EXPIRED", "provider deadline expired after lease authorization")
        completed = subprocess.run([pvesh, *args], stdin=subprocess.DEVNULL, capture_output=True, timeout=effect_remaining, check=True,
                                   env={"PATH": "/usr/sbin:/usr/bin:/sbin:/bin"})
    except subprocess.TimeoutExpired:
        die(75, "DEADLINE_EXPIRED", "bounded Proxmox operation failed")
    except subprocess.CalledProcessError as error:
        stderr = error.stderr.decode("utf-8", "replace")
        if request["method"] == "GET" and path.endswith(f"/{expected['vmId']}/config") and (error.returncode == 2 or re.search(r"does not exist|not found", stderr, re.I)):
            raise SystemExit(44)
        die(70, "HELPER_FAILED", "bounded Proxmox operation failed")
    finally:
        if authority_guard is not None:
            os.close(authority_guard)
    if len(completed.stdout) + len(completed.stderr) > maximum:
        die(75, "HELPER_OUTPUT_LIMIT", "bounded Proxmox output exceeded its limit")
    text = completed.stdout.decode("utf-8", "strict").strip()
    try:
        data = json.loads(text) if text else None
    except json.JSONDecodeError:
        data = text
    validate_qga_response(path, data, maximum)
    sys.stdout.write(json.dumps({"data": data}, separators=(",", ":")) + "\n")


if __name__ == "__main__":
    try:
        main()
    except SystemExit:
        raise
    except Exception:
        die(70, "HELPER_FAILED", "bounded Proxmox operation failed")
