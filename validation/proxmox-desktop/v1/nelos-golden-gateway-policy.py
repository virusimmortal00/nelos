#!/usr/bin/python3
"""Fixed QGA endpoint for one nonce-bound golden-builder gateway policy.

The Proxmox host invokes this helper inside gateway VM 9023 with a canonical
request on stdin.  Apply and restore are journaled before nft is called.  A
retry after an unreceipted apply restores the exact stateless ruleset backup
instead of stacking another allow rule.
"""

import datetime
import fcntl
import hashlib
import json
import os
import pathlib
import re
import stat
import subprocess
import sys
import time


HELPER_PATH = pathlib.Path("/usr/libexec/nelos-golden-gateway-policy")
STATE_ROOT = pathlib.Path("/var/lib/nelos-golden-gateway-policy")
NFT = "/usr/sbin/nft"
MAX_INPUT = 65_536
MAX_OUTPUT = 1_048_576
SHA256 = re.compile(r"sha256:[0-9a-f]{64}\Z")
FINGERPRINT = re.compile(r"SHA256:[A-Za-z0-9+/]{43}\Z")
IPV4 = re.compile(r"(?:0|[1-9][0-9]{0,2})(?:\.(?:0|[1-9][0-9]{0,2})){3}\Z")
PROVIDER_OPERATIONS = {"preflight", "apply", "observe", "restore"}
ATTESTOR_OPERATIONS = {"confirm-restored"}


class PolicyError(Exception):
    def __init__(self, code, message, exit_code=77):
        super().__init__(message)
        self.code = code
        self.message = message
        self.exit_code = exit_code


def fail(code, message, exit_code=77):
    raise PolicyError(code, message, exit_code)


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
    if parsed.tzinfo is None or parsed.isoformat(timespec="milliseconds").replace("+00:00", "Z") != value:
        fail("INVALID_CONTRACT", f"{label} is not canonical", 65)
    return parsed.timestamp()


def iso_now():
    return datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def validate_binding(value, allow_expired=False):
    exact(value, {"apiAllow", "bindingDigest", "buildNonce", "expiresAt", "gateway", "helper", "httpsAllow", "kind", "nft",
                  "originalRulesetDigest", "reservationDigest", "schemaVersion"}, "gateway policy binding")
    exact(value["gateway"], {"configDigest", "hostId", "providerId", "vmId"}, "gateway")
    exact(value["helper"], {"digest", "path"}, "helper")
    exact(value["nft"], {"approvedIpv4Set", "family", "forwardChain", "sourceCidr", "table"}, "nft identity")
    exact(value["apiAllow"], {"address", "port", "protocol"}, "API allow")
    exact(value["httpsAllow"], {"destinations", "port", "protocol"}, "HTTPS allow")
    unsigned = dict(value)
    claimed = unsigned.pop("bindingDigest")
    destinations = value["httpsAllow"]["destinations"]
    if (value["schemaVersion"] != 1 or value["kind"] != "nelos-golden-builder-gateway-policy" or claimed != digest(unsigned) or
            not SHA256.fullmatch(value["reservationDigest"] or "") or not SHA256.fullmatch(value["originalRulesetDigest"] or "") or
            value["gateway"].get("providerId") != "proxmox-lab" or value["gateway"].get("hostId") != "prox2" or value["gateway"].get("vmId") != 9023 or
            not SHA256.fullmatch(value["gateway"].get("configDigest") or "") or
            value["helper"]["path"] != str(HELPER_PATH) or not SHA256.fullmatch(value["helper"]["digest"] or "") or
            value["nft"] != {"family": "inet", "table": "nelosbld", "forwardChain": "forward", "approvedIpv4Set": "approved_ipv4", "sourceCidr": "10.77.77.0/24"} or
            value["apiAllow"] != {"address": "192.168.1.110", "port": 8006, "protocol": "tcp"} or
            value["httpsAllow"].get("port") != 443 or value["httpsAllow"].get("protocol") != "tcp" or
            not isinstance(destinations, list) or [item.get("host") if isinstance(item, dict) else None for item in destinations] !=
            ["persistent.oaistatic.com", "snapshot.ubuntu.com"]):
        fail("INVALID_CONTRACT", "gateway policy identity or digest differs", 65)
    addresses = []
    expiry = parse_time(value["expiresAt"], "policy expiry")
    for item in destinations:
        exact(item, {"addresses", "expiresAt", "host", "resolvedAt", "ttlSeconds"}, "resolved destination")
        if (not isinstance(item["ttlSeconds"], int) or not 30 <= item["ttlSeconds"] <= 3600 or not isinstance(item["addresses"], list) or
                not 1 <= len(item["addresses"]) <= 16 or item["addresses"] != sorted(set(item["addresses"])) or
                any(not isinstance(address, str) or IPV4.fullmatch(address) is None or any(int(part) > 255 for part in address.split(".")) for address in item["addresses"])):
            fail("INVALID_CONTRACT", "resolved gateway address set is invalid", 65)
        resolved = parse_time(item["resolvedAt"], "resolution time")
        destination_expiry = parse_time(item["expiresAt"], "resolution expiry")
        if abs(destination_expiry - (resolved + item["ttlSeconds"])) > 0.001 or destination_expiry > expiry:
            fail("INVALID_CONTRACT", "resolved gateway address lifetime differs", 65)
        addresses.extend(item["addresses"])
    if len(addresses) != len(set(addresses)):
        fail("INVALID_CONTRACT", "resolved gateway addresses overlap", 65)
    if not allow_expired and (time.time() >= expiry or any(time.time() >= parse_time(item["expiresAt"], "resolution expiry") for item in destinations)):
        fail("GATEWAY_POLICY_EXPIRED", "gateway policy or resolution has expired", 75)
    return value


def verify_helper(binding):
    if os.geteuid() != 0 or pathlib.Path(os.path.realpath(sys.argv[0])) != HELPER_PATH:
        fail("HELPER_IDENTITY_MISMATCH", "gateway policy helper must run as installed root", 70)
    try:
        info = HELPER_PATH.lstat()
        data = HELPER_PATH.read_bytes()
    except OSError:
        fail("HELPER_IDENTITY_MISMATCH", "gateway policy helper is unavailable", 70)
    if (not stat.S_ISREG(info.st_mode) or stat.S_ISLNK(info.st_mode) or info.st_nlink != 1 or info.st_uid != 0 or info.st_gid != 0 or
            (info.st_mode & 0o777) not in {0o555, 0o755} or digest(data) != binding["helper"]["digest"]):
        fail("HELPER_IDENTITY_MISMATCH", "gateway policy helper bytes or metadata differ", 70)


def read_request(role):
    data = sys.stdin.buffer.read(MAX_INPUT + 1)
    if not 2 <= len(data) <= MAX_INPUT:
        fail("INPUT_LIMIT", "gateway request size is outside the bound", 65)
    try:
        value = json.loads(data)
    except (UnicodeDecodeError, json.JSONDecodeError):
        fail("INVALID_JSON", "gateway request is not valid JSON", 65)
    if data != canonical(value) + b"\n":
        fail("NONCANONICAL_INPUT", "gateway request is not canonical JSON", 65)
    exact(value, {"binding", "deadlineAt", "kind", "operation", "operationId", "requestedAt", "role", "schemaVersion"}, "gateway request")
    operation = value["operation"]
    cleanup = operation in {"restore", "confirm-restored"}
    binding = validate_binding(value["binding"], allow_expired=cleanup)
    expected_id = digest({"schemaVersion": 1, "kind": "nelos-golden-builder-gateway-operation", "bindingDigest": binding["bindingDigest"], "operation": operation})
    allowed = PROVIDER_OPERATIONS if role == "provider" else ATTESTOR_OPERATIONS
    requested = parse_time(value["requestedAt"], "request issue time")
    deadline = parse_time(value["deadlineAt"], "request deadline")
    now = time.time()
    if (value["schemaVersion"] != 1 or value["kind"] != "nelos-golden-builder-gateway-request" or value["role"] != role or operation not in allowed or
            value["operationId"] != expected_id or requested > now + 1 or now - requested > 301 or requested >= deadline or now >= deadline or deadline - now > 301):
        fail("IDENTITY_MISMATCH", "gateway request role, operation, identity, or deadline differs", 77)
    return value, binding, deadline


def state_dir(binding):
    try:
        STATE_ROOT.mkdir(mode=0o700)
    except FileExistsError:
        pass
    root_info = STATE_ROOT.lstat()
    if not stat.S_ISDIR(root_info.st_mode) or stat.S_ISLNK(root_info.st_mode) or root_info.st_uid != 0 or (root_info.st_mode & 0o777) != 0o700:
        fail("STATE_UNTRUSTED", "gateway policy state root is untrusted", 70)
    path = STATE_ROOT / binding["bindingDigest"][7:]
    try:
        path.mkdir(mode=0o700)
    except FileExistsError:
        pass
    info = path.lstat()
    if not stat.S_ISDIR(info.st_mode) or stat.S_ISLNK(info.st_mode) or info.st_uid != 0 or (info.st_mode & 0o777) != 0o700:
        fail("STATE_UNTRUSTED", "gateway policy binding state is untrusted", 70)
    return path


def atomic_bytes(path, data):
    temporary = path.with_name("." + path.name + "." + os.urandom(8).hex() + ".tmp")
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0), 0o400)
    try:
        os.write(fd, data)
        os.fsync(fd)
        os.fchmod(fd, 0o400)
    finally:
        os.close(fd)
    os.replace(temporary, path)
    directory = os.open(path.parent, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
    try:
        os.fsync(directory)
    finally:
        os.close(directory)


def atomic_json(path, value):
    atomic_bytes(path, canonical(value) + b"\n")


def read_root_file(path, label, maximum=MAX_OUTPUT):
    try:
        info = path.lstat()
        data = path.read_bytes()
    except OSError:
        fail("STATE_UNAVAILABLE", f"{label} is unavailable", 70)
    if (not stat.S_ISREG(info.st_mode) or stat.S_ISLNK(info.st_mode) or info.st_nlink != 1 or info.st_uid != 0 or
            (info.st_mode & 0o777) != 0o400 or not 1 <= len(data) <= maximum):
        fail("STATE_UNTRUSTED", f"{label} metadata or size differs", 70)
    return data


def read_root_json(path, label):
    data = read_root_file(path, label)
    try:
        value = json.loads(data)
    except (UnicodeDecodeError, json.JSONDecodeError):
        fail("STATE_UNTRUSTED", f"{label} is not JSON", 70)
    if data != canonical(value) + b"\n":
        fail("STATE_UNTRUSTED", f"{label} is not canonical", 70)
    return value


def run_nft(arguments, deadline, input_data=None):
    remaining = deadline - time.time()
    if remaining <= 0:
        fail("DEADLINE_EXPIRED", "gateway nft deadline expired", 75)
    try:
        result = subprocess.run([NFT] + arguments, input=input_data, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                env={"PATH": "/usr/sbin:/usr/bin:/sbin:/bin", "LC_ALL": "C"}, timeout=remaining,
                                check=False, close_fds=True)
    except subprocess.TimeoutExpired:
        fail("DEADLINE_EXPIRED", "gateway nft command timed out", 75)
    if result.returncode != 0 or len(result.stdout) > MAX_OUTPUT or len(result.stderr) > MAX_OUTPUT:
        fail("NFT_OPERATION_FAILED", "bounded gateway nft command failed", 70)
    return result.stdout


def ruleset(deadline):
    data = run_nft(["--stateless", "list", "ruleset"], deadline)
    if not data.endswith(b"\n") or b"\x00" in data:
        fail("RULESET_INVALID", "gateway stateless ruleset encoding is invalid", 70)
    try:
        data.decode("utf-8", "strict")
    except UnicodeDecodeError:
        fail("RULESET_INVALID", "gateway stateless ruleset is not UTF-8", 70)
    return data


def block(text, header):
    start = text.find(header)
    if start < 0 or text.find(header, start + 1) >= 0:
        fail("RULESET_INVALID", f"gateway ruleset does not contain exactly one {header}", 70)
    opening = text.find("{", start + len(header))
    if opening < 0:
        fail("RULESET_INVALID", f"gateway {header} block is malformed", 70)
    depth = 0
    for index in range(opening, len(text)):
        if text[index] == "{":
            depth += 1
        elif text[index] == "}":
            depth -= 1
            if depth == 0:
                return text[opening + 1:index]
    fail("RULESET_INVALID", f"gateway {header} block is unterminated", 70)


def baseline_projection(data, binding):
    text = data.decode("utf-8")
    table = block(text, "table inet nelosbld")
    approved = block(table, "set approved_ipv4")
    forward = block(table, "chain forward")
    accepts = [line.strip() for line in forward.splitlines() if re.search(r"\baccept\b", line)]
    expected_https = [line for line in accepts if "10.77.77.0/24" in line and "@approved_ipv4" in line and re.search(r"tcp dport 443\b", line)]
    stateful = [line for line in accepts if "ct state" in line and "established" in line and "related" in line]
    unexpected = len(accepts) - len(expected_https) - len(stateful)
    empty = "elements" not in approved and re.search(r"\b[0-9]{1,3}(?:\.[0-9]{1,3}){3}\b", approved) is None
    if ("type ipv4_addr" not in approved or "flags timeout" not in approved or "policy drop" not in forward or len(expected_https) != 1 or unexpected != 0 or
            digest(data) != binding["originalRulesetDigest"]):
        fail("GATEWAY_BASELINE_MISMATCH", "gateway baseline ruleset or deny policy differs", 77)
    return {"approvedSetEmpty": empty, "forwardPolicy": "drop", "gatewayVmId": 9023, "helperDigest": binding["helper"]["digest"],
            "rulesetDigest": digest(data), "unexpectedForwardAccepts": unexpected}


def desired_addresses(binding):
    return sorted(address for destination in binding["httpsAllow"]["destinations"] for address in destination["addresses"])


def marker(binding):
    return "nelos-golden:" + binding["bindingDigest"][7:23]


def active_projection(data, binding):
    text = data.decode("utf-8")
    table = block(text, "table inet nelosbld")
    approved = block(table, "set approved_ipv4")
    forward = block(table, "chain forward")
    observed_addresses = sorted(set(re.findall(r"(?<![0-9.])(?:[0-9]{1,3}\.){3}[0-9]{1,3}(?![0-9.])", approved)))
    expected = desired_addresses(binding)
    marker_value = marker(binding)
    api_lines = [line for line in forward.splitlines() if marker_value in line]
    if (observed_addresses != expected or text.count(marker_value) != 1 or len(api_lines) != 1 or "10.77.77.0/24" not in api_lines[0] or
            "192.168.1.110" not in api_lines[0] or re.search(r"tcp dport 8006\b", api_lines[0]) is None or "accept" not in api_lines[0]):
        fail("GATEWAY_POLICY_MISMATCH", "gateway active policy differs from the sealed allowlist", 77)
    return {"active": True, "allowedHttpsAddresses": expected, "apiAddress": "192.168.1.110", "apiPort": 8006,
            "marker": marker_value, "rulesetDigest": digest(data)}


def receipt(request, status_value, provider_operation_id, payload):
    unsigned = {"schemaVersion": 1, "kind": "nelos-golden-builder-gateway-receipt", "role": request["role"], "operation": request["operation"],
                "operationId": request["operationId"], "bindingDigest": request["binding"]["bindingDigest"], "status": status_value,
                "providerOperationId": provider_operation_id, "observedAt": iso_now(), "payload": payload, "payloadDigest": digest(payload)}
    return {**unsigned, "receiptDigest": digest(unsigned)}


def restore_exact(root, binding, request, deadline):
    backup = read_root_file(root / "original-ruleset.nft", "original ruleset")
    if digest(backup) != binding["originalRulesetDigest"]:
        fail("STATE_UNTRUSTED", "original ruleset backup digest differs", 70)
    restore_intent = root / "restore.intent.json"
    if not restore_intent.exists():
        atomic_json(restore_intent, {"schemaVersion": 1, "kind": "nelos-golden-gateway-restore-intent", "bindingDigest": binding["bindingDigest"],
                                     "operationId": request["operationId"], "originalRulesetDigest": binding["originalRulesetDigest"]})
    current = ruleset(deadline)
    if current != backup:
        run_nft(["-f", "-"], deadline, b"flush ruleset\n" + backup)
        current = ruleset(deadline)
    if current != backup or digest(current) != binding["originalRulesetDigest"]:
        fail("GATEWAY_RESTORE_UNPROVEN", "gateway ruleset does not exactly match its original bytes", 70)
    return current


def handle(request, binding, deadline):
    operation = request["operation"]
    root = state_dir(binding)
    if operation == "preflight":
        return receipt(request, "observed", None, baseline_projection(ruleset(deadline), binding))
    if operation == "observe":
        return receipt(request, "observed", None, active_projection(ruleset(deadline), binding))
    if operation == "confirm-restored":
        current = ruleset(deadline)
        restored = current == read_root_file(root / "original-ruleset.nft", "original ruleset") and digest(current) == binding["originalRulesetDigest"]
        payload = {"restored": restored, "rulesetDigest": digest(current),
                   "independentInventoryDigest": digest({"gatewayVmId": 9023, "helperDigest": binding["helper"]["digest"], "rulesetDigest": digest(current)})}
        return receipt(request, "observed", None, payload)
    operation_receipt = root / (operation + ".receipt.json")
    if operation_receipt.exists():
        previous = read_root_json(operation_receipt, "gateway operation receipt")
        if previous.get("operationId") != request["operationId"]:
            fail("JOURNAL_MISMATCH", "gateway operation receipt identity differs", 70)
        if operation == "apply":
            active_projection(ruleset(deadline), binding)
        else:
            restore_exact(root, binding, request, deadline)
        return previous
    if operation == "restore":
        current = restore_exact(root, binding, request, deadline)
        value = receipt(request, "committed", "nft:restore:" + request["operationId"][7:23], {"restored": True, "rulesetDigest": digest(current)})
        atomic_json(operation_receipt, value)
        return value
    apply_intent = root / "apply.intent.json"
    backup_path = root / "original-ruleset.nft"
    if apply_intent.exists():
        # The previous process could have died after nft committed.  Restore the
        # byte-identical baseline and return a terminal failure; never reapply or
        # stack the allow rule under the same operation identity.
        current = restore_exact(root, binding, request, deadline)
        value = receipt(request, "failed", None, {"restored": True, "rulesetDigest": digest(current)})
        atomic_json(operation_receipt, value)
        return value
    original = ruleset(deadline)
    baseline_projection(original, binding)
    if backup_path.exists():
        if read_root_file(backup_path, "original ruleset") != original:
            fail("STATE_UNTRUSTED", "existing original ruleset backup differs", 70)
    else:
        atomic_bytes(backup_path, original)
    atomic_json(apply_intent, {"schemaVersion": 1, "kind": "nelos-golden-gateway-apply-intent", "bindingDigest": binding["bindingDigest"],
                               "operationId": request["operationId"], "originalRulesetDigest": binding["originalRulesetDigest"]})
    elements = []
    for destination in binding["httpsAllow"]["destinations"]:
        remaining = max(1, min(destination["ttlSeconds"], int(parse_time(destination["expiresAt"], "resolution expiry") - time.time())))
        elements.extend(f"{address} timeout {remaining}s" for address in destination["addresses"])
    script = ("flush set inet nelosbld approved_ipv4\n" +
              "add element inet nelosbld approved_ipv4 { " + ", ".join(elements) + " }\n" +
              "insert rule inet nelosbld forward ip saddr 10.77.77.0/24 ip daddr 192.168.1.110 tcp dport 8006 accept comment \"" + marker(binding) + "\"\n").encode("ascii")
    run_nft(["-f", "-"], deadline, script)
    active = active_projection(ruleset(deadline), binding)
    value = receipt(request, "committed", "nft:apply:" + request["operationId"][7:23], active)
    atomic_json(operation_receipt, value)
    return value


def main():
    if len(sys.argv) != 3 or sys.argv[1] not in {"provider", "attestor"} or sys.argv[2] != "request":
        fail("INVALID_OPERATION", "gateway helper accepts only a fixed role request", 64)
    role = sys.argv[1]
    request, binding, deadline = read_request(role)
    verify_helper(binding)
    root = state_dir(binding)
    lock_fd = os.open(root / ".operation.lock", os.O_RDWR | os.O_CREAT | getattr(os, "O_NOFOLLOW", 0), 0o600)
    try:
        fcntl.flock(lock_fd, fcntl.LOCK_EX)
        result = handle(request, binding, deadline)
    finally:
        os.close(lock_fd)
    sys.stdout.buffer.write(canonical(result) + b"\n")


if __name__ == "__main__":
    try:
        main()
    except PolicyError as error:
        sys.stderr.buffer.write(canonical({"error": error.code, "message": error.message}) + b"\n")
        raise SystemExit(error.exit_code)
