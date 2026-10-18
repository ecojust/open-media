# 本地声音试听

本目录保存当前内置的 1 种中英女声，以及 3 个可选模型各自女声、男声的固定试听录音。内置女声的记录保存在 `manifest.json`。MP3 文件名是实际声音 ID `matcha_zh_en_female`，使用正式配音的同一声学模型、声码器和说话人编号 0 生成。中文与英文共用这一个声音，语速变化不计为额外音色。

- 七种声音统一使用中文对比语料中的第 01 段：这是一款全程由AI接管并生成的软件。
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

内置声音使用上述同一句文案，通过锁定的本地模型重新生成；更新试听不会改变可选模型原有的合成参考音频。

| 声音 ID | 模型 | 原始试听目录 |
| --- | --- | --- |
| `zipvoice_zh_female` | ZipVoice Distill FP32 | `zipvoice-distill-fp32-zh-frontend/01.mp3` |
| `f5_zh_female` | F5-TTS v1 Base FP32 | `f5-v1-base-fp32/01.mp3` |
| `qwen3_serena` | Qwen3-TTS 1.7B BF16 · Serena | `qwen3-tts-1.7b-serena/01.mp3` |

`optional-manifest.json` 逐条记录合成设置、参考音频信息、原始 WAV 与 MP3 的 SHA-256、时长以及来源清单路径；`licenses/` 保留模型和推理代码原始许可。ZipVoice、F5 的音色使用已有合成参考语音，Qwen3 使用官方 Serena 说话人。模型权重许可分别为 CC-BY-NC、CC-BY-NC-4.0、Apache-2.0，推理代码与声码器的许可另行保留。

固定试听只验证音色文件可以播放。模型和当前平台运行组件均安装、校验通过之后，才会解锁文本合成，播放试听不会开始模型下载。

## 男声音色

新增的三段男声试听均由对应模型实际合成，统一朗读第 01 段：**这是一款全程由AI接管并生成的软件**。声音 ID 分别为 `zipvoice_zh_male`、`f5_zh_male` 和 `qwen3_uncle_fu`，不会通过降低女声音高模拟男声。

Qwen3 使用同一 CustomVoice 权重中的官方 `Uncle_Fu` 普通话男声。ZipVoice 和 F5 使用项目自行合成的男声参考：由该说话人朗读“清晨的阳光照进房间，翻开今天的计划，让每一个想法慢慢变成现实。”参考与试听语料独立，未使用影视人物或其他真人的示例录音。参考音频为 24 kHz 单声道 PCM16，来源、原始 WAV 哈希、生成参数和转换记录见 `scripts/optional-speech-assets/male-reference.json`。

男声与同模型女声共享下载权重。`male-manifest.json` 保存三段真实试听的原始 WAV 与 MP3 哈希、文件大小、音频时长、生成耗时、实际参数、模型资源哈希、调用入口及完整解码后的非静音检查结果。试听采用 24 kHz 单声道、128 kbps MP3；未经变调、变速或换用其他模型音频。当前 Matcha 中英权重仅有一个女声说话人，因此没有对应男声音色。

模型与来源许可沿用 `licenses/application/optional-speech/` 中保留的原文：Qwen3 模型及推理代码 Apache-2.0；ZipVoice 权重 CC-BY-NC、代码 Apache-2.0；F5 权重 CC-BY-NC-4.0、代码 MIT；声码器和推理运行库的各自许可证继续适用。合成男声参考的上游模型是 `Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice`，固定修订为 `0c0e3051f131929182e2c023b9537f8b1c68adfe`。

重新生成使用 `scripts/generate-male-voice-previews.py`。它接受已安装的 Python、模型、原生运行库与输出工作目录，不构建应用。可分别用 `--phase reference`、`qwen3`、`f5`、`zipvoice` 生成，以避免同时加载多个大模型；只有显式传入 `--download-qwen` 才会通过应用目录中的多个来源下载缺失权重，并核验每个文件的完整大小和 SHA-256。Python 模型通过正式的 `speech-voice-adapter.py` 调用，原有下载包配置保持原样。

现有男声录音的生成代码原样保存在 `provenance/male-20261018/`，清单记录的原始代码哈希、时间及音频数据均保持不变。当前生成器支持新的设备调用入口，会同时复制 `speech-device-runtime.py`，并明确使用 CPU 生成固定试听；新一次生成将记录当前代码与设备模块的哈希，不把历史录音归属于后来更新的代码。
