#!/usr/bin/env python3
"""Verify built artifacts and derive the application catalog from actual bytes."""
import argparse
import hashlib
import io
import json
from pathlib import Path
import re
import zipfile


def digest(path: Path) -> str:
    value = hashlib.sha256()
    with path.open("rb") as source:
        while data := source.read(4 * 1024**2):
            value.update(data)
    return value.hexdigest()


class JoinedArchive(io.RawIOBase):
    """Read ZIP central directories across immutable parts without copying GBs."""
    def __init__(self, paths):
        super().__init__()
        self.files = [path.open("rb") for path in paths]
        self.sizes = [path.stat().st_size for path in paths]
        self.length = sum(self.sizes)
        self.position = 0

    def readable(self):
        return True

    def seekable(self):
        return True

    def tell(self):
        return self.position

    def seek(self, offset, whence=0):
        position = offset if whence == 0 else self.position + offset if whence == 1 else self.length + offset
        if position < 0:
            raise ValueError("Negative archive position")
        self.position = position
        return position

    def read(self, size=-1):
        remaining = self.length - self.position if size < 0 else min(size, self.length - self.position)
        chunks, base = [], 0
        for source, length in zip(self.files, self.sizes):
            if remaining <= 0:
                break
            if self.position >= base + length:
                base += length
                continue
            offset = self.position - base
            source.seek(offset)
            data = source.read(min(remaining, length - offset))
            if not data:
                raise ValueError("Truncated runtime part")
            chunks.append(data)
            self.position += len(data)
            remaining -= len(data)
            base += length
        return b"".join(chunks)

    def close(self):
        for source in self.files:
            source.close()
        super().close()


def validate_manifest(paths, item):
    with JoinedArchive(paths) as joined, zipfile.ZipFile(joined) as archive:
        entries = archive.infolist()
        names = [entry.filename for entry in entries]
        if len(names) != len(set(names)):
            raise ValueError("Duplicate runtime archive entry")
        info = archive.getinfo("manifest.json")
        if info.file_size > 32 * 1024**2:
            raise ValueError("Runtime manifest exceeds the safety limit")
        manifest = archive.read(info)
        if hashlib.sha256(manifest).hexdigest() != item["manifestSha256"]:
            raise ValueError("Runtime manifest differs from its validation record")
        files = json.loads(manifest)["files"]
        if set(names) != {"manifest.json", *(entry["path"] for entry in files)}:
            raise ValueError("Runtime archive and manifest file lists differ")
        for entry in files:
            name = entry["path"]
            if (name.startswith("/") or "\\" in name or any(part in ("", ".", "..") or ":" in part for part in name.split("/"))
                    or not re.fullmatch(r"[a-f0-9]{64}", entry["sha256"])
                    or archive.getinfo(name).file_size != entry["size"]):
                raise ValueError("Unsafe or inconsistent runtime manifest entry")
        if not {item["executable"], item["script"]}.issubset(names):
            raise ValueError("Runtime entry point is missing")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--commit", required=True)
    args = parser.parse_args()
    if not re.fullmatch(r"[a-f0-9]{40}", args.commit):
        raise ValueError("Expected an exact source commit")
    platforms, manifests, checksums = {}, [], []
    for platform in ("macos-arm64", "windows-x64", "linux-x64"):
        root = args.root / ("ai-runtime-v1-" + platform)
        item = json.loads((root / "runtime-metadata.json").read_text())
        if (item["id"] != "ai-generation-v1" or item["version"] != 1 or item["platform"] != platform
                or item["sourceCommit"] != args.commit or item["validated"] is not True
                or item["validation"]["imports"] is not True or item["validation"]["cpuCompute"] is not True):
            raise ValueError("Artifact has not passed the requested build validation")
        parts = item.get("parts") or [item]
        combined = hashlib.sha256()
        total = 0
        for part in parts:
            name = part["filename"]
            if Path(name).name != name or not name.startswith(f"ai-runtime-v1-{platform}.zip"):
                raise ValueError("Unexpected runtime artifact name")
            path = root / name
            if path.stat().st_size != part["size"] or digest(path) != part["sha256"]:
                raise ValueError(f"Artifact bytes differ from validation: {name}")
            with path.open("rb") as source:
                while data := source.read(4 * 1024**2):
                    combined.update(data)
                    total += len(data)
            checksums.append((part["sha256"], name))
        if total != item["size"] or combined.hexdigest() != item["sha256"]:
            raise ValueError("Split runtime combined size or checksum mismatch")
        validate_manifest([root / part["filename"] for part in parts], item)
        archive = {key: item[key] for key in ("url", "size", "unpackedSize", "sha256", "manifestSha256", "executable", "script")}
        if item.get("parts"):
            archive["parts"] = [{key: part[key] for key in ("url", "size", "sha256")} for part in item["parts"]]
        platforms[platform] = archive
        manifests.append(item)
    catalog = dict(schemaVersion=1, runtimes=[dict(id="ai-generation-v1", version=1, platforms=platforms)])
    (args.root / "ai-runtime-models.json").write_text(json.dumps(catalog, ensure_ascii=False, indent=2) + "\n")
    (args.root / "runtime-metadata.json").write_text(json.dumps(manifests, ensure_ascii=False, indent=2) + "\n")
    (args.root / "SHA256SUMS.txt").write_text("".join(f"{value}  {name}\n" for value, name in checksums))
    (args.root / "notes.md").write_text(
        "这是图像与歌曲生成的独立运行组件，供应用按需下载，不是应用安装包，也不包含模型权重。\n\n"
        "提供三个桌面平台的运行环境，已验证导入、基础计算、完整性、中文路径和禁止联网时的运行。"
        "硬件加速以验证记录中实际检测到的设备为准，尚未进行完整模型生成和效果评估。\n\n"
        "新组件独立安装，不覆盖已有配音运行环境。\n", encoding="utf-8")
    print(json.dumps(catalog, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
