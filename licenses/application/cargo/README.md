This directory retains the original license, copyright and notice texts for every registry package listed in `src-tauri/Cargo.lock`. The inventory also includes build-only and platform-specific packages that may be absent from a particular installer.

`manifest.json` records each exact package version, its source archive URL and locked SHA-256, the original path of each notice, and the SHA-256 of the retained text. Identical original texts share one file. A few entries reuse an identical text in the parent directory.

For published package archives that omit their notices, the manifest identifies the original upstream sources used to supplement them. Their provenance notes distinguish exact package commits, verified matching source trees, upstream license declarations and unmodified standard license texts. No copyright author or year has been invented to fill a license template.

The source URL recorded for each package provides its original source code at the listed version, including any files covered by source-availability licenses. Original media-tool sources are distributed separately beside the installers as described in `THIRD_PARTY_NOTICES.md`.
