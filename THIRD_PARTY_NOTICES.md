# Third-party notices

Open Media's original application code is licensed under MIT; see [LICENSE](LICENSE). The application starts the bundled media executables as separate processes. Their licenses are independent of the application's own license.

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

## Application dependencies

| Component | License | Copyright / attribution |
| --- | --- | --- |
| Vue | MIT | Copyright (c) 2018-present, Yuxi (Evan) You |
| fflate | MIT | Copyright (c) 2026 Arjun Barrett |
| Tauri and its API | MIT OR Apache-2.0 | Copyright (c) 2017 - Present Tauri Apps Contributors |
| serde, serde_json | MIT OR Apache-2.0 | Original upstream license texts retained in `licenses/application/` |
| tempfile | MIT OR Apache-2.0 | Copyright (c) 2015 Steven Allen |
| getrandom | MIT OR Apache-2.0 | Copyright (c) 2018-2026 The rust-random Project Developers; Copyright (c) 2014 The Rust Project Developers |

The exact dependency graph and versions are retained in `package-lock.json` and `src-tauri/Cargo.lock`. Build-only dependencies are not the media execution toolchain. All applicable upstream notices and licenses remain available in their source distributions. The MIT and Apache license texts for directly bundled application dependencies are retained under `licenses/application/`.

Required dependency names, file-format names, copyright statements, and licensing references are preserved for accurate attribution.
