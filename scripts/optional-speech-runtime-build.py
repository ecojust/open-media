#!/usr/bin/env python3
"""Build and validate a relocatable, separately downloaded CPU speech runtime.

This builds runtime components only. It never builds or publishes the application.
Model weights are temporary test inputs and are never included in the runtime ZIP.
"""
from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import platform
import shutil
import stat
import subprocess
import sys
import tarfile
import time
import urllib.parse
import urllib.request
import zipfile

REPO = Path(__file__).resolve().parent.parent
SCRIPT = REPO / "scripts"
MODEL_IDS = ("f5-v1-base-fp32", "qwen3-tts-1.7b-serena")
SMOKE_TEXT = "这是一款全程由AI接管并生成的软件。"
MAX_ARCHIVE_BYTES = 5 * 1024**3


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        while data := stream.read(4 * 1024**2):
            digest.update(data)
    return digest.hexdigest()


def write_json(path: Path, value) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def relative(value: str) -> Path:
    path = PurePosixPath(value)
    if not value or path.is_absolute() or "\\" in value or any(part in ("..", ".", "") for part in value.split("/")):
        raise ValueError(f"Unsafe relative path: {value!r}")
    if any(":" in part or "\x00" in part for part in path.parts):
        raise ValueError(f"Unsafe relative path: {value!r}")
    return Path(*path.parts)


def checked_file(path: Path, size: int, digest: str) -> bool:
    return path.is_file() and path.stat().st_size == size and sha256(path) == digest


def download(spec: dict, destination: Path) -> None:
    size, digest, url = int(spec["size"]), spec["sha256"], spec["url"]
    if size <= 0 or size > MAX_ARCHIVE_BYTES or len(digest) != 64 or urllib.parse.urlparse(url).scheme != "https":
        raise ValueError(f"Invalid download record for {destination.name}")
    if checked_file(destination, size, digest):
        return
    destination.parent.mkdir(parents=True, exist_ok=True)
    part = destination.with_name(destination.name + ".part")
    for attempt in range(3):
        try:
            print(f"Downloading {destination.name}: {size:,} bytes", flush=True)
            with urllib.request.urlopen(url, timeout=120) as response, part.open("wb") as out:
                total = 0
                while chunk := response.read(4 * 1024**2):
                    total += len(chunk)
                    if total > size:
                        raise ValueError("Download exceeded the locked size")
                    out.write(chunk)
            if not checked_file(part, size, digest):
                raise ValueError(f"Download size or SHA-256 mismatch: {destination.name}")
            part.replace(destination)
            return
        except Exception:
            part.unlink(missing_ok=True)
            if attempt == 2:
                raise
            time.sleep(2)


def unpack_python(archive: Path, destination: Path) -> None:
    """Read only regular files/directories and resolve bounded internal links."""
    links = []
    seen = set()
    total = 0
    with tarfile.open(archive, "r:gz") as source:
        for member in source:
            name = member.name.rstrip("/")
            path = relative(name)
            if not path.parts or path.parts[0] != "python" or name in seen:
                raise ValueError(f"Unexpected interpreter archive member: {name}")
            seen.add(name)
            target = destination / path
            if member.isdir():
                target.mkdir(parents=True, exist_ok=True)
            elif member.isfile():
                total += member.size
                if total > MAX_ARCHIVE_BYTES:
                    raise ValueError("Interpreter archive exceeds extraction limit")
                target.parent.mkdir(parents=True, exist_ok=True)
                with source.extractfile(member) as src, target.open("wb") as dst:
                    shutil.copyfileobj(src, dst)
                target.chmod(0o755 if member.mode & 0o111 else 0o644)
            elif member.issym() or member.islnk():
                links.append((target, member.linkname, member.issym(), member.mode))
            else:
                raise ValueError(f"Unsupported interpreter archive entry: {name}")
    # These are copied, not installed as symlinks, so the final archive is portable.
    for _ in range(len(links) + 1):
        unresolved = []
        for target, link, symbolic, mode in links:
            resolved = ((target.parent if symbolic else destination) / link).resolve()
            if not resolved.is_relative_to(destination.resolve()):
                raise ValueError("Interpreter link escapes its runtime directory")
            if not resolved.exists():
                unresolved.append((target, link, symbolic, mode))
                continue
            target.parent.mkdir(parents=True, exist_ok=True)
            if resolved.is_dir():
                shutil.copytree(resolved, target, symlinks=False)
            elif resolved.is_file():
                shutil.copy2(resolved, target)
                if mode & 0o111:
                    target.chmod(0o755)
            else:
                raise ValueError("Invalid interpreter link target")
        links = unresolved
        if not links:
            return
    raise ValueError("Unresolved interpreter archive links")


def run(command: list[str | Path], log: Path, *, env=None, timeout=3600, cwd=None) -> None:
    log.parent.mkdir(parents=True, exist_ok=True)
    print("Running:", " ".join(str(x) for x in command), flush=True)
    with log.open("w", encoding="utf-8") as output:
        result = subprocess.run([str(x) for x in command], stdout=output, stderr=subprocess.STDOUT,
                                cwd=cwd, env=env, timeout=timeout)
    if result.returncode:
        print(log.read_text(encoding="utf-8", errors="replace")[-18000:], flush=True)
        raise RuntimeError(f"Command failed with exit {result.returncode}; see {log}")


def clean_environment() -> dict:
    env = os.environ.copy()
    for key in ("PYTHONHOME", "PYTHONPATH", "VIRTUAL_ENV", "CONDA_PREFIX", "HF_TOKEN", "HUGGING_FACE_HUB_TOKEN"):
        env.pop(key, None)
    env.update(PYTHONNOUSERSITE="1", PYTHONDONTWRITEBYTECODE="1", PIP_DISABLE_PIP_VERSION_CHECK="1",
               PIP_NO_CACHE_DIR="1", HF_HUB_DISABLE_TELEMETRY="1", TOKENIZERS_PARALLELISM="false",
               OMP_NUM_THREADS="4", MKL_NUM_THREADS="4", OPEN_MEDIA_TTS_THREADS="4")
    return env


def flatten_links(root: Path) -> None:
    for path in sorted(root.rglob("*")):
        if path.is_symlink():
            target = path.resolve(strict=True)
            if not target.is_relative_to(root.resolve()):
                raise ValueError(f"Installed package link escapes the runtime: {path}")
            path.unlink()
            if target.is_dir():
                shutil.copytree(target, path, symlinks=False)
            else:
                shutil.copy2(target, path)


def build(args, lock: dict, spec: dict, root: Path, logs: Path) -> None:
    archive = args.work / "downloads" / f"python-{args.platform}.tar.gz"
    download(spec, archive)
    unpack_python(archive, root)
    executable = root / relative(spec["executable"])
    env = clean_environment()
    run([executable, "-I", "-B", "-c", "import sys; print(sys.executable, sys.version, sys.prefix)"], logs / "python.log", env=env)
    run([executable, "-I", "-m", "pip", "install", "--no-cache-dir", "pip==25.3", "wheel==0.45.1", "setuptools==80.9.0"],
        logs / "bootstrap.log", env=env)
    run([executable, "-I", "-m", "pip", "install", "--no-cache-dir", "--no-deps",
         f"torch=={spec['torch']}", f"torchaudio=={spec['torch']}", "--index-url", spec["torchIndex"]],
        logs / "torch-install.log", env=env)
    run([executable, "-I", "-m", "pip", "install", "--no-cache-dir", "--no-deps", "--report", logs / "package-install.json",
         "--no-build-isolation", "--only-binary=:all:", "--no-binary=encodec,sox",
         "-r", SCRIPT / "optional-speech-runtime-requirements.txt"], logs / "packages-install.log", env=env)
    # qwen's browser demo dependencies are not part of its inference API.
    run([executable, "-I", "-m", "pip", "install", "--no-cache-dir", "--no-deps", "qwen-tts==0.1.1"],
        logs / "model-api-install.log", env=env)
    runner_source = SCRIPT / "optional-speech-runner"
    if not (runner_source / "tts.py").is_file():
        raise FileNotFoundError("The application speech runner has not been supplied")
    shutil.copytree(runner_source, root / "runner", ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))
    source = args.work / "f5-source"
    run(["git", "init", source], logs / "source-init.log")
    run(["git", "-C", source, "remote", "add", "origin", lock["f5Source"]["repository"]], logs / "source-remote.log")
    run(["git", "-C", source, "fetch", "--depth", "1", "origin", lock["f5Source"]["revision"]], logs / "source-fetch.log")
    run(["git", "-C", source, "checkout", "--detach", "FETCH_HEAD"], logs / "source-checkout.log")
    actual_revision = subprocess.check_output(["git", "-C", str(source), "rev-parse", "HEAD"], text=True).strip()
    if actual_revision != lock["f5Source"]["revision"]:
        raise ValueError("Inference source revision mismatch")
    shutil.copytree(source / "src/f5_tts", root / "runner/vendor/f5_tts", ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))
    (root / "licenses").mkdir(exist_ok=True)
    shutil.copy2(source / "LICENSE", root / "licenses/F5-TTS-LICENSE")
    shutil.copy2(SCRIPT / "optional-speech-runtime.lock.json", root / "licenses/runtime-source-lock.json")
    shutil.copy2(SCRIPT / "optional-speech-runtime-requirements.txt", root / "licenses/runtime-requirements.txt")
    run([executable, "-I", "-m", "pip", "freeze", "--all"], root / "licenses/installed-packages.txt", env=env)
    shutil.copy2(logs / "package-install.json", root / "licenses/package-install.json")
    for path in sorted(root.rglob("__pycache__"), reverse=True):
        if path.is_dir():
            shutil.rmtree(path)
    flatten_links(root)
    write_json(root / "runtime-info.json", {"schema": 1, "id": lock["id"], "version": lock["version"],
               "platform": args.platform, "pythonVersion": lock["pythonVersion"], "torchVersion": spec["torch"],
               "f5Source": lock["f5Source"], "qwenPackage": "qwen-tts==0.1.1", "device": "cpu",
               "f5Precision": "float32", "qwenPrecision": "bfloat16", "sourceCommit": os.environ.get("GITHUB_SHA"),
               "createdAt": dt.datetime.now(dt.timezone.utc).isoformat()})
    run([executable, "-I", "-B", root / "runner/tts.py", "--self-test"], logs / "self-test.log", env=env)


def prepare_models(args, catalog: dict) -> dict[str, Path]:
    prepared = {}
    for model_id in args.models:
        item = next((entry for entry in catalog["models"] if entry["id"] == model_id), None)
        if item is None:
            raise ValueError(f"Missing real test model {model_id}")
        directory = args.work / "models" / model_id
        directory.mkdir(parents=True, exist_ok=True)
        for file in item["files"]:
            destination = directory / relative(file["path"])
            local = SCRIPT / "optional-speech-assets" / Path(urllib.parse.unquote(urllib.parse.urlparse(file["url"]).path)).name
            if local.is_file():
                if not checked_file(local, int(file["size"]), file["sha256"]):
                    raise ValueError(f"Local release asset does not match catalog: {local.name}")
                destination.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(local, destination)
            else:
                download(file, destination)
        config = directory / relative(item["model"].get("config", "runner-config.json"))
        if not config.is_file():
            raise ValueError(f"Missing verified runner configuration for {model_id}")
        prepared[model_id] = config
    return prepared


OFFLINE_WRAPPER = r'''import runpy,socket,sys
def blocked(*args,**kwargs): raise RuntimeError("NETWORK_DISABLED_BY_RUNTIME_TEST")
socket.socket.connect=blocked
socket.socket.connect_ex=blocked
socket.create_connection=blocked
socket.getaddrinfo=blocked
sys.argv=sys.argv[1:]
runpy.run_path(sys.argv[0],run_name="__main__")
'''


def smoke(root: Path, spec: dict, models: dict[str, Path], output: Path, *, offline: bool) -> list:
    output.mkdir(parents=True, exist_ok=True)
    executable = root / relative(spec["executable"])
    text_file = output / "中文 测试文本.txt"
    text_file.write_text(SMOKE_TEXT, encoding="utf-8")
    env = clean_environment()
    env.update(HF_HUB_OFFLINE="1", TRANSFORMERS_OFFLINE="1", HF_HUB_DISABLE_XET="1")
    if offline:
        # Neither a host interpreter nor media command-line tools may satisfy imports.
        env["PATH"] = str(executable.parent) + (os.pathsep + str(Path(os.environ.get("SystemRoot", "C:/Windows")) / "System32") if os.name == "nt" else ":/usr/bin:/bin")
    results = []
    for model_id, config in models.items():
        wave = output / f"{model_id}.wav"
        command = [executable, "-I", "-B"]
        if offline:
            command += ["-c", OFFLINE_WRAPPER]
        command += [root / "runner/tts.py", "--config", config, "--text-file", text_file,
                    "--output-filename", wave, "--speed", "1"]
        began = time.monotonic()
        run(command, output / f"{model_id}.log", env=env, timeout=3600, cwd=output)
        validation_path = output / f"{model_id}.json"
        code = ("import soundfile as sf,numpy as np,json,sys; "
                "x,sr=sf.read(sys.argv[1],always_2d=True,dtype='float32'); "
                "assert sr==24000 and x.shape[1]==1; "
                "assert .3<len(x)/sr<120 and np.isfinite(x).all(); "
                "assert float(np.max(np.abs(x)))>.001 and float(np.sqrt(np.mean(x*x)))>.00001; "
                "print(json.dumps(dict(sampleRate=sr,channels=x.shape[1],sampleCount=len(x),"
                "durationSeconds=len(x)/sr,peak=float(np.max(np.abs(x))),rms=float(np.sqrt(np.mean(x*x))))))")
        run([executable, "-I", "-B", "-c", code, wave], validation_path, env=env)
        result = json.loads(validation_path.read_text(encoding="utf-8"))
        result.update(model=model_id, text=SMOKE_TEXT, sha256=sha256(wave), offlineSocketBlocked=offline,
                      seconds=time.monotonic() - began, waveform=wave.name,
                      precision="bfloat16" if "qwen3" in model_id else "float32")
        write_json(validation_path, result)
        results.append(result)
    return results


def package(root: Path, archive: Path, spec: dict, platform_id: str) -> dict:
    files = []
    for path in sorted(root.rglob("*")):
        if path.is_symlink():
            raise ValueError(f"Runtime still contains a symlink: {path}")
        if path.is_file() and path != root / "manifest.json":
            info = {"path": path.relative_to(root).as_posix(), "size": path.stat().st_size, "sha256": sha256(path)}
            if path.stat().st_mode & 0o111 or info["path"] == spec["executable"]:
                info["executable"] = True
            files.append(info)
    if not any(item["path"] == "runner/tts.py" for item in files):
        raise ValueError("Runtime runner is missing")
    write_json(root / "manifest.json", {"schema": 1, "files": files})
    archive.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(archive, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=6, allowZip64=True) as target:
        for path in sorted(root.rglob("*")):
            if path.is_file():
                target.write(path, path.relative_to(root).as_posix())
    return {"platform": platform_id, "filename": archive.name, "size": archive.stat().st_size,
            "sha256": sha256(archive), "unpackedSize": sum(item["size"] for item in files) + (root / "manifest.json").stat().st_size,
            "manifestSha256": sha256(root / "manifest.json"), "executable": spec["executable"], "script": "runner/tts.py"}


def verify_archive(archive: Path, destination: Path, metadata: dict) -> None:
    if not checked_file(archive, metadata["size"], metadata["sha256"]):
        raise ValueError("Runtime archive changed after packaging")
    with zipfile.ZipFile(archive) as source:
        names = source.namelist()
        if len(names) != len(set(names)):
            raise ValueError("Duplicate ZIP members")
        for member in source.infolist():
            if member.is_dir() or stat.S_ISLNK(member.external_attr >> 16):
                raise ValueError("Runtime ZIP must contain regular files only")
            target = destination / relative(member.filename)
            target.parent.mkdir(parents=True, exist_ok=True)
            with source.open(member) as src, target.open("wb") as dst:
                shutil.copyfileobj(src, dst)
    if sha256(destination / "manifest.json") != metadata["manifestSha256"]:
        raise ValueError("Runtime tree manifest changed")
    manifest = json.loads((destination / "manifest.json").read_text(encoding="utf-8"))
    if set(names) != {"manifest.json", *(item["path"] for item in manifest["files"])}:
        raise ValueError("Runtime ZIP file list differs from its manifest")
    for item in manifest["files"]:
        path = destination / relative(item["path"])
        if not checked_file(path, item["size"], item["sha256"]):
            raise ValueError(f"Runtime tree integrity mismatch: {item['path']}")
        path.chmod(0o755 if item.get("executable") else 0o644)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--platform", required=True, choices=("macos-arm64", "macos-x64", "windows-x64"))
    parser.add_argument("--work", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--catalog", type=Path, default=REPO / "src-tauri/resources/speech-models.json")
    parser.add_argument("--models", nargs="+", default=list(MODEL_IDS))
    parser.add_argument("--phase", choices=("build", "validate", "all"), default="all")
    args = parser.parse_args()
    args.work, args.output = args.work.resolve(), args.output.resolve()
    expected = {"macos-arm64": ("Darwin", "arm64"), "macos-x64": ("Darwin", "x86_64"), "windows-x64": ("Windows", "AMD64")}[args.platform]
    if (platform.system(), platform.machine()) != expected:
        raise ValueError(f"Build must run on its actual target platform: expected {expected}, got {(platform.system(), platform.machine())}")
    lock = json.loads((SCRIPT / "optional-speech-runtime.lock.json").read_text(encoding="utf-8"))
    spec = lock["platforms"][args.platform]
    root = args.work / "runtime"
    logs = args.output / "logs"
    args.output.mkdir(parents=True, exist_ok=True)
    if args.phase in ("build", "all"):
        if root.exists():
            raise ValueError("Build directory already exists; use a fresh work directory")
        root.mkdir(parents=True)
        build(args, lock, spec, root, logs)
    if args.phase == "build":
        return
    catalog = json.loads(args.catalog.read_text(encoding="utf-8"))
    models = prepare_models(args, catalog)
    initial = smoke(root, spec, models, args.output / "validation/original", offline=False)
    archive = args.output / f"speech-runtime-python-cpu-v1-{args.platform}.zip"
    metadata = package(root, archive, spec, args.platform)
    moved = args.work / "移动验证 中文 空格" / "runtime"
    if moved.exists():
        raise ValueError("Relocation test directory already exists")
    verify_archive(archive, moved, metadata)
    # Move model paths too; no original absolute path may be embedded in a model config.
    moved_models = args.work / "移动验证 中文 空格" / "models"
    shutil.move(str(args.work / "models"), str(moved_models))
    configs = {name: moved_models / config.relative_to(args.work / "models") for name, config in models.items()}
    second = smoke(moved, spec, configs, args.output / "validation/离线 移动", offline=True)
    metadata.update(id=lock["id"], version=lock["version"], validatedModels=list(models),
                    validated=True, sourceCommit=os.environ.get("GITHUB_SHA"),
                    url="https://github.com/ecojust/open-media/releases/download/speech-runtime-v1/" + archive.name)
    write_json(args.output / "runtime-metadata.json", metadata)
    write_json(args.output / "validation.json", {"schema": 1, "platform": args.platform, "original": initial, "relocatedOffline": second})
    (args.output / "SHA256SUMS.txt").write_text(f"{metadata['sha256']}  {archive.name}\n", encoding="utf-8")
    print(json.dumps(metadata, ensure_ascii=False, indent=2), flush=True)


if __name__ == "__main__":
    main()
