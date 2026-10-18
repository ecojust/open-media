# 本地声音试听

七种声音均由对应离线模型真实合成，统一朗读 Open Media 的介绍：

> 欢迎使用 Open Media。你可以录制屏幕、剪辑视频、编辑图片，还能生成配音，让创作更轻松。

点击卡片直接播放随软件提供的 MP3，不实时合成、不下载模型，也不添加时间线片段。声音保持原模型的说话人或参考声音，没有变调、变速或响度加工。实际配音仍需要对应模型与运行组件完整安装。

| 声音 ID | 模型及声音 |
| --- | --- |
| `matcha_zh_en_female` | Matcha 中英，内置女声，speaker 0 |
| `zipvoice_zh_female` / `zipvoice_zh_male` | ZipVoice Distill FP32，女声 / 男声参考 |
| `f5_zh_female` / `f5_zh_male` | F5-TTS v1 Base FP32，女声 / 男声参考 |
| `qwen3_serena` / `qwen3_uncle_fu` | Qwen3-TTS 1.7B BF16，Serena / Uncle_Fu |

内置声音为 16 kHz 单声道、64 kbps MP3；其余六段为 24 kHz 单声道、128 kbps MP3，统一速度 1。当前 Matcha 权重仅有一个女声说话人，没有对应男声。男声与同模型女声共享下载权重。

`manifest.json`、`optional-manifest.json` 和 `male-manifest.json` 记录实际模型、完整语料、参数、原始 WAV 和 MP3 校验和，以及完整解码后的时长和峰值。六段可选试听还记录生成时间、耗时和均方根。原始 WAV 和运行日志保留在生成工作目录。Python 模型通过应用调用入口生成，使用 CPU 和原始模型精度；未修改下载包配置。

## 参考声音与许可

ZipVoice 与 F5 的女声参考沿用已核验的合成参考。男声参考由 Qwen3 的官方 `Uncle_Fu` 声音独立合成，文本为“清晨的阳光照进房间，翻开今天的计划，让每一个想法慢慢变成现实。”它与试听文案独立，更新试听不会重新生成或替换参考音频。原始来源与参数见 `scripts/optional-speech-assets/male-reference.json`。

模型与推理代码的原始许可继续保留在 `licenses/`、`licenses/application/optional-speech/` 和 `licenses/speech-runtime/`：Matcha 与 Qwen3 模型使用 Apache-2.0；ZipVoice 权重标注 CC-BY-NC、代码 Apache-2.0；F5 权重为 CC-BY-NC-4.0、代码 MIT。声码器和运行库的各自许可证继续适用。固定试听并不改变这些许可范围。

## 生成与历史记录

内置女声使用 `scripts/generate-voice-previews.py --wav-dir <工作目录>`。六种可选声音使用 `scripts/generate-optional-voice-previews.py`，传入已有 `--python`、`--qwen-model`、`--f5-config`、`--zip-model`、`--runtime-script`、`--speech-root` 和 `--work` 路径。脚本验证模型文件后生成，不下载权重、不构建应用；可通过 `--voices` 选择声音。全部完成后，用相同路径参数加 `--assemble-only` 校验并汇总清单。

旧试听、三份原始清单及生成器逐字节归档于 `provenance/pre-introduction-20261018/`，校验表为 `archive-index.json`。原男声参考生成代码仍在 `provenance/male-20261018/`。新可选试听分别保存实际生成时的脚本快照于 `provenance/introduction-20261018/`，避免把历史音频归属于后来修改的代码。旧中文对比资料包保持原样。
