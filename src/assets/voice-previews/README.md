# 本地音色试听

本目录保存当前 25 个代表音色的固定试听录音。每个 MP3 的文件名就是实际声音 ID，使用与正式配音相同的离线模型和说话人参数生成；不是其他音色的替代录音，也不包含用户文本。

- 中文文案：你好，这是一段语音试听。让文字拥有清晰自然的声音。
- 英文文案：Hello, this is a voice preview. Let your story come to life with a clear and natural voice.
- 参数：语速 1、保留原始停顿、24 kHz 单声道、MP3 64 kbps。
- 来源：项目锁定的 Kokoro v1.1-zh INT8 模型和 sherpa-onnx 1.13.8 本地运行库。模型及运行库的许可证、来源与校验信息见 `licenses/speech-runtime/` 和 `scripts/speech-runtime.lock.json`。

试听文件随前端资源一同打包，点击声音卡片时直接播放本地录音。样本以标准语速保存，试听按所选语速播放并保持音高；实际文本仍按所选速度生成。

## 重新生成

先准备好项目锁定的离线语音资源和源码缓存，并确保 Python 3、FFmpeg、ffprobe 可用。在仓库根目录执行：

```sh
python3 scripts/generate-voice-previews.py --wav-dir /tmp/open-media-bundled-previews
```

脚本读取 `src/core/voice-groups.ts` 的代表声音 ID，直接调用现有 C API 库，同一进程只加载模型一次，不编译应用、不联网下载模型。默认使用已准备的 Linux 运行库；其他平台可通过 `--library` 指定相同版本的本地 C API 动态库。

脚本会生成 MP3 和 `manifest.json`，逐个完整解码，检查采样率、声道、非静音及解码时长。允许编码器保留不超过一帧（24 毫秒）的尾部填充，并在清单中分别记录原始和解码时长。未压缩 WAV 留在指定的临时目录，不纳入仓库。

清单记录每个声音的 ID、说话人编号、时长、文件大小、原始与解码峰值、WAV/MP3 校验和，以及模型、音色权重、C API 库、公共头文件、生成脚本、声音分组和配音进程源码的校验和。`runnerSourceSha256` 用于记录正式配音参数的源码版本，本次批量生成直接使用 C API；它不表示运行了配音进程。不同 CPU 或编码器版本可能影响字节级输出，更新资源时应重新核对清单。
