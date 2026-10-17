# 本地声音试听

本目录保存当前内置的 1 种中英女声，以及 3 种可选声音的固定试听录音。内置女声的记录保存在 `manifest.json`。MP3 文件名是实际声音 ID `matcha_zh_en_female`，使用正式配音的同一声学模型、声码器和说话人编号 0 生成。中文与英文共用这一个声音，语速变化不计为额外音色。

- 固定文案：你好，这是一段语音试听。让文字拥有清晰自然的声音。
- 参数：语速 1、静音比例 0.2、噪声比例 1、16 kHz 单声道、MP3 64 kbps。
- 来源：项目锁定的 Matcha 中英模型、Vocos 16 kHz 声码器和 sherpa-onnx 1.13.8 本地运行库。许可证、来源与校验信息见 `licenses/speech-runtime/` 和 `scripts/speech-runtime.lock.json`。

试听文件随前端资源一同打包，点击声音卡片直接播放本地录音，不实时合成，也不添加时间线片段。样本以标准语速保存，试听按所选语速播放并保持音高；实际文本按所选速度生成。

## 重新生成

准备好锁定的离线语音资源及源码缓存，并确保 Python 3、FFmpeg、ffprobe 可用。在仓库根目录执行：

```sh
python3 scripts/generate-voice-previews.py --wav-dir /tmp/open-media-bundled-previews
```

脚本读取 `src/core/voice-groups.ts` 的真实声音 ID，直接调用现有 C API 库，不编译应用、不联网下载模型。默认使用已准备的 Linux 运行库；其他平台可用 `--library` 指定相同版本的 C API 动态库。已有外部模型可用 `--speech-root` 和 `--manifest` 指定资源位置。

脚本生成 MP3 和 `manifest.json`，完整解码并检查采样率、声道、非静音及解码时长。允许编码器保留不超过一帧（36 毫秒）的尾部填充，清单分别记录原始和解码时长。WAV 保留在指定目录，不纳入安装包。

清单记录声音 ID、说话人编号、时长、大小、原始及解码峰值、WAV/MP3 校验和，以及声学模型、声码器、C API 库、公共头文件、生成脚本和声音目录的校验和。不同 CPU 或编码器版本可能影响输出字节，更新资源时应重新核对清单。

## 可选声音

三种下载声音分别使用对应模型在正式中文对比语料中的第 01 段：**这是一款全程由AI接管并生成的软件**。音频逐字节复制自 `test/chinese-tts-benchmark/audio/`，没有重新合成、替换说话人或改变语速。三段 MP3 共 212,292 字节，未下载模型时也可直接试听。

| 声音 ID | 模型 | 原始试听目录 |
| --- | --- | --- |
| `zipvoice_zh_female` | ZipVoice Distill FP32 | `zipvoice-distill-fp32-zh-frontend/01.mp3` |
| `f5_zh_female` | F5-TTS v1 Base FP32 | `f5-v1-base-fp32/01.mp3` |
| `qwen3_serena` | Qwen3-TTS 1.7B BF16 · Serena | `qwen3-tts-1.7b-serena/01.mp3` |

`optional-manifest.json` 逐条记录合成设置、参考音频信息、原始 WAV 与 MP3 的 SHA-256、时长以及来源清单路径；`licenses/` 保留模型和推理代码原始许可。ZipVoice、F5 的音色使用已有合成参考语音，Qwen3 使用官方 Serena 说话人。模型权重许可分别为 CC-BY-NC、CC-BY-NC-4.0、Apache-2.0，推理代码与声码器的许可另行保留。

固定试听只验证音色文件可以播放。模型和当前平台运行组件均安装、校验通过之后，才会解锁文本合成，播放试听不会开始模型下载。
