#!/usr/bin/python3
import base64
import binascii
import datetime
import hashlib
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
LEASE_AUTHORITY_HELPER = "/usr/libexec/nelos-proxmox-lease-authority"
NETWORK_POLICY_OBSERVER = "/usr/libexec/nelos-network-policy-observer"
SHA256 = re.compile(r"sha256:[0-9a-f]{64}\Z")
PRODUCTION_PROVIDER_ID = "proxmox-lab"
PRODUCTION_HOST_ID = "prox2"
PRODUCTION_GATEWAY_ID = "9023"
PRODUCTION_NETWORK_ID = "nelosbld"


def at(path):
    return path if ROOT == "/" else f"{ROOT}{path}"


def die(exit_code, code, message):
    sys.stderr.write(json.dumps({"error": code, "message": message}, separators=(",", ":")) + "\n")
    raise SystemExit(exit_code)


def fields(value, expected):
    return isinstance(value, dict) and set(value) == set(expected)


def safe_id(value):
    return isinstance(value, str) and re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._:-]{0,127}", value) is not None


def trusted_json(logical_path):
    path = at(logical_path)
    info = os.lstat(path)
    if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or (ROOT == "/" and (info.st_uid != 0 or info.st_mode & 0o022)) or info.st_size > 16_384:
        raise ValueError("untrusted binding")
    with open(path, "r", encoding="utf-8") as handle:
        return json.load(handle)


def canonical_bytes(value):
    return (json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True) + "\n").encode("utf-8")


def canonical_digest_bytes(value):
    # Cross-language content digests use the same newline-free canonical JSON
    # representation as src/proxmox-desktop-runtime.mjs.  The authoritative
    # file itself remains newline-terminated and is checked separately above.
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode("utf-8")


def sha256(value):
    return "sha256:" + hashlib.sha256(value).hexdigest()


def timestamp(value):
    try:
        return datetime.datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp() * 1000
    except (AttributeError, ValueError):
        return None


def pvesh_json(pvesh, verb, path, deadline_ms, maximum, parameters=None):
    remaining = (deadline_ms - datetime.datetime.now(datetime.timezone.utc).timestamp() * 1000) / 1000
    if remaining <= 0:
        raise TimeoutError("network policy observation deadline expired")
    args = [pvesh, verb, path, "--output-format", "json"]
    for key, value in sorted((parameters or {}).items()):
        encoded = json.dumps(value, separators=(",", ":")) if isinstance(value, list) else str(value)
        args.extend([f"--{key}", encoded])
    try:
        completed = subprocess.run(args, stdin=subprocess.DEVNULL, capture_output=True, timeout=remaining, check=False,
                                   env={"PATH": "/usr/sbin:/usr/bin:/sbin:/bin", "LC_ALL": "C"})
    except (OSError, subprocess.TimeoutExpired):
        raise TimeoutError("bounded Proxmox policy observation failed")
    if completed.returncode != 0 or completed.stderr or not 1 <= len(completed.stdout) <= maximum:
        raise ValueError("bounded Proxmox policy response differs")
    try:
        return json.loads(completed.stdout.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        raise ValueError("bounded Proxmox policy response is not JSON")


def validate_gateway_measurement(value, expected, provider, now):
    names = {"approvedAddressCount", "approvedAddressInventoryDigest", "complete", "expiresAt", "forwardPolicy", "helper", "kind",
             "measurementDigest", "networkId", "observedAt", "policyDigest", "rulesetBytes", "rulesetDigest", "schemaVersion", "unexpectedForwardAccepts"}
    if not isinstance(value, dict) or set(value) != names or not fields(value.get("helper"), ["digest", "path"]):
        raise ValueError("gateway policy measurement fields differ")
    unsigned = dict(value)
    measurement_digest = unsigned.pop("measurementDigest", None)
    observed = timestamp(value.get("observedAt"))
    expires = timestamp(value.get("expiresAt"))
    if (value.get("schemaVersion") != 1 or value.get("kind") != "nelos.proxmox-desktop.gateway-policy-measurement.v1" or
            value.get("complete") is not True or value.get("forwardPolicy") != "drop" or value.get("unexpectedForwardAccepts") != 0 or
            value.get("networkId") != expected["networkId"] or value.get("policyDigest") != expected["networkPolicyDigest"] or
            value["helper"] != {"digest": provider["networkPolicyObserverDigest"], "path": NETWORK_POLICY_OBSERVER} or
            not isinstance(value.get("approvedAddressCount"), int) or isinstance(value.get("approvedAddressCount"), bool) or
            not 1 <= value["approvedAddressCount"] <= 64 or not SHA256.fullmatch(value.get("approvedAddressInventoryDigest") or "") or
            not isinstance(value.get("rulesetBytes"), int) or isinstance(value.get("rulesetBytes"), bool) or
            not 1 <= value["rulesetBytes"] <= 1_048_576 or not SHA256.fullmatch(value.get("rulesetDigest") or "") or
            not SHA256.fullmatch(value.get("policyDigest") or "") or
            observed is None or expires is None or observed > now + 5_000 or now - observed > 30_000 or expires <= now + 120_000 or
            measurement_digest != sha256(canonical_digest_bytes(unsigned))):
        raise ValueError("gateway policy measurement identity, contents, digest, or live expiry differs")
    identity = {
        "approvedAddressInventoryDigest": value["approvedAddressInventoryDigest"],
        "kind": "nelos.proxmox-desktop.gateway-policy-identity.v1",
        "networkId": value["networkId"],
        "rulesetDigest": value["rulesetDigest"],
        "schemaVersion": 1,
    }
    if value["policyDigest"] != sha256(canonical_digest_bytes(identity)):
        raise ValueError("gateway policy identity digest differs")
    return value


def observe_network_policy(expected, provider, pvesh, deadline_ms, maximum):
    gateway = expected["gatewayId"]
    node = expected["hostId"]
    config = pvesh_json(pvesh, "get", f"/nodes/{node}/qemu/{gateway}/config", deadline_ms, maximum)
    status_value = pvesh_json(pvesh, "get", f"/nodes/{node}/qemu/{gateway}/status/current", deadline_ms, maximum)
    if not isinstance(config, dict) or not isinstance(status_value, dict):
        raise ValueError("gateway identity response is invalid")
    config = dict(config)
    config.pop("digest", None)
    agent = str(config.get("agent", ""))
    if status_value.get("status") != "running" or agent not in {"1", "enabled=1", "enabled=1,fstrim_cloned_disks=1"}:
        raise ValueError("gateway is not the running QGA-enabled resource")
    started = pvesh_json(pvesh, "create", f"/nodes/{node}/qemu/{gateway}/agent/exec", deadline_ms, maximum, {
        "capture-output": 1,
        "command": NETWORK_POLICY_OBSERVER,
        "extra-args": ["observe"],
    })
    pid = started.get("pid") if isinstance(started, dict) else None
    if not isinstance(pid, int) or isinstance(pid, bool) or pid < 1:
        raise ValueError("gateway QGA observer process identity is invalid")
    while datetime.datetime.now(datetime.timezone.utc).timestamp() * 1000 < deadline_ms:
        result = pvesh_json(pvesh, "get", f"/nodes/{node}/qemu/{gateway}/agent/exec-status", deadline_ms, maximum, {"pid": pid})
        exited = result.get("exited") if isinstance(result, dict) else None
        if exited not in {0, 1, False, True}:
            raise ValueError("gateway QGA observer status is invalid")
        if exited in {1, True}:
            if (result.get("out-truncated", False) not in {0, False} or result.get("err-truncated", False) not in {0, False} or
                    result.get("exitcode") != 0 or set(result) - {"err-data", "err-truncated", "exited", "exitcode", "out-data", "out-truncated", "signal"}):
                raise ValueError("gateway QGA observer failed, truncated, or returned unknown status")
            try:
                output = base64.b64decode(result.get("out-data", ""), validate=True)
                errors = base64.b64decode(result.get("err-data", ""), validate=True)
            except (binascii.Error, ValueError):
                raise ValueError("gateway QGA observer output is not canonical base64")
            if errors or not 2 <= len(output) <= min(maximum, 1_048_576):
                raise ValueError("gateway QGA observer output is invalid")
            try:
                measurement = json.loads(output)
            except (UnicodeDecodeError, json.JSONDecodeError):
                raise ValueError("gateway QGA observer output is not JSON")
            if output != canonical_bytes(measurement):
                raise ValueError("gateway QGA observer output is not canonical")
            observed_now = datetime.datetime.now(datetime.timezone.utc)
            measurement = validate_gateway_measurement(measurement, expected, provider, observed_now.timestamp() * 1000)
            observed_at = observed_now.isoformat(timespec="milliseconds").replace("+00:00", "Z")
            unsigned = {
                "complete": True,
                "expiresAt": measurement["expiresAt"],
                "gateway": {"configDigest": sha256(canonical_digest_bytes(config)), "hostId": node, "providerId": expected["providerId"], "vmId": gateway},
                "installed": True,
                "kind": "nelos.proxmox-desktop.network-policy-observation.v1",
                "measurement": measurement,
                "networkId": expected["networkId"],
                "networkPolicyDigest": measurement["policyDigest"],
                "observedAt": observed_at,
                "schemaVersion": 1,
            }
            return {**unsigned, "observationDigest": sha256(canonical_digest_bytes(unsigned))}
        time.sleep(min(0.25, max(0, (deadline_ms / 1000) - time.time())))
    raise TimeoutError("gateway QGA observer did not finish")


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


def main():
    if sys.argv[1:] != ["request"]:
        die(64, "INVALID_OPERATION", "absence attestation supports only request")
    raw = sys.stdin.buffer.read(65_537)
    if len(raw) > 65_536:
        die(65, "INPUT_LIMIT", "attestation request exceeds 64 KiB")
    try:
        envelope = json.loads(raw)
        expected = trusted_json("/etc/nelos-desktop/run-binding.json")
        provider = trusted_json("/etc/nelos-desktop/provider.json")
    except (OSError, ValueError, UnicodeDecodeError, json.JSONDecodeError):
        die(70, "HELPER_UNAVAILABLE", "sealed attestation request or binding is unavailable")
    if (not fields(envelope, ["binding", "deadlineAt", "maxOutputBytes", "request", "schemaVersion"]) or envelope.get("schemaVersion") != 1 or
            not fields(envelope.get("binding"), BINDING_FIELDS) or not fields(expected, BINDING_FIELDS) or envelope.get("binding") != expected or
            not fields(provider, ["gatewayId", "hostId", "networkId", "networkPolicyDigest", "networkPolicyObserverDigest", "providerId", "sourceTemplateVmId"]) or provider.get("hostId") != expected.get("hostId") or provider.get("providerId") != expected.get("providerId") or provider.get("networkId") != expected.get("networkId") or provider.get("gatewayId") != expected.get("gatewayId") or provider.get("networkPolicyDigest") != expected.get("networkPolicyDigest") or not SHA256.fullmatch(provider.get("networkPolicyObserverDigest") or "")):
        die(77, "IDENTITY_MISMATCH", "attestation binding differs")
    if (not all(isinstance(expected[field], str) if field in {"stateRoot", "macAddress"} else safe_id(expected[field]) for field in BINDING_FIELDS) or
            expected["automationUser"] != "nelosauto" or expected["stateRoot"] != f"/var/lib/nelos-desktop/runs/{expected['runId']}" or
            re.fullmatch(r"[1-9][0-9]{2,8}", expected["vmId"]) is None or re.fullmatch(r"[1-9][0-9]{2,8}", expected["gatewayId"]) is None or
            expected["gatewayId"] == expected["vmId"] or expected["providerId"] != PRODUCTION_PROVIDER_ID or
            expected["hostId"] != PRODUCTION_HOST_ID or expected["gatewayId"] != PRODUCTION_GATEWAY_ID or expected["networkId"] != PRODUCTION_NETWORK_ID or
            re.fullmatch(r"02(?::[0-9A-F]{2}){5}", expected["macAddress"]) is None or
            re.fullmatch(r"sha256:[0-9a-f]{64}", expected["networkPolicyDigest"]) is None):
        die(77, "IDENTITY_MISMATCH", "attestation binding is invalid")
    deadline = timestamp(envelope.get("deadlineAt"))
    now = datetime.datetime.now(datetime.timezone.utc).timestamp() * 1000
    maximum = envelope.get("maxOutputBytes")
    if deadline is None or deadline <= now or deadline - now > 120_000 or not isinstance(maximum, int) or isinstance(maximum, bool) or not 1 <= maximum <= 8_388_608:
        die(75, "DEADLINE_EXPIRED", "attestation deadline or output bound is invalid")
    request = envelope.get("request")
    if not fields(request, ["method", "path"]) or request.get("method") != "GET" or not isinstance(request.get("path"), str):
        die(77, "FORBIDDEN_PROVIDER_OPERATION", "attestation accepts only bodyless GET")
    url = urllib.parse.urlsplit(request["path"])
    if url.scheme or url.netloc:
        die(65, "INVALID_CONTRACT", "attestation path must be relative")
    path = urllib.parse.unquote(url.path)
    config_path = f"/nodes/{expected['hostId']}/qemu/{expected['vmId']}/config"
    source_vmid = str(provider.get("sourceTemplateVmId"))
    if isinstance(provider.get("sourceTemplateVmId"), bool) or re.fullmatch(r"[1-9][0-9]{2,8}", source_vmid) is None or source_vmid in {expected["vmId"], expected["gatewayId"]}:
        die(77, "IDENTITY_MISMATCH", "source template VMID is invalid")
    source_config_path = f"/nodes/{expected['hostId']}/qemu/{source_vmid}/config"
    source_status_path = f"/nodes/{expected['hostId']}/qemu/{source_vmid}/status/current"
    query = urllib.parse.parse_qs(url.query, keep_blank_values=True, strict_parsing=True) if url.query else {}
    if path == "/nelos/lease-authority/current":
        if query:
            die(77, "FORBIDDEN_PROVIDER_OPERATION", "lease-authority observation query is forbidden")
        helper = at(LEASE_AUTHORITY_HELPER)
        try:
            info = os.lstat(helper)
            expected_uid = 0 if ROOT == "/" else os.geteuid()
            if (not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_uid != expected_uid or
                    (info.st_mode & 0o777) != 0o750):
                raise ValueError("untrusted lease authority helper")
            command = [helper, "observe-bound"] if ROOT == "/" else [sys.executable, helper, "observe-bound", "--fake-root", ROOT]
            environment = {"PATH": "/usr/sbin:/usr/bin:/sbin:/bin"}
            if ROOT != "/":
                environment["NELOS_DESKTOP_HELPER_ROOT"] = ROOT
                if "NELOS_LEASE_AUTHORITY_TEST_NOW" in os.environ:
                    environment["NELOS_LEASE_AUTHORITY_TEST_NOW"] = os.environ["NELOS_LEASE_AUTHORITY_TEST_NOW"]
            completed = subprocess.run(
                command,
                stdin=subprocess.DEVNULL,
                capture_output=True,
                timeout=(deadline - now) / 1000,
                check=True,
                env=environment,
            )
        except subprocess.TimeoutExpired:
            die(75, "DEADLINE_EXPIRED", "bounded lease-authority attestation timed out")
        except (OSError, ValueError, subprocess.CalledProcessError):
            die(70, "HELPER_FAILED", "authoritative current lease is unavailable")
        if len(completed.stdout) + len(completed.stderr) > maximum:
            die(75, "HELPER_OUTPUT_LIMIT", "lease-authority observation exceeded its bound")
        try:
            observation = json.loads(completed.stdout.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            die(70, "HELPER_FAILED", "lease-authority observation is not JSON")
        sys.stdout.write(json.dumps(observation, sort_keys=True, separators=(",", ":")) + "\n")
        return
    if path == "/nelos/network/mac-absence":
        if query:
            die(77, "FORBIDDEN_PROVIDER_OPERATION", "MAC absence query is forbidden")
        pvesh = "/usr/bin/pvesh" if ROOT == "/" else os.environ.get("NELOS_PVESH")
        if not isinstance(pvesh, str) or not pvesh.startswith("/"):
            die(70, "HELPER_UNAVAILABLE", "fixed pvesh executable is unavailable")
        sys.stdout.write(json.dumps(observe_mac_absence(expected, pvesh, deadline, maximum), sort_keys=True, separators=(",", ":")) + "\n")
        return
    if path == "/nelos/network/policy":
        if query:
            die(77, "FORBIDDEN_PROVIDER_OPERATION", "network policy query is forbidden")
        pvesh = "/usr/bin/pvesh" if ROOT == "/" else os.environ.get("NELOS_PVESH")
        if not isinstance(pvesh, str) or not pvesh.startswith("/"):
            die(70, "HELPER_UNAVAILABLE", "fixed pvesh executable is unavailable")
        try:
            observation = observe_network_policy(expected, provider, pvesh, deadline, maximum)
        except TimeoutError:
            die(75, "DEADLINE_EXPIRED", "bounded gateway policy observation timed out")
        except (OSError, ValueError):
            die(70, "NETWORK_POLICY_UNAVAILABLE", "fresh QGA-derived gateway nftables proof is unavailable")
        sys.stdout.write(json.dumps(observation, sort_keys=True, separators=(",", ":")) + "\n")
        return
    if path in (config_path, source_config_path, source_status_path):
        if query:
            die(77, "FORBIDDEN_PROVIDER_OPERATION", "VM attestation query is forbidden")
    elif path == "/cluster/resources":
        if query != {"type": ["vm"]}:
            die(77, "FORBIDDEN_PROVIDER_OPERATION", "only VM inventory attestation is allowed")
    else:
        die(77, "FORBIDDEN_PROVIDER_OPERATION", "attestation path is not allowlisted")
    args = ["get", path, "--output-format", "json"]
    for key, values in query.items():
        for value in values:
            args.extend([f"--{key}", value])
    pvesh = "/usr/bin/pvesh" if ROOT == "/" else os.environ.get("NELOS_PVESH")
    if not isinstance(pvesh, str) or not pvesh.startswith("/"):
        die(70, "HELPER_UNAVAILABLE", "fixed pvesh executable is unavailable")
    try:
        completed = subprocess.run([pvesh, *args], stdin=subprocess.DEVNULL, capture_output=True, timeout=(deadline - now) / 1000, check=True,
                                   env={"PATH": "/usr/sbin:/usr/bin:/sbin:/bin"})
    except subprocess.TimeoutExpired:
        die(75, "DEADLINE_EXPIRED", "bounded absence attestation timed out")
    except subprocess.CalledProcessError as error:
        stderr = error.stderr.decode("utf-8", "replace")
        if path == config_path and (error.returncode == 2 or re.search(r"does not exist|not found", stderr, re.I)):
            raise SystemExit(44)
        die(70, "HELPER_FAILED", "bounded absence attestation failed")
    if len(completed.stdout) + len(completed.stderr) > maximum:
        die(75, "HELPER_OUTPUT_LIMIT", "attestation output exceeded its bound")
    try:
        data = json.loads(completed.stdout.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        die(70, "HELPER_FAILED", "attestation output is not JSON")
    if path == "/cluster/resources" and not isinstance(data, list):
        die(70, "HELPER_FAILED", "cluster inventory response is invalid")
    if path in (config_path, source_config_path, source_status_path) and not isinstance(data, dict):
        die(70, "HELPER_FAILED", "VM config response is invalid")
    sys.stdout.write(json.dumps({"data": data}, separators=(",", ":")) + "\n")


if __name__ == "__main__":
    try:
        main()
    except SystemExit:
        raise
    except Exception:
        die(70, "HELPER_FAILED", "bounded absence attestation failed")
