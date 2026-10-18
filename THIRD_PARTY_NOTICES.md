# Third-party notices

Open Media's main application code is licensed under MIT; see [LICENSE](LICENSE). The application starts the bundled media and speech executables as separate processes. Their licenses are independent of the main application's license. The independent speech runner source explicitly uses GPL-3.0-or-later.

## Bundled media executables

The bundled `ffmpeg` and `ffprobe` are built from the exact source archives and SHA-256 checksums in [scripts/media-runtime.lock.json](scripts/media-runtime.lock.json). GPL features are enabled, and the resulting media executables are distributed under **GPL-2.0-or-later**. No proprietary modifications are made to these sources.

| Component | Version | License | Upstream |
| --- | --- | --- | --- |
| FFmpeg | 8.0.1 | GPL-2.0-or-later in this build | https://ffmpeg.org/ |
| x264 | 31e19f92f00c7003fa115047ce50978bc98c3a0d | GPL-2.0-or-later | https://www.videolan.org/developers/x264.html |
| libvpx | 1.15.0 | BSD-3-Clause and patent grant | https://www.webmproject.org/ |
| Opus | 1.5.2 | BSD-3-Clause and patent notices | https://opus-codec.org/ |
| libwebp | 1.5.0 | BSD-3-Clause and patent grant | https://developers.google.com/speed/webp |
| LAME | 3.100 | LGPL-2.0-or-later | https://lame.sourceforge.io/ |
| zlib | 1.3.1 | Zlib | https://zlib.net/ |
| nv-codec-headers (Windows interface headers) | 12.1.14.0, commit 1889e62e2d35ff7aa9baca2bceb14f053785e6f1 | MIT; original notices retained in each header | https://github.com/FFmpeg/nv-codec-headers |
| AMF (Windows interface headers) | 1.4.36, commit 16f7d73e0b45c473e903e46981ed0b91efc4c091 | MIT and original standards/patent notice | https://github.com/GPUOpen-LibrariesAndSDKs/AMF |

The installation's `media/licenses` directory includes upstream license, copyright, author, and patent notices. The complete corresponding source archive provided beside every installer contains **all** of the above source archives, including their original notices, plus this project's exact build scripts and instructions. See [docs/MEDIA_RUNTIME.md](docs/MEDIA_RUNTIME.md). The application source archive alone is not a replacement for this media source archive.

## Bundled speech runtime

The independent `open-media-speech` executable uses the fixed speech runtime and model archives recorded in [scripts/speech-runtime.lock.json](scripts/speech-runtime.lock.json). The combined executable and its runtime are distributed under **GPL-3.0-or-later**; original component licenses remain applicable and are preserved. The single-speaker Matcha Chinese/English acoustic model and its Vocos 16 kHz vocoder weights are distributed under Apache-2.0 as declared by their publisher, `dengcunqin/matcha_tts_zh_en_20251010`. The original publisher metadata and file hashes are retained in the license inventory; upstream Matcha-TTS and Vocos implementation MIT notices are also preserved. Implementation licensing does not substitute for the model publisher’s weight license.

The runtime includes sherpa-onnx, ONNX Runtime, eSpeak NG and their exact transitive dependencies. Original licenses, copyrights and notices are retained in `speech/licenses` in each installer; the source inventory and build instructions are included in `open-media-speech-source.tar.gz` beside every release. That archive includes the original pinned sources, acoustic model and runtime archives, vocoder model file, the independent runner source, its build scripts and source lock. It is required in addition to the separate media source archive.

See [docs/SPEECH_RUNTIME.md](docs/SPEECH_RUNTIME.md) and [licenses/speech-runtime/README.md](licenses/speech-runtime/README.md) for exact versions, license texts and source provenance. No text is sent to a remote synthesis service.

## Application dependencies

| Component | License | Copyright / attribution |
| --- | --- | --- |
| Vue | MIT | Copyright (c) 2018-present, Yuxi (Evan) You |
| fflate | MIT | Copyright (c) 2026 Arjun Barrett |
| Tauri and its API | MIT OR Apache-2.0 | Copyright (c) 2017 - Present Tauri Apps Contributors |
| serde, serde_json | MIT OR Apache-2.0 | Original upstream license texts retained in `licenses/application/` |
| tempfile | MIT OR Apache-2.0 | Copyright (c) 2015 Steven Allen |
| getrandom | MIT OR Apache-2.0 | Copyright (c) 2018-2026 The rust-random Project Developers; Copyright (c) 2014 The Rust Project Developers |
| arboard | MIT OR Apache-2.0 | Copyright 2022 The Arboard contributors; original notices and image clipboard dependencies retained in `licenses/application/cargo/` |

The exact dependency graph and versions are retained in `package-lock.json` and `src-tauri/Cargo.lock`. The installation's `licenses/application/cargo/manifest.json` inventories every locked registry package, including indirect, build-only and platform-specific dependencies. Original license, copyright and notice texts are retained alongside it, with exact source archive checksums and upstream provenance for notices omitted from published packages. Each package entry provides a source URL for the listed version.

The `licenses/application/frontend/manifest.json` inventory records the dependencies actually emitted into the production browser bundle and its direct entry point. It retains or references identical original notices, including the original 0BSD copyright and permission notice for the embedded helper code. Duplicate license texts are shared without changing their contents. Required copyright notices and the full license texts are included in the installation's `licenses/application/` directory.

Required dependency names, file-format names, copyright statements, and licensing references are preserved for accurate attribution.

## Optional offline voices

Three optional Chinese voice packages are downloaded only on explicit request. Their model weights, implementation code, vocoders and execution dependencies have separate licenses:

| Model / voice | Model weights | Implementation |
| --- | --- | --- |
| ZipVoice Distill FP32 | CC-BY-NC, as stated by the model publisher; no specific version stated | Apache-2.0 |
| F5-TTS v1 Base FP32 | CC-BY-NC-4.0 | MIT |
| Qwen3-TTS 1.7B BF16 · Serena | Apache-2.0 | Apache-2.0 |

The first two model weight licenses restrict commercial use; the voice cards display that restriction. Original publisher notices, model metadata, vocoder notices, fixed sources and file hashes are preserved in `licenses/application/optional-speech/`. The exact model and platform runtime download inventory is pinned in `src-tauri/resources/speech-models.json`. Installed shared execution dependencies are reused. A model is available for synthesis only after both its files and the current platform's execution dependencies have been verified. User text is processed locally and is not sent to a remote synthesis service.

The native Chinese number normalization compatibility implementation follows cn2an 0.5.23 behavior. Its original MIT copyright and license, wheel provenance, upstream source digests and the independent 1,538-case normalization fixture provenance are retained in `licenses/application/optional-speech/cn2an/`. The complete expected input/output fixtures are available in `tests/fixtures/speech-chinese-normalizer.tsv`.

Three fixed audition recordings are copied byte-for-byte from the corresponding published Chinese benchmark samples; their settings, reference audio, hashes and model attribution are recorded in `src/assets/voice-previews/optional-manifest.json`. Historical notices retained under `licenses/application/optional-speech/legacy-multivoice/` apply only to earlier generated material and preserved research samples, not to currently offered download voices.

## Bundled background music

Ten distinct instrumental selections are bundled for offline preview and use in video projects. All ten original works are published under **CC0 1.0 Universal**. The original authors, track titles, publication pages, download URLs, SHA-256 hashes, and excerpt/encoding changes are recorded in [licenses/application/background-music/manifest.json](licenses/application/background-music/manifest.json). The complete legal text and original publication pages carrying each license declaration are preserved alongside that inventory and included with the application notices.

Chinese display titles describe the selected excerpts; the original creators retain their credited authorship. These CC0 selections may be used in exported projects without a mandatory attribution requirement.
