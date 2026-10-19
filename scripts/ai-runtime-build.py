#!/usr/bin/env python3
"""Build a separate, relocatable image/music runtime, without model weights."""
from __future__ import annotations

import argparse
import datetime as dt
import importlib.util
import json
import os
from pathlib import Path
import platform
import re
import shutil
import subprocess
import tarfile
import zipfile

SCRIPT = Path(__file__).resolve().parent
REPO = SCRIPT.parent
_spec = importlib.util.spec_from_file_location("portable_runtime", SCRIPT / "optional-speech-runtime-build.py")
portable = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(portable)
portable.MAX_ARCHIVE_BYTES = 8 * 1024**3


def audit_macos(root: Path, output: Path, minimum: str) -> None:
    if platform.system() != "Darwin":
        return
    records = []
    magic = {b"\xfe\xed\xfa\xce", b"\xce\xfa\xed\xfe", b"\xfe\xed\xfa\xcf", b"\xcf\xfa\xed\xfe",
             b"\xca\xfe\xba\xbe", b"\xbe\xba\xfe\xca", b"\xca\xfe\xba\xbf", b"\xbf\xba\xfe\xca"}
    for path in sorted(root.rglob("*")):
        if not path.is_file():
            continue
        with path.open("rb") as stream:
            if stream.read(4) not in magic:
                continue
        headers = subprocess.check_output(["otool", "-l", path], text=True)
        minima = re.findall(r"cmd LC_BUILD_VERSION\s+cmdsize \d+\s+platform \d+\s+minos ([\d.]+)", headers)
        minima += re.findall(r"cmd LC_VERSION_MIN_MACOSX\s+cmdsize \d+\s+version ([\d.]+)", headers)
        verified = subprocess.run(["codesign", "--verify", "--strict", "--all-architectures", path], capture_output=True, text=True)
        record = dict(path=path.relative_to(root).as_posix(), minimumMacOS=minima,
                      originalSha256=portable.sha256(path), signingAction="preserved")
        if verified.returncode and "code object is not signed at all" in verified.stderr:
            subprocess.run(["codesign", "--force", "--sign", "-", "--timestamp=none", path], check=True)
            record["signingAction"] = "ad-hoc for unsigned component"
            verified = subprocess.run(["codesign", "--verify", "--strict", "--all-architectures", path], capture_output=True, text=True)
        if verified.returncode:
            raise ValueError(f"Invalid native component signature: {path}: {verified.stderr}")
        if any(tuple(map(int, value.split(".")[:2])) > tuple(map(int, minimum.split(".")[:2])) for value in minima):
            raise ValueError(f"Native component requires macOS newer than {minimum}: {path}")
        record.update(sha256=portable.sha256(path), signatureValid=True)
        records.append(record)
    portable.write_json(output, dict(schema=1, supportedMinimumMacOS=minimum, files=records))


def install_music_source(lock: dict, work: Path, root: Path, executable: Path, env: dict) -> None:
    archive = work / "downloads/music-source.tar.gz"
    portable.download(lock["musicSource"], archive)
    destination = work / "music-source"
    prefix = "ACE-Step-1.5-" + lock["musicSource"]["revision"]
    with tarfile.open(archive, "r:gz") as source:
        for entry in source:
            name = portable.relative(entry.name.rstrip("/"))
            if name.parts[0] != prefix:
                raise ValueError("Unexpected inference source prefix")
            if entry.isdir():
                continue
            if not entry.isfile():
                raise ValueError("Inference source archive contains a special file")
            target = destination / name
            target.parent.mkdir(parents=True, exist_ok=True)
            with source.extractfile(entry) as src, target.open("wb") as dst:
                shutil.copyfileobj(src, dst)
    source = destination / prefix
    site = Path(subprocess.check_output([executable, "-I", "-B", "-c", "import sysconfig; print(sysconfig.get_path('purelib'))"], env=env, text=True).strip())
    if not site.resolve().is_relative_to(root.resolve()):
        raise ValueError("Interpreter site directory escapes runtime")
    shutil.copytree(source / "acestep", site / "acestep",
                    ignore=shutil.ignore_patterns("__pycache__", "*.pyc", "*_test.py", "test_*.py", "tests"))
    license_root = root / "licenses/music-source"
    license_root.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source / "LICENSE", license_root / "LICENSE")
    portable.write_json(license_root / "source.json", lock["musicSource"])
    shutil.rmtree(destination)
    archive.unlink()


def package(root: Path, archive: Path, spec: dict, platform_id: str) -> dict:
    files = []
    for path in sorted(root.rglob("*")):
        if path.is_symlink():
            raise ValueError(f"Runtime contains a symlink: {path}")
        if path.is_file() and path != root / "manifest.json":
            item = dict(path=path.relative_to(root).as_posix(), size=path.stat().st_size, sha256=portable.sha256(path))
            if path.stat().st_mode & 0o111 or item["path"] == spec["executable"]:
                item["executable"] = True
            files.append(item)
    portable.write_json(root / "manifest.json", dict(schema=1, files=files))
    archive.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(archive, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=6, allowZip64=True) as output:
        for path in sorted(root.rglob("*")):
            if path.is_file():
                output.write(path, path.relative_to(root).as_posix())
    return dict(platform=platform_id, filename=archive.name, size=archive.stat().st_size,
                sha256=portable.sha256(archive), unpackedSize=sum(f["size"] for f in files) + (root / "manifest.json").stat().st_size,
                manifestSha256=portable.sha256(root / "manifest.json"), executable=spec["executable"], script="runner/check.py")


def check(root: Path, spec: dict, output: Path, *, require_gpu: bool) -> dict:
    env = portable.clean_environment()
    executable = root / portable.relative(spec["executable"])
    env.update(HF_HUB_OFFLINE="1", TRANSFORMERS_OFFLINE="1", HF_HUB_DISABLE_XET="1", PYTORCH_ENABLE_MPS_FALLBACK="1")
    env["PATH"] = str(executable.parent) + (os.pathsep + str(Path(os.environ.get("SystemRoot", "C:/Windows")) / "System32") if os.name == "nt" else ":/usr/bin:/bin")
    command = [executable, "-I", "-B", root / "runner/check.py", "--self-test"]
    if require_gpu:
        command.append("--require-gpu")
    portable.run(command, output, env=env, cwd=output.parent, timeout=900)
    lines = output.read_text(encoding="utf-8").splitlines()
    result = json.loads(next(line for line in reversed(lines) if line.startswith("{")))
    if spec.get("cudaVersion") and result["cudaVersion"] != spec["cudaVersion"]:
        raise ValueError("Packaged GPU runtime version differs from its lock")
    return result


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--platform", required=True, choices=("macos-arm64", "windows-x64", "linux-x64"))
    parser.add_argument("--work", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--require-gpu", action="store_true")
    args = parser.parse_args()
    expected = {"macos-arm64": ("Darwin", "arm64"), "windows-x64": ("Windows", "AMD64"), "linux-x64": ("Linux", "x86_64")}[args.platform]
    if (platform.system(), platform.machine()) != expected:
        raise ValueError(f"Build must run on target hardware: {expected}")
    args.work, args.output = args.work.resolve(), args.output.resolve()
    root = args.work / "runtime"
    if root.exists():
        raise ValueError("Build directory must be fresh")
    root.mkdir(parents=True)
    args.output.mkdir(parents=True, exist_ok=True)
    logs = args.output / "logs"
    lock = json.loads((SCRIPT / "ai-runtime.lock.json").read_text())
    spec = lock["platforms"][args.platform]
    archive = args.work / "downloads/python.tar.gz"
    portable.download(spec, archive)
    portable.unpack_python(archive, root)
    archive.unlink()
    executable = root / portable.relative(spec["executable"])
    env = portable.clean_environment()
    portable.run([executable, "-I", "-B", "-m", "pip", "install", "--no-cache-dir", "pip==25.3", "wheel==0.45.1", "setuptools==80.9.0"], logs / "bootstrap.log", env=env)
    for wheel in spec["wheels"]:
        filename = Path(portable.urllib.parse.unquote(portable.urllib.parse.urlparse(wheel["url"]).path)).name
        destination = args.work / "downloads" / filename
        portable.download(wheel, destination)
        portable.run([executable, "-I", "-B", "-m", "pip", "install", "--no-deps", "--no-cache-dir", destination], logs / (wheel["name"] + "-install.log"), env=env)
        destination.unlink()
    portable.run([executable, "-I", "-B", "-m", "pip", "install", "--no-deps", "--only-binary=:all:", "--no-cache-dir", "--report", logs / "packages-install.json", "-r", SCRIPT / "ai-runtime-requirements.txt"], logs / "packages-install.log", env=env)
    portable.run([executable, "-I", "-B", "-m", "pip", "check"], logs / "dependencies-check.log", env=env)
    install_music_source(lock, args.work, root, executable, env)
    (root / "runner").mkdir()
    shutil.copy2(SCRIPT / "ai-runtime-check.py", root / "runner/check.py")
    shutil.copy2(SCRIPT / "ai-runtime.lock.json", root / "licenses/source-lock.json")
    shutil.copy2(SCRIPT / "ai-runtime-requirements.txt", root / "licenses/requirements.txt")
    shutil.copy2(logs / "packages-install.json", root / "licenses/package-install.json")
    portable.run([executable, "-I", "-B", "-m", "pip", "freeze", "--all"], root / "licenses/installed-packages.txt", env=env)
    for path in sorted(root.rglob("__pycache__"), reverse=True):
        if path.is_dir():
            shutil.rmtree(path)
    portable.flatten_links(root)
    portable.complete_windows_runtime(root, logs / "windows-native-audit.json")
    audit_macos(root, logs / "macos-native-audit.json", spec.get("minimumMacOS", "14.0"))
    if (logs / "macos-native-audit.json").is_file():
        shutil.copy2(logs / "macos-native-audit.json", root / "licenses/macos-native-audit.json")
    portable.write_json(root / "runtime-info.json", dict(schema=1, id=lock["id"], version=lock["version"],
        platform=args.platform, pythonVersion=lock["pythonVersion"], torchVersion=spec["torch"],
        musicSource=lock["musicSource"], modelWeightsIncluded=False, sourceCommit=os.environ.get("GITHUB_SHA"),
        createdAt=dt.datetime.now(dt.timezone.utc).isoformat()))
    initial = check(root, spec, args.output / "validation/original.log", require_gpu=args.require_gpu)
    print("::notice title=AI runtime probe::" + json.dumps(initial), flush=True)
    archive = args.output / f"ai-runtime-v1-{args.platform}.zip"
    metadata = package(root, archive, spec, args.platform)
    portable.verify_archive_payload(archive, metadata)
    moved = args.work / "移动验证 中文 空格/runtime"
    moved.parent.mkdir(parents=True)
    shutil.move(str(root), str(moved))
    portable.verify_tree(moved, metadata)
    second = check(moved, spec, args.output / "validation/relocated-offline.log", require_gpu=args.require_gpu)
    integrity = portable.verify_tree(moved, metadata)
    metadata.update(id=lock["id"], version=lock["version"], validated=True, sourceCommit=os.environ.get("GITHUB_SHA"),
                    validation=dict(imports=True, cpuCompute=True, gpuCompute=second["gpuCompute"],
                                    devices=second["devices"], cudaVersion=second["cudaVersion"], offline=True,
                                    actualModelGeneration="not-run", postInferenceIntegrity=integrity),
                    url=f"https://github.com/ecojust/open-media/releases/download/{lock['releaseTag']}/" + archive.name)
    if metadata["size"] > portable.RELEASE_PART_BYTES:
        metadata = portable.split_archive(archive, metadata, lock["releaseTag"])
        archive.unlink()
    portable.write_json(args.output / "runtime-metadata.json", metadata)
    portable.write_json(args.output / "validation.json", dict(schema=1, original=initial, relocatedOffline=second, integrity=integrity))
    checksums = [(part["sha256"], part["filename"]) for part in metadata.get("parts", [])] or [(metadata["sha256"], metadata["filename"])]
    (args.output / "SHA256SUMS.txt").write_text("".join(f"{digest}  {name}\n" for digest, name in checksums))
    print(json.dumps(metadata, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        detail = re.sub(r"(https?://[^\s?]+)\?[^\s]+", r"\1?[redacted]", str(error))
        detail = detail.replace("%", "%25").replace("\r", "%0D").replace("\n", "%0A")
        print(f"::error title=AI runtime::{detail}", flush=True)
        raise
