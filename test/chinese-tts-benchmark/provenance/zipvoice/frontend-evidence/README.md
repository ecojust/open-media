# 前端实现证据

`sherpa-onnx` 部分文件逐字提取自固定 1.13.8 源码归档，来源 https://github.com/k2-fsa/sherpa-onnx/tree/v1.13.8 。`offline-tts.cc` 注册了通用 `tts-rule-fsts`，但 `offline-tts-zipvoice-impl.h` 未读取该字段，而是直接把文本交给 `MatchaTtsLexicon`。对比 `offline-tts-matcha-impl.h` 可见后者会加载并应用 FST。

原 ZipVoice 的 `tokenize_ZH` 调用 `ChineseTextNormalizer`，其实现为 `cn2an.transform(text, "an2cn")`。正式采用的源码均在 `official-normalizer/`，以 `source.json` 中固定提交和 SHA256 为准。顶层 `ZIPVOICE_*` 文件为最初调查快照，不作为正式固定版本的替代。

正式试听没有手改语料：原文在清单的 `text`，实际推理输入在 `normalized_text`。只有第09条发生改变并重新生成；另9条保留相同输入/模型/配置对应的真实音频，复用来源和原始生成时间与耗时可在清单核对。
