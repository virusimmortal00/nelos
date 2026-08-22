#!/usr/bin/python3
"""Fixed, read-only nftables observer for the Nelos production gateway.

This helper is installed inside the gateway guest and is invoked only through
the independent Proxmox/QGA attestation boundary.  It never accepts policy
bytes, addresses, paths, or commands from its caller.  The complete stateless
ruleset is hashed, while the live timeout-backed approved IPv4 set is measured
separately so an otherwise-correct but broad or expiring allowlist fails
closed.
"""

import datetime
import hashlib
import ipaddress
import json
import os
import pathlib
import re
import stat
import subprocess
import sys
import time


HELPER_PATH = pathlib.Path("/usr/libexec/nelos-network-policy-observer")
NFT = "/usr/sbin/nft"
NETWORK_ID = "nelosbld"
SOURCE_CIDR = "10.77.77.0/24"
MAX_OUTPUT = 1_048_576
FAKE_ROOT_MARKER = b"nelos-network-policy-observer-fake-root-v1\n"


class ObservationError(Exception):
    def __init__(self, code, message, exit_code=70):
        super().__init__(message)
        self.code = code
        self.message = message
        self.exit_code = exit_code


def fail(code, message, exit_code=70):
    raise ObservationError(code, message, exit_code)


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode("utf-8")


def digest(value):
    data = value if isinstance(value, bytes) else canonical(value)
    return "sha256:" + hashlib.sha256(data).hexdigest()


def iso(milliseconds):
    value = datetime.datetime.fromtimestamp(milliseconds / 1000, datetime.timezone.utc)
    return value.isoformat(timespec="milliseconds").replace("+00:00", "Z")


def fake_root():
    value = os.environ.get("NELOS_NETWORK_POLICY_OBSERVER_ROOT")
    if value is None:
        return None
    root = pathlib.Path(value)
    marker = root / ".nelos-network-policy-observer-fake-root"
    try:
        root_info = root.lstat()
        marker_info = marker.lstat()
        marker_bytes = marker.read_bytes()
    except OSError:
        fail("HELPER_IDENTITY_MISMATCH", "observer fake root is unavailable")
    if (not root.is_absolute() or not stat.S_ISDIR(root_info.st_mode) or stat.S_ISLNK(root_info.st_mode) or
            root_info.st_uid != os.geteuid() or marker_info.st_uid != os.geteuid() or not stat.S_ISREG(marker_info.st_mode) or
            stat.S_ISLNK(marker_info.st_mode) or marker_info.st_nlink != 1 or (marker_info.st_mode & 0o777) != 0o600 or
            marker_bytes != FAKE_ROOT_MARKER):
        fail("HELPER_IDENTITY_MISMATCH", "observer fake-root trust marker differs")
    return root


def installed_path(root):
    return HELPER_PATH if root is None else root / str(HELPER_PATH).lstrip("/")


def verify_helper(root):
    path = installed_path(root)
    expected_uid = 0 if root is None else os.geteuid()
    expected_gid = 0 if root is None else os.getegid()
    try:
        info = path.lstat()
        data = path.read_bytes()
    except OSError:
        fail("HELPER_IDENTITY_MISMATCH", "installed network-policy observer is unavailable")
    if (root is None and (os.geteuid() != 0 or pathlib.Path(os.path.realpath(sys.argv[0])) != HELPER_PATH)):
        fail("HELPER_IDENTITY_MISMATCH", "network-policy observer must run as installed root")
    if (not stat.S_ISREG(info.st_mode) or stat.S_ISLNK(info.st_mode) or info.st_nlink != 1 or
            info.st_uid != expected_uid or info.st_gid != expected_gid or (info.st_mode & 0o777) not in {0o555, 0o755} or
            not 1 <= len(data) <= MAX_OUTPUT):
        fail("HELPER_IDENTITY_MISMATCH", "installed network-policy observer metadata differs")
    return digest(data)


def nft_path(root):
    if root is None:
        return NFT
    value = os.environ.get("NELOS_NETWORK_POLICY_NFT")
    if not isinstance(value, str) or not value.startswith("/"):
        fail("NFT_UNAVAILABLE", "fake-root nft executable is unavailable")
    return value


def run_nft(root, arguments):
    try:
        completed = subprocess.run(
            [nft_path(root), *arguments],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env={"PATH": "/usr/sbin:/usr/bin:/sbin:/bin", "LC_ALL": "C"},
            timeout=20,
            check=False,
            close_fds=True,
        )
    except (OSError, subprocess.TimeoutExpired):
        fail("NFT_UNAVAILABLE", "bounded nftables observation failed")
    if completed.returncode != 0 or completed.stderr or not 1 <= len(completed.stdout) <= MAX_OUTPUT:
        fail("NFT_UNAVAILABLE", "bounded nftables observation returned an invalid result")
    return completed.stdout


def block(text, header):
    start = text.find(header)
    if start < 0 or text.find(header, start + 1) >= 0:
        fail("NETWORK_POLICY_MISMATCH", f"ruleset does not contain exactly one {header}", 77)
    opening = text.find("{", start + len(header))
    if opening < 0:
        fail("NETWORK_POLICY_MISMATCH", f"{header} block is malformed", 77)
    depth = 0
    for index in range(opening, len(text)):
        if text[index] == "{":
            depth += 1
        elif text[index] == "}":
            depth -= 1
            if depth == 0:
                return text[opening + 1:index]
    fail("NETWORK_POLICY_MISMATCH", f"{header} block is unterminated", 77)


def validate_complete_ruleset(data):
    if not data.endswith(b"\n") or b"\x00" in data:
        fail("NETWORK_POLICY_MISMATCH", "stateless ruleset encoding differs", 77)
    try:
        text = data.decode("utf-8", "strict")
    except UnicodeDecodeError:
        fail("NETWORK_POLICY_MISMATCH", "stateless ruleset is not UTF-8", 77)
    table = block(text, "table inet nelosbld")
    approved = block(table, "set approved_ipv4")
    forward = block(table, "chain forward")
    accepts = [line.strip() for line in forward.splitlines() if re.search(r"\baccept\b", line)]
    https = [line for line in accepts if SOURCE_CIDR in line and "@approved_ipv4" in line and re.search(r"tcp dport 443\b", line)]
    stateful = [line for line in accepts if "ct state" in line and "established" in line and "related" in line]
    unexpected = len(accepts) - len(https) - len(stateful)
    if ("type ipv4_addr" not in approved or "flags timeout" not in approved or "policy drop" not in forward or
            len(https) != 1 or len(stateful) != 1 or unexpected != 0):
        fail("NETWORK_POLICY_MISMATCH", "gateway forward or approved-set policy is broader than allowed", 77)
    return unexpected


def set_object(data):
    try:
        value = json.loads(data)
    except (UnicodeDecodeError, json.JSONDecodeError):
        fail("NETWORK_POLICY_MISMATCH", "live approved set is not nftables JSON", 77)
    if not isinstance(value, dict) or set(value) != {"nftables"} or not isinstance(value["nftables"], list):
        fail("NETWORK_POLICY_MISMATCH", "live approved set response is incomplete", 77)
    matches = []
    for item in value["nftables"]:
        if not isinstance(item, dict) or len(item) != 1:
            fail("NETWORK_POLICY_MISMATCH", "live approved set contains an unknown object", 77)
        if "metainfo" in item:
            continue
        candidate = item.get("set")
        if candidate is None:
            fail("NETWORK_POLICY_MISMATCH", "live approved set contains an unexpected nft object", 77)
        if candidate.get("family") == "inet" and candidate.get("table") == NETWORK_ID and candidate.get("name") == "approved_ipv4":
            matches.append(candidate)
        else:
            fail("NETWORK_POLICY_MISMATCH", "live approved set identity differs", 77)
    if len(matches) != 1:
        fail("NETWORK_POLICY_MISMATCH", "live approved set is absent or duplicated", 77)
    value = matches[0]
    flags = value.get("flags")
    if value.get("type") != "ipv4_addr" or not isinstance(flags, list) or set(flags) != {"timeout"}:
        fail("NETWORK_POLICY_MISMATCH", "live approved set is not timeout-backed IPv4", 77)
    return value


def live_elements(data, now_ms):
    value = set_object(data)
    elements = value.get("elem")
    if not isinstance(elements, list) or not 1 <= len(elements) <= 64:
        fail("NETWORK_POLICY_MISMATCH", "approved IPv4 inventory is empty or exceeds its bound", 77)
    addresses = []
    expiries = []
    for item in elements:
        if not isinstance(item, dict) or set(item) != {"elem"} or not isinstance(item["elem"], dict):
            fail("NETWORK_POLICY_MISMATCH", "approved IPv4 element shape differs", 77)
        element = item["elem"]
        if set(element) != {"expires", "timeout", "val"}:
            fail("NETWORK_POLICY_MISMATCH", "approved IPv4 element fields differ", 77)
        try:
            address = str(ipaddress.IPv4Address(element["val"]))
        except (ipaddress.AddressValueError, TypeError):
            fail("NETWORK_POLICY_MISMATCH", "approved set contains a non-IPv4 address", 77)
        expires = element["expires"]
        timeout = element["timeout"]
        if (not isinstance(expires, int) or isinstance(expires, bool) or not isinstance(timeout, int) or isinstance(timeout, bool) or
                expires <= 0 or timeout <= 0 or expires > timeout or timeout > 86_400_000):
            fail("NETWORK_POLICY_MISMATCH", "approved address timeout is invalid", 77)
        addresses.append(address)
        expiries.append(now_ms + expires)
    addresses = sorted(addresses, key=lambda address: ipaddress.IPv4Address(address))
    if len(addresses) != len(set(addresses)):
        fail("NETWORK_POLICY_MISMATCH", "approved IPv4 inventory contains duplicates", 77)
    return addresses, min(expiries)


def now_milliseconds(root):
    if root is not None and "NELOS_NETWORK_POLICY_TEST_NOW" in os.environ:
        try:
            return int(os.environ["NELOS_NETWORK_POLICY_TEST_NOW"])
        except ValueError:
            fail("INVALID_TEST_CLOCK", "fake-root observation clock is invalid")
    return int(time.time() * 1000)


def main():
    if sys.argv[1:] != ["observe"]:
        fail("INVALID_OPERATION", "network-policy observer accepts only observe", 64)
    root = fake_root()
    helper_digest = verify_helper(root)
    started_at = now_milliseconds(root)
    ruleset = run_nft(root, ["--stateless", "list", "ruleset"])
    unexpected = validate_complete_ruleset(ruleset)
    approved_json = run_nft(root, ["--json", "list", "set", "inet", NETWORK_ID, "approved_ipv4"])
    addresses, expires_at = live_elements(approved_json, started_at)
    observed_at = now_milliseconds(root)
    ruleset_digest = digest(ruleset)
    address_digest = digest({"addresses": addresses})
    policy_identity = {
        "approvedAddressInventoryDigest": address_digest,
        "kind": "nelos.proxmox-desktop.gateway-policy-identity.v1",
        "networkId": NETWORK_ID,
        "rulesetDigest": ruleset_digest,
        "schemaVersion": 1,
    }
    unsigned = {
        "approvedAddressCount": len(addresses),
        "approvedAddressInventoryDigest": address_digest,
        "complete": True,
        "expiresAt": iso(expires_at),
        "forwardPolicy": "drop",
        "helper": {"digest": helper_digest, "path": str(HELPER_PATH)},
        "kind": "nelos.proxmox-desktop.gateway-policy-measurement.v1",
        "networkId": NETWORK_ID,
        "observedAt": iso(observed_at),
        "policyDigest": digest(policy_identity),
        "rulesetBytes": len(ruleset),
        "rulesetDigest": ruleset_digest,
        "schemaVersion": 1,
        "unexpectedForwardAccepts": unexpected,
    }
    result = {**unsigned, "measurementDigest": digest(unsigned)}
    sys.stdout.buffer.write(canonical(result) + b"\n")


if __name__ == "__main__":
    try:
        main()
    except ObservationError as error:
        sys.stderr.buffer.write(canonical({"error": error.code, "message": error.message}) + b"\n")
        raise SystemExit(error.exit_code)
