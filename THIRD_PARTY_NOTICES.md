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

The installation's `media/licenses` directory includes upstream license, copyright, author, and patent notices. The complete corresponding source archive provided beside every installer contains **all** of the above source archives, including their original notices, plus this project's exact build scripts and instructions. See [docs/MEDIA_RUNTIME.md](docs/MEDIA_RUNTIME.md). The application source archive alone is not a replacement for this media source archive.

## Bundled speech runtime

The independent `open-media-speech` executable uses the fixed speech runtime and model archives recorded in [scripts/speech-runtime.lock.json](scripts/speech-runtime.lock.json). The combined executable and its runtime are distributed under **GPL-3.0-or-later**; original component licenses remain applicable and are preserved. The model is distributed under Apache-2.0.

The runtime includes sherpa-onnx, ONNX Runtime, eSpeak NG and their exact transitive dependencies. Original licenses, copyrights and notices are retained in `speech/licenses` in each installer; the source inventory and build instructions are included in `open-media-speech-source.tar.gz` beside every release. That archive includes the original pinned sources, model and runtime archives, the independent runner source, its build scripts and source lock. It is required in addition to the separate media source archive.

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

The exact dependency graph and versions are retained in `package-lock.json` and `src-tauri/Cargo.lock`. The installation's `licenses/application/cargo/manifest.json` inventories every locked registry package, including indirect, build-only and platform-specific dependencies. Original license, copyright and notice texts are retained alongside it, with exact source archive checksums and upstream provenance for notices omitted from published packages. Each package entry provides a source URL for the listed version.

The `licenses/application/frontend/manifest.json` inventory records the dependencies actually emitted into the production browser bundle and its direct entry point. It retains or references identical original notices, including the original 0BSD copyright and permission notice for the embedded helper code. Duplicate license texts are shared without changing their contents. Required copyright notices and the full license texts are included in the installation's `licenses/application/` directory.

Required dependency names, file-format names, copyright statements, and licensing references are preserved for accurate attribution.
