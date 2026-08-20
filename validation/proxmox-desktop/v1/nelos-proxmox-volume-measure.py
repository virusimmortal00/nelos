#!/usr/bin/python3
"""Root-only, reservation-bound Proxmox volume measurement helper."""

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


BINDING_PATH = "/etc/nelos-golden/volume-measurement-binding.json"
MAX_REQUEST = 16_384
DISK_KEY = re.compile(r"^(?:efidisk|ide|sata|scsi|virtio)[0-9]+$")
VOLUME_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*:(?:base|vm)-[1-9][0-9]{2,8}-[A-Za-z0-9._-]+$")
SHA256 = re.compile(r"^sha256:[0-9a-f]{64}$")
SSH_FINGERPRINT = re.compile(r"^SHA256:[A-Za-z0-9+/]{43}$")


def die(code, message, exit_code=70):
    sys.stderr.write(json.dumps({"error": code, "message": message}, separators=(",", ":")) + "\n")
    raise SystemExit(exit_code)


def exact(value, fields, label):
    if not isinstance(value, dict) or set(value) != set(fields):
        die("INVALID_CONTRACT", f"{label} fields differ from the closed contract", 65)
    return value


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def digest(value):
    raw = value if isinstance(value, bytes) else canonical(value).encode("utf-8")
    return "sha256:" + hashlib.sha256(raw).hexdigest()


def parse_time(value):
    if not isinstance(value, str):
        return None
    try:
        return datetime.datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()
    except ValueError:
        return None


def trusted_binding():
    try:
        info = os.lstat(BINDING_PATH)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_gid != 0 or info.st_nlink != 1 or info.st_mode & 0o022 or info.st_size < 1 or info.st_size > MAX_REQUEST:
            raise ValueError("unsafe binding")
        with open(BINDING_PATH, "r", encoding="utf-8") as handle:
            value = json.load(handle)
    except (OSError, ValueError, json.JSONDecodeError):
        die("BINDING_UNAVAILABLE", "sealed volume-measurement binding is unavailable")
    exact(value, [
        "buildNonce", "expiresAt", "helperDigest", "node", "outputTemplate", "providerId", "reservationId", "schemaVersion", "sourceTemplate",
        "storage", "volumeAttestorFingerprint",
    ], "binding")
    exact(value.get("sourceTemplate"), ["name", "vmId"], "binding.sourceTemplate")
    exact(value.get("outputTemplate"), ["macAddress", "name", "vmId"], "binding.outputTemplate")
    if (value.get("schemaVersion") != 1 or value.get("providerId") != "proxmox-lab" or
            value.get("outputTemplate", {}).get("macAddress") != "02:4E:45:4C:90:27" or
            not SHA256.fullmatch(str(value.get("helperDigest", ""))) or not SSH_FINGERPRINT.fullmatch(str(value.get("volumeAttestorFingerprint", "")))):
        die("BINDING_UNAVAILABLE", "sealed volume-measurement binding identity is invalid")
    try:
        own_digest = digest(pathlib.Path(__file__).read_bytes())
    except OSError:
        die("HELPER_INTEGRITY_FAILED", "volume-measurement helper cannot measure itself")
    if own_digest != value["helperDigest"]:
        die("HELPER_INTEGRITY_FAILED", "installed volume-measurement helper differs from the binding")
    return value


def pvesh(path):
    try:
        completed = subprocess.run(
            ["/usr/bin/pvesh", "get", path, "--output-format", "json"], stdin=subprocess.DEVNULL, capture_output=True,
            check=True, timeout=30, env={"PATH": "/usr/sbin:/usr/bin:/sbin:/bin", "LC_ALL": "C"},
        )
        if completed.stderr or len(completed.stdout) > 1_048_576:
            raise ValueError("unexpected provider output")
        return json.loads(completed.stdout)
    except (OSError, ValueError, json.JSONDecodeError, subprocess.SubprocessError):
        die("PROVIDER_OBSERVATION_FAILED", "bounded Proxmox observation failed")


def storage_identity(storage):
    try:
        value = pvesh(f"/storage/{storage}")
        if not isinstance(value, dict) or value.get("type") != "lvmthin" or value.get("shared", 0) not in (0, "0"):
            raise ValueError("unsupported storage")
        vg = value.get("vgname")
        pool = value.get("thinpool")
        if not isinstance(vg, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9+_.-]*", vg) or not isinstance(pool, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9+_.-]*", pool):
            raise ValueError("invalid lvm identity")
        return vg, pool
    except (ValueError, TypeError):
        die("VOLUME_PATH_FAILED", "sealed storage is not one supported node-local LVM-thin pool")


def lvm_identity(vg, volume):
    try:
        completed = subprocess.run(
            ["/usr/sbin/lvm", "lvs", "--noheadings", "--separator", ":", "--units", "b", "--nosuffix",
             "-o", "vg_name,lv_name,lv_size,lv_attr,uuid,pool_lv", "--", f"{vg}/{volume}"],
            stdin=subprocess.DEVNULL, capture_output=True, check=True, timeout=30,
            env={"PATH": "/usr/sbin:/usr/bin:/sbin:/bin", "LC_ALL": "C"}, text=True,
        )
        if completed.stderr:
            raise ValueError("unexpected lvm output")
        fields = [field.strip() for field in completed.stdout.strip().split(":")]
        if len(fields) != 6 or fields[0] != vg or fields[1] != volume or not fields[2].isdigit() or len(fields[3]) < 10 or not re.fullmatch(r"[A-Za-z0-9-]+", fields[4]):
            raise ValueError("invalid lvm output")
        return {"vg": fields[0], "volume": fields[1], "byteLength": int(fields[2]), "attributes": fields[3], "uuid": fields[4], "pool": fields[5]}
    except (OSError, ValueError, subprocess.SubprocessError):
        die("VOLUME_PATH_FAILED", "exact LVM-thin volume identity cannot be observed")


def measure_lvm_volume(storage, volume_id, vg, pool, deadline):
    volume = volume_id.split(":", 1)[1]
    expected_path = f"/dev/{vg}/{volume}"
    try:
        completed = subprocess.run(
            ["/usr/sbin/pvesm", "path", volume_id], stdin=subprocess.DEVNULL, capture_output=True, check=True, timeout=30,
            env={"PATH": "/usr/sbin:/usr/bin:/sbin:/bin", "LC_ALL": "C"}, text=True,
        )
        if completed.stderr or completed.stdout.strip() != expected_path:
            raise ValueError("unexpected storage path")
    except (OSError, ValueError, subprocess.SubprocessError):
        die("VOLUME_PATH_FAILED", "exact Proxmox volume path differs from its LVM identity")
    before = lvm_identity(vg, volume)
    if before["pool"] != pool or before["attributes"][0] != "V" or before["attributes"][4] != "-" or before["byteLength"] < 1:
        die("VOLUME_PATH_FAILED", "LVM-thin volume identity or pool differs")
    activated = False
    try:
        subprocess.run(
            ["/usr/sbin/lvm", "lvchange", "-ay", "-K", "--", f"{vg}/{volume}"], stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=True, timeout=30,
            env={"PATH": "/usr/sbin:/usr/bin:/sbin:/bin", "LC_ALL": "C"},
        )
        activated = True
        resolved = os.path.realpath(expected_path)
        info = os.stat(resolved, follow_symlinks=False)
        if not stat.S_ISBLK(info.st_mode):
            die("VOLUME_PATH_FAILED", "activated LVM volume is not one block device")
        completed = subprocess.run(
            ["/usr/sbin/blockdev", "--getsize64", resolved], stdin=subprocess.DEVNULL, capture_output=True, check=True, timeout=30,
            env={"PATH": "/usr/sbin:/usr/bin:/sbin:/bin", "LC_ALL": "C"}, text=True,
        )
        if completed.stderr or int(completed.stdout.strip()) != before["byteLength"]:
            die("VOLUME_PATH_FAILED", "activated LVM volume length differs")
        measured_digest = hash_volume(resolved, before["byteLength"], deadline)
        after = lvm_identity(vg, volume)
        if {key: after[key] for key in ("vg", "volume", "byteLength", "uuid", "pool")} != {key: before[key] for key in ("vg", "volume", "byteLength", "uuid", "pool")} or after["attributes"][4] != "a":
            die("MEASUREMENT_DRIFT", "LVM volume identity changed while hashing")
        return before["byteLength"], measured_digest
    except (OSError, ValueError, subprocess.SubprocessError):
        die("VOLUME_READ_FAILED", "LVM volume could not be activated and measured")
    finally:
        if activated:
            completed = subprocess.run(
                ["/usr/sbin/lvm", "lvchange", "-an", "--", f"{vg}/{volume}"], stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=30,
                env={"PATH": "/usr/sbin:/usr/bin:/sbin:/bin", "LC_ALL": "C"},
            )
            if completed.returncode != 0:
                die("VOLUME_PATH_FAILED", "measured LVM volume could not be deactivated")


def hash_volume(path, length, deadline):
    if length < 1 or length > 274_877_906_944:
        die("VOLUME_SIZE_INVALID", "persistent volume exceeds its admitted bound")
    result = hashlib.sha256()
    remaining = length
    try:
        descriptor = os.open(path, os.O_RDONLY | os.O_CLOEXEC | getattr(os, "O_NOFOLLOW", 0))
        try:
            while remaining:
                if time.time() >= deadline:
                    die("DEADLINE_EXPIRED", "volume measurement exceeded its deadline", 75)
                chunk = os.read(descriptor, min(8 * 1024 * 1024, remaining))
                if not chunk:
                    die("VOLUME_READ_FAILED", "persistent volume ended before its attested length")
                result.update(chunk)
                remaining -= len(chunk)
            if os.read(descriptor, 1):
                die("VOLUME_READ_FAILED", "persistent volume exceeds its attested length")
        finally:
            os.close(descriptor)
    except OSError:
        die("VOLUME_READ_FAILED", "persistent volume cannot be measured")
    return "sha256:" + result.hexdigest()


def main():
    if os.geteuid() != 0 or sys.argv[1:] != ["request"]:
        die("INVALID_OPERATION", "volume measurement requires the fixed root request operation", 64)
    binding = trusted_binding()
    lock_descriptor = os.open("/run/nelos-golden-volume-measure.lock", os.O_CREAT | os.O_CLOEXEC | os.O_RDWR | getattr(os, "O_NOFOLLOW", 0), 0o600)
    os.fchmod(lock_descriptor, 0o600)
    try:
        fcntl.flock(lock_descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        os.close(lock_descriptor)
        die("MEASUREMENT_BUSY", "another golden volume measurement is active", 75)
    raw = sys.stdin.buffer.read(MAX_REQUEST + 1)
    if len(raw) > MAX_REQUEST:
        die("INPUT_LIMIT", "volume-measurement request is oversized", 65)
    try:
        request = json.loads(raw)
    except (UnicodeDecodeError, json.JSONDecodeError):
        die("INVALID_CONTRACT", "volume-measurement request is invalid JSON", 65)
    exact(request, [
        "buildNonce", "configDigest", "deadlineAt", "maxBytes", "name", "node", "providerId", "reservationId", "role", "schemaVersion", "storage", "vmId",
    ], "request")
    role = request.get("role")
    target = binding.get("sourceTemplate") if role == "source" else binding.get("outputTemplate") if role == "output" else None
    deadline = parse_time(request.get("deadlineAt"))
    now = time.time()
    expires = parse_time(binding.get("expiresAt"))
    if request.get("schemaVersion") != 1 or target is None or request.get("providerId") != binding.get("providerId") or request.get("node") != binding.get("node") or request.get("storage") != binding.get("storage") or request.get("reservationId") != binding.get("reservationId") or request.get("buildNonce") != binding.get("buildNonce") or request.get("vmId") != target.get("vmId") or request.get("name") != target.get("name") or not SHA256.fullmatch(str(request.get("configDigest", ""))) or request.get("maxBytes") != 274_877_906_944 or deadline is None or expires is None or now >= deadline or deadline > expires or deadline - now > 7_200:
        die("IDENTITY_MISMATCH", "volume-measurement request differs from the sealed reservation", 77)
    config_path = f"/nodes/{binding['node']}/qemu/{target['vmId']}/config"
    status_path = f"/nodes/{binding['node']}/qemu/{target['vmId']}/status/current"
    config = pvesh(config_path)
    status_value = pvesh(status_path)
    if not isinstance(config, dict) or config.get("name") != target["name"] or int(config.get("template", 0)) != 1 or not isinstance(status_value, dict) or status_value.get("status") != "stopped" or digest(config) != request["configDigest"]:
        die("IDENTITY_MISMATCH", "stopped template configuration differs from the sealed request", 77)
    vg, pool = storage_identity(binding["storage"])
    assignments = []
    for disk_key, encoded in sorted(config.items()):
        if not DISK_KEY.fullmatch(disk_key) or not isinstance(encoded, str):
            continue
        volume_id = encoded.split(",", 1)[0]
        if volume_id.endswith(":cloudinit"):
            continue
        if not VOLUME_ID.fullmatch(volume_id) or not volume_id.startswith(binding["storage"] + ":"):
            die("VOLUME_PATH_FAILED", "persistent volume assignment is outside the sealed storage")
        length, measured_digest = measure_lvm_volume(binding["storage"], volume_id, vg, pool, deadline)
        assignments.append({"diskKey": disk_key, "volumeId": volume_id, "byteLength": length, "digest": measured_digest})
    if not assignments or len({item["volumeId"] for item in assignments}) != len(assignments):
        die("VOLUME_PATH_FAILED", "persistent volume assignments are missing or ambiguous")
    if pvesh(config_path) != config or pvesh(status_path).get("status") != "stopped":
        die("MEASUREMENT_DRIFT", "template configuration or state changed during measurement", 75)
    measured_at = datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
    content = {
        "schemaVersion": 1, "providerId": binding["providerId"], "node": binding["node"], "storage": binding["storage"],
        "vmId": target["vmId"], "name": target["name"], "role": role, "status": "stopped", "configDigest": request["configDigest"],
        "helperDigest": binding["helperDigest"], "attestorFingerprint": binding["volumeAttestorFingerprint"], "volumes": assignments,
    }
    result = {**content, "measuredAt": measured_at, "contentDigest": digest(content)}
    sys.stdout.write(canonical(result) + "\n")


if __name__ == "__main__":
    try:
        main()
    except SystemExit:
        raise
    except Exception:
        die("VOLUME_MEASUREMENT_FAILED", "bounded volume measurement failed")
