#!/usr/bin/python3
"""Exercise the production ImageMagick no-map/no-disk wrapper."""

import json
import pathlib
import subprocess
import sys
import tempfile


if len(sys.argv) != 3 or sys.argv[2] not in ("bounded", "oversized-spill"):
    raise SystemExit(64)

helper_path = pathlib.Path(sys.argv[1])
source = helper_path.read_text(encoding="utf8")
marker = "try: request=json.load(sys.stdin)"
if source.count(marker) != 1:
    raise SystemExit(65)

scope = {"__name__": "nelos_atspi_imagemagick_probe"}
exec(compile(source.split(marker, 1)[0], str(helper_path), "exec"), scope)


class ProbeFailure(Exception):
    def __init__(self, code):
        super().__init__(code)
        self.code = code


root = pathlib.Path(tempfile.mkdtemp(prefix="nelos-magick-probe-"))
created = []


def create_cache():
    path = pathlib.Path(tempfile.mkdtemp(prefix="cache-", dir=root))
    created.append(path)
    return str(path)


def fake_check_output(command, *, input=None, timeout=None, env=None, text=False):
    del input, timeout, text
    assert command[1:4] == ["-limit", "memory", "1MiB"]
    assert ["-limit", "map", "0"] == command[4:7]
    assert ["-limit", "disk", "0"] == command[7:10]
    assert env["MAGICK_MEMORY_LIMIT"] == "1MiB"
    assert env["MAGICK_MAP_LIMIT"] == "0" and env["MAGICK_DISK_LIMIT"] == "0"
    cache = pathlib.Path(env["MAGICK_TMPDIR"])
    assert env["TMPDIR"] == str(cache) and env["TMP"] == str(cache) and env["TEMP"] == str(cache)
    assert cache.parent == root and cache.is_dir()
    if sys.argv[2] == "oversized-spill":
        (cache / "magick-pixel-cache.bin").write_bytes(b"simulated raw pixels")
        raise subprocess.CalledProcessError(1, command)
    return b"bounded-memory-result"


scope["fail"] = lambda code: (_ for _ in ()).throw(ProbeFailure(code))
scope["create_magick_cache"] = create_cache
scope["MAGICK_MEMORY_LIMIT"] = "1MiB"
scope["subprocess"].check_output = fake_check_output

try:
    result = scope["memory_only_magick"](
        "/usr/bin/convert",
        ["-size", "7680x4320", "xc:black", "png:-"],
    )
    outcome = {"result": result.decode("ascii"), "error": None}
except ProbeFailure as error:
    outcome = {"result": None, "error": error.code}

remaining = [path.name for path in root.iterdir()]
root.rmdir()
outcome["cacheDirectoriesCreated"] = len(created)
outcome["remainingEntries"] = remaining
sys.stdout.write(json.dumps(outcome, separators=(",", ":")))
