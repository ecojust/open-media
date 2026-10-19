#!/usr/bin/env python3
"""Verify built artifacts and derive the application catalog from actual bytes."""
import argparse
import hashlib
import json
from pathlib import Path
import re


def digest(path: Path) -> str:
    value = hashlib.sha256()
    with path.open("rb") as source:
        while data := source.read(4 * 1024**2):
            value.update(data)
    return value.hexdigest()


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
