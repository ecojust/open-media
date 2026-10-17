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

## 可选声音试听

`optional-manifest.json` 记录沉稳男声 `zm_013`、明亮女声 `zf_038` 和英文女声 `af_maple` 的真实录音。三段 MP3 合计 177,408 字节，即使尚未下载模型也能本地试听；点击喇叭不会开始下载。它们来自 `src-tauri/resources/speech-models.json` 中固定的模型及说话人编号，使用既有 1.13.8 运行库、内置中英模型的共享文本处理数据、语速 1、静音比例 1、24 kHz 单声道生成，输出为 64 kbps MP3。

重建时按可选模型目录中的 `model` 字段传入独立进程的 `--kokoro-model`、`--kokoro-voices`、`--kokoro-tokens`、`--kokoro-data-dir`、`--kokoro-lexicon`、`--tts-rule-fsts`，使用对应 `speakerId`、`--sample-rate=24000`、`--speed=1` 及本地 UTF-8 文案文件。中英文固定文案记录在清单的 `texts` 中。随后按上面的 MP3 格式编码，核对声音编号、音频内容、时长与哈希，再更新试听清单。共享文本数据的摘要按相对文件路径排序后，由 `(路径, SHA256)` 列表的紧凑 JSON 计算。
