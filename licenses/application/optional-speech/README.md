# 可选离线声音版权与来源

此目录随应用安装，记录当前三个可下载模型及固定试听的原始许可和来源。模型权重与推理组件分别遵循各自许可证，不将实现代码的许可当作模型权重的许可。

| 模型 | 权重许可 | 推理实现许可 |
| --- | --- | --- |
| ZipVoice Distill FP32 | CC-BY-NC（上游未注明具体版本） | Apache-2.0 |
| F5-TTS v1 Base FP32 | CC-BY-NC-4.0 | MIT |
| Qwen3-TTS 1.7B BF16 · Serena | Apache-2.0 | Apache-2.0 |

前两种模型的权重许可包含非商业限制，声音卡片会显示用途提示。Vocos 声码器原始许可另外保留，平台运行包的依赖清单随对应包提供。模型与运行组件的固定文件、字节数及 SHA-256 以应用资源清单为准。

`manifest.json` 逐个记录文件的来源与 SHA-256，三个模型子目录中的上游文本未经改写。`cn2an/` 保留 0.5.23 原始 MIT 许可证、固定 wheel 来源、中文数字规范化对照资料的生成方式及 1,538 条样例摘要；完整对照输入与预期输出在仓库 `tests/fixtures/speech-chinese-normalizer.tsv`。

固定试听对应正式中文对比语料的第 01 段，来源、模型设置与音频摘要记录在 `src/assets/voice-previews/optional-manifest.json`，原始结果位于 `test/chinese-tts-benchmark/`。

`legacy-multivoice/` 仅保留早期生成资料及历史试听所需的原始版权声明；其中声音不再出现在当前下载目录。已有项目中的生成音频继续保留。
