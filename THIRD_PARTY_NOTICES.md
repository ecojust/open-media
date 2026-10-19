# Third-party notices

Open Media's main application code is licensed under MIT; see [LICENSE](LICENSE). The application starts the bundled media, speech and recognition executables as separate processes. Their licenses are independent of the main application's license. The independent speech and recognition runner sources explicitly use GPL-3.0-or-later.

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
| base64 | MIT OR Apache-2.0 | Original upstream notices for the locked 0.22.1 archive are retained in `licenses/application/cargo/` |

The exact dependency graph and versions are retained in `package-lock.json` and `src-tauri/Cargo.lock`. The installation's `licenses/application/cargo/manifest.json` inventories every locked registry package, including indirect, build-only and platform-specific dependencies. Original license, copyright and notice texts are retained alongside it, with exact source archive checksums and upstream provenance for notices omitted from published packages. Each package entry provides a source URL for the listed version.

The `licenses/application/frontend/manifest.json` inventory records the dependencies actually emitted into the production browser bundle and its direct entry point. It retains or references identical original notices, including the original 0BSD copyright and permission notice for the embedded helper code. Duplicate license texts are shared without changing their contents. Required copyright notices and the full license texts are included in the installation's `licenses/application/` directory.

Required dependency names, file-format names, copyright statements, and licensing references are preserved for accurate attribution.

## Optional local video generation

On Apple Silicon, the isolated video generation executable is built from the
vendored `antirez/h3.c` source at commit
`8974cc055ea9c02fcd14cc27dfda3e1027c05153`. The engine is MIT licensed,
copyright (c) 2026 Salvatore Sanfilippo. Its shader implementation contains
adaptations of ccv kernels under BSD-3-Clause, copyright (c) 2010 Liu Liu.
The original, unmodified source, original license and third-party notice texts,
and per-file source digests are retained in
`src-tauri/native/video-generation/upstream/` and `licenses/video-generation/h3/`.
Open Media's separate request/progress adapter is licensed under the main
application's MIT license. It launches the existing bundled media executable
through its documented process interface; it does not link that executable.

Model weights are **not** covered by the engine's MIT license and are not
included in the installer. The optional MiniMax H3 checkpoint is pinned to
`MiniMaxAI/MiniMax-H3` revision
`42ed227ee7df40d41602854ae760620d6eb651fe`; file paths, sizes, SHA-256 digests,
and official/mirror URLs are locked in
`src-tauri/resources/video-generation-models.json`. Model repository Python
code is not downloaded or executed. Identical encoder and decoder files are
reused across model modes without modifying the weights.

The complete MiniMax H3 Community License Agreement, required NOTICE and
the encoder's Apache-2.0 license are retained in
`licenses/video-generation/MiniMax-H3/`. This community license excludes the
European Union, United Kingdom, Republic of Korea and United States of America
from its applicable territory, and includes separate commercial terms and use
restrictions. Commercial interfaces using the model must prominently display
“MiniMax H3”. Users must confirm that their use is covered by the model license
before downloading it. The MIT engine license grants no rights to model
weights or to uses outside that model license.

## Bundled image text recognition

Offline recognition uses `tesseract.js` 7.0.0 and `tesseract.js-core` 7.0.0 under Apache-2.0. The worker, WebAssembly code and simplified Chinese/English language models are included locally. Images and recognized text are not sent to a remote recognition service.

The precompiled worker contains nine separately attributed packages: bmp-js 0.1.0, idb-keyval 6.2.1, is-url 1.2.4, regenerator-runtime 0.13.11, wasm-feature-detect 1.8.0, zlibjs 0.3.1, buffer 6.0.3, base64-js 1.5.1 and ieee754 1.2.1. Their licenses are MIT, Apache-2.0 or BSD-3-Clause as recorded per package. Exact versions were checked against the worker's source map, original archive bytes and its publisher's pinned dependency lock; they can differ from installed dependencies that are not emitted into the application. Full original copyrights and permissions are in `licenses/application/frontend/ocr-worker/`.

The WebAssembly core includes Tesseract, Leptonica, GIF, JPEG, PNG, TIFF and WebP libraries, zlib, OpenLibm and compiler runtime code. Their original license, author and patent notices, fixed upstream revisions and source URLs are recorded in `licenses/application/frontend/manifest.json` and retained in `licenses/application/frontend/ocr-native/`. This software is based in part on the work of the Independent JPEG Group. The compiler runtime notices include Emscripten, musl, libc++ and libc++abi; OpenLibm's original notice also identifies licenses of test sources that are not part of the runtime.

The two language models come from `tesseract-ocr/tessdata_fast` at revision `87416418657359cb625c412a48b6e1d6d41c29bd`, under Apache-2.0. Lossless gzip packaging leaves their weights unchanged. The original license, compressed file hashes and original model hashes are retained in `licenses/application/ocr/`.

## Optional offline speech recognition

The Whisper Small INT8 attention model is downloaded only on request. Original Whisper model weights are licensed under MIT, copyright (c) 2022 OpenAI. The converted distribution is published by `clairemcw/sherpa-onnx-whisper-small-attention` at revision `9a896a02c311676d366ebfda3797753df4153fe2`; the converter is not the original model author. That distribution provides no additional license statement, so the original model license and this provenance are preserved in `licenses/audio-asr/` and included in the installed speech runtime notices.

The three model files total 375,744,699 bytes and are verified against fixed hashes in `scripts/audio-asr-models.lock.json`. Model weights are not bundled with the installer, and model repository code is not executed. The independent `open-media-asr` helper uses the existing bundled speech runtime libraries, is licensed under GPL-3.0-or-later, and its source and build instructions are included in the corresponding speech source archive. Audio is processed locally.

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

## Optional local image and music generation

Qwen-Image and Z-Image-Turbo model weights are downloaded only on explicit
request. Both model distributions use Apache-2.0; their unmodified licenses,
model cards, fixed revisions and source digests are retained in
`licenses/ai-generation/image/`. The exact model files, byte sizes, SHA-256
hashes and download URLs are pinned in
`src-tauri/resources/ai-image-models.json`. Model repository code is not
executed. Image-to-image support uses local diffusion repainting.

ACE-Step 1.5 Turbo and SFT weights and implementation are MIT licensed. Their
shared text encoder retains its Apache-2.0 license. Original notices and
source provenance are in `licenses/ai-generation/music/`; the exact optional
weight inventory is pinned in `src-tauri/resources/ai-music-models.json`.
Only the declared local generation components are used; no additional lyric
language model is downloaded implicitly.

These capabilities use a separately downloaded, isolated Python runtime.
The fixed build inputs are recorded in `scripts/ai-runtime.lock.json` and
`scripts/ai-runtime-requirements.txt`. Each platform package retains the
original runtime, installed package and native library notices, and a
per-file verification manifest. Runtime archive URLs and checksums are
recorded in `src-tauri/resources/ai-runtime-models.json`. This environment
is separate from the existing speech runtime and does not modify the user's
Python installation. All generated image and audio data is processed locally.
