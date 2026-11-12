"""Fetch pinned developer export inputs. This is never used by Studio at runtime.

Requires Python 3.10+ and Git for WaveGen. Existing mismatched files/checkouts
are refused rather than overwritten. No example recordings are downloaded
from the RE-USE snapshot. Downloads are verified before publication.
"""
from __future__ import annotations

import argparse
from dataclasses import dataclass
import hashlib
import http.client
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
import time
import urllib.error
import urllib.request

WAVEGEN_REVISION = "399ce751225001da75a62725f8827693a51bcc18"
WAVEGEN_URL = "https://github.com/sh-lee-prml/WaveGen.git"
CHECKPOINT_REVISION = "43197aeeb6ca74de1a039f8ba0d7f02d26fc105e"
REUSE_REVISION = "31f82f2efad1095034492f236e8dac9239ba713b"
MAMBA_REVISION = "95d8aba8a8c75aedcaa6143713b11e745e7cd0d9"

WAVEGEN_FILES = {
    "flash": (
        ("WaveGen_Flash/model.safetensors", 2724279472, "d4f1a949e8766f73f886bfb5cc26e9fe8eac643a182bdcb10263db5452a39f66"),
        ("WaveGen_Flash/WaveGen_Flash.yaml", 1299, "8cc3fb4b003ed4c9cb506510ca43e831e9a9cd8d53180fb997fe87a6d8fb2fff"),
        ("WaveGen_Flash/vocab.txt", 11295, "836aabf4c2306d215ce4331524d216e29ccecbc9588c75c73d9b3e77439c2692"),
    ),
    "vspec": (
        ("WaveGen_VSpec/model_1400000.safetensors", 2724279504, "98bd63f4c43522be792377c176fd2e95e591ec5dce69091b489f49559bad15b9"),
        ("WaveGen_VSpec/WaveGen_VSpec.yaml", 1223, "412482d5b6a0ac39085bbdab5b4cd1919588c2a53a0ae4e61b2e7d508735e0d2"),
        ("WaveGen_VSpec/vocab.txt", 11295, "836aabf4c2306d215ce4331524d216e29ccecbc9588c75c73d9b3e77439c2692"),
    ),
}
REUSE_FILES = (
    ("README.md", 11941, "6fa6e175b953fdb596d5d1c10feed5ac249f249f65e40c6d9ad981650924a9f2"),
    ("LICENSE", 3211, "a3d882953f026d3e2fdd57842d9c522c8320d4c0388af2278bcf4d438d255a2c"),
    ("config.json", 830, "e69986483774f01893d2727503addc49ef201d19e6e1a266b8d4e971e28c478d"),
    ("model.safetensors", 38592940, "06badaf4029b297f97f7fe48d62990b48d5482608210df577354e0d4e0ed70e1"),
    ("inference.py", 4458, "71ccef1b231bd30c85b1cddd85266ef9cdc3216dc85db65e38f89a670ae28236"),
    ("inference_chunk.py", 6411, "df0fd3e983536f1a49440ab61ec7fb5cea2e878c58ea1aee15e182769646db60"),
    ("inference.sh", 257, "1cbd7fa5e0723754e0273fa45a645e5252a8940cb2e0bdb5f029deb3b6fa39b0"),
    ("inference_chunk.sh", 335, "6543b930c6c330c249c7899f502e53f1f334831bc92f0091755fdb9d306e33a8"),
    ("models/codec_module_time_d4.py", 6059, "02bd1d478f36a9b38dce7d44368805298f42798ea239304580f1ccffafe766a0"),
    ("models/generator_SEMamba_time_d4.py", 3311, "beebaf2d9ab7b83c101f46246ae7a7a8a2d2f57b6683025d3712c64c1b7d6817"),
    ("models/mamba_block2_SEMamba.py", 2733, "97397af2d7e0f5e6530aa8c4a45b4f0f0030b4b56d8c9922a9b0bc25f8b5962e"),
    ("models/stfts.py", 3303, "b82383c1ec7d7e9fe9bca1f93b3c0afe9609e191c38efc16f705e7145198d835"),
    ("utils/util.py", 1061, "85960c6eb94033f37f9f77676a0cf2e7285ce12b11c24ba77577fc354766d0bf"),
    ("recipes/USEMamba_30x1_lr_00002_norm_05_vq_065_nfft_320_hop_40_NRIR_012_pha_0005_com_04_early_001.yaml", 2216, "06aefc68eb8a5e8bbe6faf51e3bb8a596a82842e9993cbda42d21477b5dcf168"),
)
MAMBA_FILES = (
    ("mamba_ssm/modules/mamba_simple.py", 11710, "a17e4c51b582dc0d4d690a649eba521cd0c1ee3dc8f0473a0967cdc9ec0874e3"),
    ("mamba_ssm/ops/selective_scan_interface.py", 19852, "c79f4432536402fe4d6c1026ccf8d5fc0aaa62b790e9a622295aee14ac45dbcc"),
    ("LICENSE", 11348, "760939b000194d04548ede6a857bbe735d1695d8422ec85955c8e2bd7f4b95c5"),
)


@dataclass(frozen=True)
class Artifact:
    relative_path: str
    url: str
    size: int
    sha256: str


def artifacts(models: list[str]) -> list[Artifact]:
    result = []
    for model in dict.fromkeys(models):
        if model in WAVEGEN_FILES:
            for name, size, digest in WAVEGEN_FILES[model]:
                result.append(Artifact("WaveGen/ckpts/" + name,
                    f"https://huggingface.co/LeeSangHoon/WaveGen/resolve/{CHECKPOINT_REVISION}/{name}", size, digest))
        elif model == "reuse":
            for name, size, digest in REUSE_FILES:
                result.append(Artifact("reuse/official/" + name,
                    f"https://huggingface.co/nvidia/NVIDIA-NemotronLabs-RE-USE/resolve/{REUSE_REVISION}/{name}", size, digest))
            for name, size, digest in MAMBA_FILES:
                result.append(Artifact("reuse/mamba_source/" + name,
                    f"https://raw.githubusercontent.com/state-spaces/mamba/{MAMBA_REVISION}/{name}", size, digest))
        else:
            raise ValueError(f"Unknown model: {model}")
    return result


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(8 * 1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def safe_destination(root: Path, relative: str) -> Path:
    path = root / relative
    if path.is_symlink() or not path.resolve().is_relative_to(root.resolve()):
        raise ValueError(f"Destination escapes the selected upstream directory: {relative}")
    return path


def verify_file(path: Path, item: Artifact) -> bool:
    return path.is_file() and path.stat().st_size == item.size and sha256(path) == item.sha256


def fetch_file(root: Path, item: Artifact) -> None:
    destination = safe_destination(root, item.relative_path)
    if destination.exists():
        if not verify_file(destination, item):
            raise ValueError(f"Existing file differs from the pinned artifact; preserved: {destination}")
        print(f"Verified existing {item.relative_path}", flush=True)
        return
    destination.parent.mkdir(parents=True, exist_ok=True)
    partial = safe_destination(root, item.relative_path + ".part")
    if partial.exists() and (not partial.is_file() or partial.stat().st_nlink != 1 or partial.stat().st_size > item.size):
        raise ValueError(f"Unsafe or oversized partial file; move it aside before retrying: {partial}")
    for attempt in range(3):
        offset = partial.stat().st_size if partial.exists() else 0
        if offset == item.size:
            break
        headers = {"User-Agent": "WaveGen-Studio-Export/0.1", "Accept-Encoding": "identity"}
        if offset:
            headers["Range"] = f"bytes={offset}-"
        print(f"Fetching {item.relative_path} ({offset}/{item.size} bytes)", flush=True)
        try:
            request = urllib.request.Request(item.url, headers=headers)
            with urllib.request.urlopen(request, timeout=90) as response:
                status = response.status
                if offset or status == 206:
                    match = re.fullmatch(r"bytes (\d+)-(\d+)/(\d+)", response.headers.get("Content-Range", ""))
                    if status != 206 or not match or int(match[1]) != offset or int(match[3]) != item.size:
                        raise ValueError(f"Server did not honor the requested range; partial preserved: {partial}")
                elif status != 200:
                    raise ValueError(f"Unexpected HTTP status {status}")
                mode = "ab" if partial.exists() else "xb"
                with partial.open(mode) as output:
                    while chunk := response.read(1024 * 1024):
                        if output.tell() + len(chunk) > item.size:
                            raise ValueError(f"Download exceeds the pinned size: {item.relative_path}")
                        output.write(chunk)
            if partial.stat().st_size == item.size:
                break
            raise OSError("The download ended before the expected size")
        except (OSError, urllib.error.URLError, http.client.IncompleteRead) as error:
            if isinstance(error, urllib.error.HTTPError) and 400 <= error.code < 500 and error.code != 429:
                raise
            if attempt == 2:
                raise RuntimeError(f"Download interrupted; rerun to resume {partial}") from error
            time.sleep(attempt + 1)
    if not verify_file(partial, item):
        raise ValueError(f"SHA-256 verification failed; no destination was replaced. Move the partial aside and retry: {partial}")
    # Windows rename refuses an existing destination. POSIX rename can replace
    # it, so use no-clobber hard-link publication on that platform instead.
    # The verified partial remains recoverable if publication fails.
    if os.name == "nt":
        partial.rename(destination)
    else:
        os.link(partial, destination)
        partial.unlink()
    print(f"Verified {item.relative_path}", flush=True)


def git_output(directory: Path, *args: str) -> str:
    return subprocess.check_output(["git", "-c", "core.autocrlf=false", "-C", str(directory), *args],
                                   text=True, encoding="utf-8").strip()


def verify_checkout(destination: Path) -> None:
    if destination.is_symlink() or getattr(destination, "is_junction", lambda: False)():
        raise ValueError("The WaveGen checkout must not be a linked directory")
    top = Path(git_output(destination, "rev-parse", "--show-toplevel")).resolve()
    if top != destination.resolve() or git_output(destination, "rev-parse", "HEAD") != WAVEGEN_REVISION:
        raise ValueError("Existing WaveGen checkout is not the pinned revision; it was not changed")
    if git_output(destination, "status", "--porcelain", "--untracked-files=no"):
        raise ValueError("Existing WaveGen checkout has tracked changes; it was not changed")


def ensure_wavegen_checkout(root: Path) -> None:
    destination = safe_destination(root, "WaveGen")
    if destination.exists():
        verify_checkout(destination)
        print("Verified pinned WaveGen checkout", flush=True)
        return
    root.mkdir(parents=True, exist_ok=True)
    staging = Path(tempfile.mkdtemp(prefix=".WaveGen-fetch-", dir=root))
    try:
        git_output(staging, "init")
        git_output(staging, "remote", "add", "origin", WAVEGEN_URL)
        git_output(staging, "fetch", "--depth", "1", "origin", WAVEGEN_REVISION)
        git_output(staging, "checkout", "--detach", "FETCH_HEAD")
        verify_checkout(staging)
        if destination.exists():
            raise ValueError("WaveGen destination appeared during fetch; existing directory was preserved")
        staging.rename(destination)
    except Exception:
        print(f"Incomplete source fetch retained at {staging}", flush=True)
        raise


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--models", nargs="+", choices=("flash", "vspec", "reuse"), default=["flash", "vspec", "reuse"])
    parser.add_argument("--upstream-directory", "--root", type=Path,
                        default=Path(__file__).resolve().parents[2] / "upstream")
    parser.add_argument("--list", action="store_true", help="Print the pinned input plan without writing or downloading")
    args = parser.parse_args()
    items = artifacts(args.models)
    plan = {"wavegen_source_revision": WAVEGEN_REVISION if any(x in args.models for x in ("flash", "vspec")) else None,
            "checkpoint_revision": CHECKPOINT_REVISION, "reuse_revision": REUSE_REVISION, "mamba_revision": MAMBA_REVISION,
            "files": [item.__dict__ for item in items]}
    if args.list:
        print(json.dumps(plan, indent=2))
        return
    root = args.upstream_directory.expanduser().resolve()
    if any(x in args.models for x in ("flash", "vspec")):
        ensure_wavegen_checkout(root)
    for item in items:
        fetch_file(root, item)
    print("Pinned export inputs are ready. Python is used only for developer export, not the Studio runtime.")


if __name__ == "__main__":
    main()
