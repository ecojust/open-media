#!/usr/bin/env python3
"""Application-owned voice selection over the verified offline runtime.

The installed runtime and model package remain immutable. The desktop process
copies this entry point and its own reference audio into a private job directory;
the existing runtime still validates its original configuration before selecting
one of the two additional voices below.
"""

from __future__ import annotations

import argparse
import importlib.util
import math
import os
from pathlib import Path
import sys


VOICE_ENGINES = {"f5_zh_male": "f5", "qwen3_uncle_fu": "qwen3"}
REFERENCE_AUDIO = "__open_media_male_reference_audio__"
REFERENCE_TEXT = "__open_media_male_reference_text__"


def regular_file(path: Path) -> Path:
    if path.is_symlink() or not path.is_file():
        raise ValueError("Voice resource must be a regular file")
    return path.resolve(strict=True)


def job_file(job: Path, name: str) -> Path:
    path = regular_file(job / name)
    if path.parent != job:
        raise ValueError("Voice reference must remain in the current job directory")
    return path


def bind_voice(runtime, voice: str, config_path: Path, job: Path) -> None:
    if voice not in VOICE_ENGINES:
        raise ValueError("Unsupported application voice")
    original_load_config = runtime.load_config
    original_local_path = runtime.local_path
    expected_config = regular_file(config_path)
    config, model_root = original_load_config(expected_config)
    if config["engine"] != VOICE_ENGINES[voice]:
        raise ValueError("Voice does not match the selected model")
    model_root = model_root.resolve(strict=True)
    if job.is_relative_to(model_root):
        raise ValueError("Voice job cannot modify the installed model")
    selected = dict(config)
    references = {}
    if voice == "qwen3_uncle_fu":
        selected["speaker"] = "Uncle_Fu"
    else:
        references = {
            REFERENCE_AUDIO: job_file(job, "male-reference.wav"),
            REFERENCE_TEXT: job_file(job, "male-reference.txt"),
        }
        if references[REFERENCE_AUDIO].stat().st_size > 2 * 1024 * 1024:
            raise ValueError("Voice reference audio exceeds the supported size")
        if references[REFERENCE_TEXT].stat().st_size > 4096:
            raise ValueError("Voice reference text exceeds the supported size")
        selected["referenceAudio"] = REFERENCE_AUDIO
        selected["referenceText"] = REFERENCE_TEXT

    def selected_config(path: Path):
        if regular_file(path) != expected_config:
            raise ValueError("Voice configuration changed during generation")
        return dict(selected), model_root

    def selected_path(root: Path, value: str, *, directory: bool = False):
        if value in references:
            if directory or root.resolve(strict=True) != model_root:
                raise ValueError("Invalid voice reference request")
            # This narrow exception never permits arbitrary absolute or parent
            # paths: only the two application-owned files in this job qualify.
            path = regular_file(references[value])
            if path.parent != job:
                raise ValueError("Voice reference left its job directory")
            return path
        return original_local_path(root, value, directory=directory)

    runtime.load_config = selected_config
    runtime.local_path = selected_path


def load_runtime(path: Path, job: Path):
    source = regular_file(path)
    if source.is_relative_to(job):
        raise ValueError("The verified runtime cannot be loaded from a voice job")
    spec = importlib.util.spec_from_file_location("open_media_verified_speech", source)
    if spec is None or spec.loader is None:
        raise ValueError("The verified speech runtime is unavailable")
    runtime = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(runtime)
    return runtime


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--runtime-script", type=Path, required=True)
    parser.add_argument("--voice", choices=tuple(VOICE_ENGINES), required=True)
    parser.add_argument("--config", type=Path, required=True)
    parser.add_argument("--text-file", type=Path, required=True)
    parser.add_argument("--output-filename", type=Path, required=True)
    parser.add_argument("--speed", type=float, default=1)
    parser.add_argument("--threads", type=int, default=min(4, os.cpu_count() or 1))
    args = parser.parse_args()
    if not 1 <= args.threads <= 32 or not math.isfinite(args.speed) or not 0.5 <= args.speed <= 2:
        parser.error("Supported threads: 1..32; speed: 0.5..2")
    job = Path(__file__).resolve(strict=True).parent
    if regular_file(args.text_file).parent != job or args.output_filename.parent.resolve(strict=True) != job:
        raise ValueError("Voice input and output must remain in the current job directory")
    if args.output_filename.is_symlink():
        raise ValueError("Voice output cannot be a symbolic link")
    runtime = load_runtime(args.runtime_script, job)
    if job.is_relative_to(runtime.ROOT.parent.resolve(strict=True)):
        raise ValueError("Voice job cannot modify the installed runtime")
    bind_voice(runtime, args.voice, args.config, job)
    args.self_test = False
    args.engine = VOICE_ENGINES[args.voice]
    with runtime.invocation_cache(args.output_filename) as cache:
        runtime.configure_process(args.threads, cache)
        runtime.run(args)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(f"Speech voice failed: {type(error).__name__}: {error}", file=sys.stderr, flush=True)
        sys.exit(1)
