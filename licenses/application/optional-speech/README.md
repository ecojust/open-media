# 可选离线声音版权与来源

此目录随应用安装，记录当前三个可下载模型及固定试听的原始许可和来源。模型权重与推理组件分别遵循各自许可证，不将实现代码的许可当作模型权重的许可。

| 模型 | 权重许可 | 推理实现许可 |
| --- | --- | --- |
| ZipVoice Distill FP32 | CC-BY-NC（上游未注明具体版本） | Apache-2.0 |
| F5-TTS v1 Base FP32 | CC-BY-NC-4.0 | MIT |
| Qwen3-TTS 1.7B BF16 | Apache-2.0 | Apache-2.0 |

前两种模型的权重许可包含非商业限制，声音卡片会显示用途提示。Vocos 声码器原始许可另外保留，平台运行包的依赖清单随对应包提供。模型与运行组件的固定文件、字节数及 SHA-256 以应用资源清单为准。

`manifest.json` 逐个记录文件的来源与 SHA-256，三个模型子目录中的上游文本未经改写。`cn2an/` 保留 0.5.23 原始 MIT 许可证、固定 wheel 来源、中文数字规范化对照资料的生成方式及 1,538 条样例摘要；完整对照输入与预期输出在仓库 `tests/fixtures/speech-chinese-normalizer.tsv`。

固定试听对应正式中文对比语料的第 01 段，来源、模型设置与音频摘要记录在 `src/assets/voice-previews/optional-manifest.json`，原始结果位于 `test/chinese-tts-benchmark/`。

每个可下载模型提供一男一女两种声音，模型权重和运行组件共用。新增男声试听的来源与生成记录见 `src/assets/voice-previews/male-manifest.json`。Qwen 使用模型自带的 `Uncle_Fu` 说话人；ZipVoice 与 F5 使用由该说话人另行合成的参考录音，文本、参数及校验信息见 `scripts/optional-speech-assets/male-reference.json`。参考录音是模型生成素材，没有采用人物示例录音，也没有通过变调替代男声。模型与代码的原始许可保持不变。

`legacy-multivoice/` 仅保留早期生成资料及历史试听所需的原始版权声明；其中声音不再出现在当前下载目录。已有项目中的生成音频继续保留。
