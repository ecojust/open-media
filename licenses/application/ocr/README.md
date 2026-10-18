# Bundled text recognition models

The simplified Chinese and English language models are from the pinned upstream revision listed in `manifest.json`, under Apache-2.0. Model weights are unchanged; files are stored with lossless gzip compression for local loading. The original license is included in `LICENSE`.

The recognition worker and WebAssembly core are supplied by the locked `tesseract.js` and `tesseract.js-core` dependencies. Their original notices are included in the frontend dependency inventory. Recognition uses bundled local resources and does not send images or text to an external service.
