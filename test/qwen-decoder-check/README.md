# 中文配音解码检查

2026-10-18，对“批量字幕配音变成杂音”的反馈检查了生产代码，并使用已有的本地模型运行真实声码器对照。这里记录的是数学检查及故障恢复验证，**没有在反馈问题的 M5 设备上复现，也不是字幕识别或可懂度测评**。

## 检查结果

- 每个字幕任务使用独立进程、文字文件和输出文件；未发现跨字幕复用推理状态。输入按照 UTF-8 长度保留标点分段，每次生成一段文字。`non_streaming_mode=True` 与模型 CustomVoice 接口默认一致，声码器收到的形状为 `[帧数, 16]`。
- 模型采样率和输出均校验为 24 kHz，未发现音频标签写错采样率。旧版仅检查音频非静音、数值有限；这些条件无法判断 GPU 静默计算错误。
- 同一组 42 × 16 的语音码解码出 3.36 秒音频。CPU BF16 与 FP32 的相对 RMS 差为 **1.60%**，不足以据此断言 BF16 是杂音根因，因此本次保留原有精度。
- 仅对照实际语音码的前 24 帧，得到 1.92 秒音频；CPU 完整解码与前缀解码的相对 RMS 差为 **1.11%**，低于 10% 的异常判定阈值。本机前缀解码约 **1.30 秒**，不包括模型在设备间移动的时间，其他硬件速度可能不同。
- 另用 31.52 秒长样本复核：394 × 16 语音码，前缀仍只检查 1.92 秒，前缀与完整解码相对差 **0.41%**，本机前缀解码约 **1.19 秒**。

## 应用中的防护

主要推理继续优先使用 GPU。注意力探针现在与 CPU FP32 参考值比较；实际声码器解码后，使用相同语音码的最多 1.92 秒前缀做 CPU 数值对照。GPU 解码报错或差异过大时，只把声码器切换到 CPU，直接重新解码已有语音码，不重新生成整条语音。校验通过时使用 GPU 生成的完整音频。

这是对静默数值损坏的防护，不会把“生成了 WAV 文件”视为中文正确。如果主模型生成的语音码本身不正确、噪声只出现在未抽查的后段，仍需要坏样本和对应设备日志继续定位。原有模型文件可直接复用，无需重新下载。

## 证据与复现

- [真实解码结果](decoder-cpu.json)：实际模型解码、精度对照、前缀开销及异常数值检查。
- [长样本解码结果](decoder-long-cpu.json)：长音频与固定长度前缀的对照。
- [注意力结果](attention-cpu.json)：真实分组注意力、因果掩码和缓存长度的数值对照。
- [输入校验值](inputs.json)：代码及既有音频样本的校验值。
- `scripts/test-speech-device-runtime.py`：覆盖有限但损坏的输出、GPU 解码异常、单独回退声码器、取消任务、码维度错误等行为。模拟故障用来验证恢复流程，不作为硬件通过记录。

使用已安装的语音推理环境，不会下载模型：

```sh
python scripts/test-speech-qwen-decoder.py \
  --model /path/to/model/speech_tokenizer \
  --reference-audio test/chinese-tts-benchmark/wav/qwen3-tts-1.7b-serena/01.wav \
  --device cpu --output decoder-result.json
python scripts/test-speech-qwen-attention.py --device cpu --output attention-result.json
python scripts/test-speech-device-runtime.py
```

在对应 GPU 真机上将 `--device` 改为 `mps` 或 `cuda`，才能形成该硬件的验证记录。本目录当前只包含 Linux CPU 验证，不冒充 MPS 或 CUDA 结果。
