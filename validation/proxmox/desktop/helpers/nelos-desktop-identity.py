#!/usr/bin/python3
"""Verify the immutable ChatGPT Desktop payload before any guest authentication."""

import hashlib
import json
import os
import pwd
import re
import selectors
import shutil
import signal
import stat
import subprocess
import sys
import tempfile
import time


SCHEMA_VERSION = 1
LOCK_ID = "nelos-proxmox-desktop-ubuntu-24.04-amd64-20260819"
PACKAGE_LOCK_PATH = "/opt/nelos-desktop/package-lock.json"
BAKE_RECEIPT_PATH = "/opt/nelos-desktop/bake-receipt.json"
IDENTITY_HELPER_PATH = "/usr/libexec/nelos-desktop-identity"
CODEX_PATH = "/usr/lib/chatgpt/resources/codex"
NODE_PATH = "/usr/lib/chatgpt/resources/cua_node/bin/node"
DPKG_QUERY_PATH = "/usr/bin/dpkg-query"
RUNUSER_PATH = "/usr/sbin/runuser"
ENV_PATH = "/usr/bin/env"
PACKAGE_NAME = "chatgpt"
PACKAGE_VERSION = "26.814.41957"
PACKAGE_ARCHITECTURE = "amd64"
PACKAGE_DIGEST = "sha256:4778b26a7abd08647214d5b05c17bd3ebe2d9688d146dabf017c1a2faf93ac7d"
SIGNING_KEY_DIGEST = "sha256:23e2cfbdef6afe95505f9e95a2cb63585da7ffe9b06a51ec08a32407c847d596"
CODEX_VERSION = "0.148.0-alpha.15"
CODEX_DIGEST = "sha256:f13176129580681cf3024192f1ad43535c9933b24b7eca89e90fa57b3f4855fc"
NODE_VERSION = "24.19.0"
NODE_DIGEST = "sha256:bc17c508ffeed0ec622934f9b7fa72f8e78da65350e63c3eceb56fa688aa5e12"
EXPECTED_USER_AGENT = "Codex Desktop/0.148.0-alpha.15"
EXPECTED_PLATFORM_FAMILY = "unix"
EXPECTED_PLATFORM_OS = "linux"
PACKAGE_LOCK_DIGEST = "sha256:9925b56c881ae22ffe6a3d22f8a2066b7ae2b4a4613029c2f79cb024a0398e93"
SIGNATURE_IDENTITY = {
    "fingerprint": "3BFA0E4AE8B8CC16A2D9BA684A3B4A566C4660E4",
    "issuer": "OpenAI",
    "scheme": "debsig-origin-openpgp",
    "subject": "Codex Linux Repository",
}
SHA256 = re.compile(r"^sha256:[0-9a-f]{64}$")
MAX_JSON_BYTES = 1_048_576
MAX_PROBE_BYTES = 65_536
PROBE_TIMEOUT_SECONDS = 10


def fail(message, exit_code=70):
    sys.stderr.write(f"installed Desktop identity rejected: {message}\n")
    raise SystemExit(exit_code)


def test_root():
    root = os.environ.get("NELOS_DESKTOP_IDENTITY_ROOT", "/")
    if not os.path.isabs(root) or root != os.path.normpath(root):
        fail("identity root is invalid", 64)
    if root == "/":
        forbidden = [
            "NELOS_DESKTOP_IDENTITY_PACKAGE_LOCK_SHA256",
            "NELOS_DESKTOP_IDENTITY_EXPECT_UID",
            "NELOS_DESKTOP_IDENTITY_EXPECT_GID",
        ]
        if any(name in os.environ for name in forbidden):
            fail("test-only identity override is forbidden", 77)
    elif not os.path.isdir(root) or os.path.islink(root):
        fail("test identity root is unavailable", 64)
    return root


ROOT = test_root()
TEST_MODE = ROOT != "/"


def at(path):
    return path if not TEST_MODE else os.path.join(ROOT, path.lstrip("/"))


def test_integer(name, default):
    if not TEST_MODE:
        return default
    raw = os.environ.get(name, str(default))
    if re.fullmatch(r"(?:0|[1-9][0-9]{0,9})", raw) is None:
        fail(f"{name} is invalid", 64)
    return int(raw)


EXPECTED_UID = test_integer("NELOS_DESKTOP_IDENTITY_EXPECT_UID", 0)
EXPECTED_GID = test_integer("NELOS_DESKTOP_IDENTITY_EXPECT_GID", 0)
EXPECTED_LOCK_DIGEST = os.environ.get("NELOS_DESKTOP_IDENTITY_PACKAGE_LOCK_SHA256", PACKAGE_LOCK_DIGEST) if TEST_MODE else PACKAGE_LOCK_DIGEST
if SHA256.fullmatch(EXPECTED_LOCK_DIGEST) is None:
    fail("expected package-lock digest is invalid", 64)


def sha256_file(path):
    digest = hashlib.sha256()
    try:
        with open(path, "rb", buffering=0) as handle:
            while True:
                chunk = handle.read(1_048_576)
                if not chunk:
                    break
                digest.update(chunk)
    except OSError:
        fail(f"cannot hash {path}")
    return f"sha256:{digest.hexdigest()}"


def canonical_bytes(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True).encode("utf-8")


def exact_fields(value, fields, label):
    if not isinstance(value, dict) or set(value) != set(fields):
        fail(f"{label} fields differ from the closed contract", 77)
    return value


def trusted_file(logical_path, mode, maximum, label):
    path = at(logical_path)
    try:
        info = os.lstat(path)
    except OSError:
        fail(f"{label} is unavailable")
    if (not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_uid != EXPECTED_UID or
            info.st_gid != EXPECTED_GID or stat.S_IMODE(info.st_mode) != mode or info.st_size < 1 or info.st_size > maximum):
        fail(f"{label} ownership, mode, type, links, or size is invalid", 77)
    return path, info


def load_json(path, label):
    try:
        with open(path, "rb") as handle:
            raw = handle.read(MAX_JSON_BYTES + 1)
        if len(raw) > MAX_JSON_BYTES:
            fail(f"{label} exceeds its bound", 77)
        value = json.loads(raw)
    except (OSError, UnicodeDecodeError, json.JSONDecodeError):
        fail(f"{label} is invalid", 77)
    return value


def validate_lock():
    path, _ = trusted_file(PACKAGE_LOCK_PATH, 0o444, MAX_JSON_BYTES, "package lock")
    if sha256_file(path) != EXPECTED_LOCK_DIGEST:
        fail("package lock digest differs from the baked helper", 77)
    lock = exact_fields(load_json(path, "package lock"), ["artifacts", "generatedAt", "lockId", "platform", "policy", "schemaVersion"], "package lock")
    artifacts = exact_fields(lock.get("artifacts"), ["chatgptDesktop", "graphicalSession", "qga", "signatureVerifier", "ubuntuBase"], "package-lock artifacts")
    desktop = exact_fields(artifacts.get("chatgptDesktop"), [
        "bundledCodexDigest", "bundledCodexPath", "bundledCodexVersion", "bundledNodeDigest", "bundledNodePath",
        "bundledNodeVersion", "digest", "maturity", "name", "officialDocumentation", "signatureIdentity", "signingKeyDigest",
        "source", "version",
    ], "Desktop package lock")
    expected_common = {
        "lockId": LOCK_ID,
        "platform": {"architecture": "amd64", "distribution": "ubuntu", "release": "24.04"},
        "schemaVersion": SCHEMA_VERSION,
    }
    if any(lock.get(field) != value for field, value in expected_common.items()):
        fail("package lock platform or identity differs", 77)
    expected_desktop = {
        "bundledCodexPath": CODEX_PATH,
        "bundledCodexVersion": CODEX_VERSION,
        "bundledNodePath": NODE_PATH,
        "bundledNodeVersion": NODE_VERSION,
        "maturity": "preview",
        "name": PACKAGE_NAME,
        "signatureIdentity": SIGNATURE_IDENTITY,
        "signingKeyDigest": SIGNING_KEY_DIGEST,
        "version": PACKAGE_VERSION,
    }
    if any(desktop.get(field) != value for field, value in expected_desktop.items()):
        fail("Desktop package lock identity differs", 77)
    if (not isinstance(desktop.get("source"), str) or not desktop["source"].startswith("https://persistent.oaistatic.com/") or
            not isinstance(desktop.get("officialDocumentation"), str) or not desktop["officialDocumentation"].startswith("https://learn.chatgpt.com/")):
        fail("Desktop package lock origin differs", 77)
    for field in ("digest", "bundledCodexDigest", "bundledNodeDigest"):
        if SHA256.fullmatch(desktop.get(field, "")) is None:
            fail(f"Desktop package lock {field} is invalid", 77)
    if not TEST_MODE and (desktop["digest"] != PACKAGE_DIGEST or desktop["bundledCodexDigest"] != CODEX_DIGEST or desktop["bundledNodeDigest"] != NODE_DIGEST):
        fail("Desktop package or runtime digest differs", 77)
    return lock, desktop


def command_output(command, expected, label):
    try:
        result = subprocess.run(
            command,
            stdin=subprocess.DEVNULL,
            capture_output=True,
            check=False,
            timeout=5,
            env={"CODEX_HOME": "/nonexistent", "HOME": "/nonexistent", "LC_ALL": "C", "PATH": "/usr/bin:/bin"},
        )
    except (OSError, subprocess.TimeoutExpired):
        fail(f"{label} version probe failed")
    if result.returncode != 0 or result.stderr or len(result.stdout) > 1024 or result.stdout.decode("utf-8", "strict").rstrip("\n") != expected:
        fail(f"{label} version differs", 77)


def dpkg_identity():
    query, _ = trusted_file(DPKG_QUERY_PATH, 0o755, 16_777_216, "dpkg-query")
    try:
        result = subprocess.run(
            [query, "-W", "-f=${Package}\\t${Version}\\t${Architecture}\\t${Status}\\n", PACKAGE_NAME],
            stdin=subprocess.DEVNULL,
            capture_output=True,
            check=False,
            timeout=5,
            env={"LC_ALL": "C", "PATH": "/usr/bin:/bin"},
        )
    except (OSError, subprocess.TimeoutExpired):
        fail("installed Desktop package query failed")
    expected = f"{PACKAGE_NAME}\t{PACKAGE_VERSION}\t{PACKAGE_ARCHITECTURE}\tinstall ok installed\n".encode("utf-8")
    if result.returncode != 0 or result.stderr or result.stdout != expected:
        fail("installed Desktop package identity differs", 77)


def runtime_record(logical_path, version, expected_digest, label):
    path, info = trusted_file(logical_path, 0o755, 536_870_912, label)
    digest = sha256_file(path)
    if digest != expected_digest:
        fail(f"{label} digest differs", 77)
    command_output([path, "--version"], version, label)
    return {
        "digest": digest,
        "gid": info.st_gid,
        "mode": "0755",
        "path": logical_path,
        "uid": info.st_uid,
        "version": version.removeprefix("codex-cli ").removeprefix("v"),
    }


def identity_helper_record():
    path, info = trusted_file(IDENTITY_HELPER_PATH, 0o755, 1_048_576, "identity helper")
    if not TEST_MODE:
        try:
            if not os.path.samefile(sys.argv[0], path):
                fail("identity helper was not invoked through its fixed path", 77)
        except OSError:
            fail("identity helper invocation is invalid", 77)
    return {
        "digest": sha256_file(path),
        "gid": info.st_gid,
        "mode": "0755",
        "path": IDENTITY_HELPER_PATH,
        "uid": info.st_uid,
    }


def receipt_payload(desktop):
    dpkg_identity()
    codex = runtime_record(CODEX_PATH, f"codex-cli {CODEX_VERSION}", desktop["bundledCodexDigest"], "bundled Codex")
    node = runtime_record(NODE_PATH, f"v{NODE_VERSION}", desktop["bundledNodeDigest"], "bundled Node")
    return {
        "appServer": {"expectedPlatformFamily": EXPECTED_PLATFORM_FAMILY, "expectedPlatformOs": EXPECTED_PLATFORM_OS, "expectedUserAgent": EXPECTED_USER_AGENT},
        "bundledCodex": codex,
        "bundledNode": node,
        "desktopPackage": {
            "architecture": PACKAGE_ARCHITECTURE,
            "digest": desktop["digest"],
            "name": PACKAGE_NAME,
            "signatureIdentity": SIGNATURE_IDENTITY,
            "signingKeyDigest": SIGNING_KEY_DIGEST,
            "version": PACKAGE_VERSION,
        },
        "identityHelper": identity_helper_record(),
        "kind": "nelos-desktop-bake-receipt",
        "lockId": LOCK_ID,
        "packageLockDigest": EXPECTED_LOCK_DIGEST,
        "schemaVersion": SCHEMA_VERSION,
    }


def bake_digest(payload):
    digest = hashlib.sha256(b"nelos-desktop-bake-receipt-v1\0" + canonical_bytes(payload)).hexdigest()
    return f"sha256:{digest}"


def write_receipt(value):
    path = at(BAKE_RECEIPT_PATH)
    parent = os.path.dirname(path)
    try:
        info = os.lstat(parent)
    except OSError:
        fail("bake receipt directory is unavailable")
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != EXPECTED_UID or info.st_gid != EXPECTED_GID or stat.S_IMODE(info.st_mode) != 0o755:
        fail("bake receipt directory ownership or mode is invalid", 77)
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    raw = canonical_bytes(value) + b"\n"
    try:
        descriptor = os.open(path, flags, 0o400)
        try:
            remaining = memoryview(raw)
            while remaining:
                written = os.write(descriptor, remaining)
                if written < 1:
                    fail("bake receipt write did not progress")
                remaining = remaining[written:]
            os.fchmod(descriptor, 0o444)
            if hasattr(os, "fchown"):
                os.fchown(descriptor, EXPECTED_UID, EXPECTED_GID)
            os.fsync(descriptor)
        finally:
            os.close(descriptor)
    except OSError:
        fail("bake receipt could not be created exclusively", 77)


def bake(deb_path):
    if not os.path.isabs(deb_path) or os.path.islink(deb_path):
        fail("bake package path is invalid", 64)
    try:
        info = os.lstat(deb_path)
    except OSError:
        fail("bake package is unavailable")
    if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_uid != EXPECTED_UID or info.st_gid != EXPECTED_GID or info.st_mode & 0o022:
        fail("bake package ownership, type, links, or mode is invalid", 77)
    _, desktop = validate_lock()
    if sha256_file(deb_path) != desktop["digest"]:
        fail("bake package digest differs from the package lock", 77)
    payload = receipt_payload(desktop)
    receipt = {**payload, "bakeDigest": bake_digest(payload)}
    write_receipt(receipt)
    sys.stdout.write(json.dumps({"bakeDigest": receipt["bakeDigest"], "kind": "nelos-desktop-bake-complete", "schemaVersion": 1}, separators=(",", ":")) + "\n")


def terminate(child):
    if child.poll() is not None:
        return
    try:
        os.killpg(child.pid, signal.SIGTERM)
        child.wait(timeout=0.5)
    except (OSError, subprocess.TimeoutExpired):
        try:
            os.killpg(child.pid, signal.SIGKILL)
        except OSError:
            pass
        try:
            child.wait(timeout=1)
        except subprocess.TimeoutExpired:
            pass


def app_server_probe():
    run_parent = at("/run")
    try:
        os.makedirs(run_parent, mode=0o755, exist_ok=True)
        probe_root = tempfile.mkdtemp(prefix="nelos-desktop-identity.", dir=run_parent)
    except OSError:
        fail("identity probe root is unavailable")
    child = None
    try:
        if TEST_MODE:
            automation_uid, automation_gid = EXPECTED_UID, EXPECTED_GID
            automation_name = "nelosauto"
        else:
            try:
                account = pwd.getpwnam("nelosauto")
            except KeyError:
                fail("automation account is unavailable", 77)
            automation_uid, automation_gid, automation_name = account.pw_uid, account.pw_gid, account.pw_name
            if automation_uid == 0 or automation_gid == 0 or account.pw_dir != "/home/nelosauto":
                fail("automation account identity differs", 77)
        os.chmod(probe_root, 0o700)
        os.chown(probe_root, automation_uid, automation_gid)
        home = os.path.join(probe_root, "home")
        codex_home = os.path.join(probe_root, "codex")
        os.mkdir(home, 0o700)
        os.mkdir(codex_home, 0o700)
        os.chown(home, automation_uid, automation_gid)
        os.chown(codex_home, automation_uid, automation_gid)
        codex = at(CODEX_PATH)
        codex_args = [codex, "app-server", "--stdio", "--strict-config", "-c", 'cli_auth_credentials_store="file"']
        clean_env = {
            "CODEX_HOME": codex_home,
            "HOME": home,
            "LC_ALL": "C",
            "LOGNAME": automation_name,
            "PATH": "/usr/bin:/bin",
            "USER": automation_name,
        }
        if TEST_MODE:
            command = codex_args
            launch_env = clean_env
        else:
            command = [RUNUSER_PATH, "-u", automation_name, "--", ENV_PATH, "-i", *[f"{key}={value}" for key, value in clean_env.items()], *codex_args]
            launch_env = {"LC_ALL": "C", "PATH": "/usr/sbin:/usr/bin:/sbin:/bin"}
        child = subprocess.Popen(
            command,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            env=launch_env,
            start_new_session=True,
        )
        request = canonical_bytes({
            "id": 1,
            "method": "initialize",
            "params": {
                "capabilities": {"experimentalApi": True, "requestAttestation": False},
                "clientInfo": {"name": "nelos_desktop_identity", "version": "1.0.0"},
            },
        }) + b"\n"
        child.stdin.write(request)
        child.stdin.flush()
        selector = selectors.DefaultSelector()
        selector.register(child.stdout, selectors.EVENT_READ)
        buffer = b""
        total_bytes = 0
        deadline = time.monotonic() + PROBE_TIMEOUT_SECONDS
        response = None
        while time.monotonic() < deadline and response is None:
            remaining = deadline - time.monotonic()
            if not selector.select(max(0, remaining)):
                break
            chunk = os.read(child.stdout.fileno(), 4096)
            if not chunk:
                break
            total_bytes += len(chunk)
            buffer += chunk
            if total_bytes > MAX_PROBE_BYTES:
                fail("app-server initialize output exceeded its bound", 77)
            while b"\n" in buffer:
                line, buffer = buffer.split(b"\n", 1)
                if not line:
                    continue
                try:
                    message = json.loads(line)
                except (UnicodeDecodeError, json.JSONDecodeError):
                    fail("app-server initialize response is invalid", 77)
                if not isinstance(message, dict):
                    fail("app-server initialize response is invalid", 77)
                if message.get("id") == 1:
                    if response is not None or set(message) != {"id", "result"}:
                        fail("app-server initialize response fields differ", 77)
                    response = message["result"]
        expected = {
            "codexHome": codex_home,
            "platformFamily": EXPECTED_PLATFORM_FAMILY,
            "platformOs": EXPECTED_PLATFORM_OS,
            "userAgent": EXPECTED_USER_AGENT,
        }
        if response != expected:
            fail("app-server initialize identity differs", 77)
        return {
            "platformFamily": EXPECTED_PLATFORM_FAMILY,
            "platformOs": EXPECTED_PLATFORM_OS,
            "userAgent": EXPECTED_USER_AGENT,
        }
    except (OSError, BrokenPipeError, subprocess.SubprocessError):
        fail("app-server initialize probe failed")
    finally:
        if child is not None:
            terminate(child)
        shutil.rmtree(probe_root, ignore_errors=True)


def verify():
    _, desktop = validate_lock()
    payload = receipt_payload(desktop)
    receipt_path, _ = trusted_file(BAKE_RECEIPT_PATH, 0o444, MAX_JSON_BYTES, "bake receipt")
    receipt = load_json(receipt_path, "bake receipt")
    expected = {**payload, "bakeDigest": bake_digest(payload)}
    if receipt != expected:
        fail("bake receipt differs from the installed Desktop identity", 77)
    app_server = app_server_probe()
    result = {
        "appServer": app_server,
        "bakeReceiptDigest": sha256_file(receipt_path),
        "bundledCodex": payload["bundledCodex"],
        "bundledNode": payload["bundledNode"],
        "desktopPackage": {
            "architecture": PACKAGE_ARCHITECTURE,
            "digest": desktop["digest"],
            "name": PACKAGE_NAME,
            "version": PACKAGE_VERSION,
        },
        "kind": "nelos-desktop-installed-identity",
        "lockId": LOCK_ID,
        "packageLockDigest": EXPECTED_LOCK_DIGEST,
        "schemaVersion": SCHEMA_VERSION,
        "verified": True,
    }
    sys.stdout.write(json.dumps(result, separators=(",", ":"), sort_keys=True) + "\n")


def main():
    arguments = sys.argv[1:]
    if not arguments:
        verify()
        return
    if len(arguments) == 2 and arguments[0] == "bake":
        bake(arguments[1])
        return
    fail("only zero-argument verification or provisioning bake is supported", 64)


if __name__ == "__main__":
    try:
        main()
    except SystemExit:
        raise
    except Exception:
        fail("identity helper failed closed")
