# 配音试听资料

另见 [中文配音解码检查与验证范围](qwen-decoder-check/README.md)。

## 中文离线模型对比

按模型下载体积递增，使用同一套 10 段中文语料对比 4 个独立模型，共 **40 段真实合成结果**。包含原句“这是一款全程由AI接管并生成的软件”，以及解说、对话、情绪、旁白、数字日期和长段落。

| 模型 | 本次必需模型文件下载量 | 试听数量 |
| --- | ---: | ---: |
| MeloTTS FP32 | 约 167 MB | 10 段 |
| ZipVoice Distill FP32 | 约 532 MB | 10 段 |
| F5-TTS v1 Base FP32 | 约 1.40 GB | 10 段 |
| Qwen3-TTS 1.7B CustomVoice | 约 4.52 GB | 10 段 |

- [直接浏览 MP3 音频](chinese-tts-benchmark/audio/) · [直接浏览原始 WAV](chinese-tts-benchmark/wav/)：按模型分目录，每个模型 10 段独立文件。
- [对比说明与完整记录](chinese-tts-benchmark/README.md)
- [下载单文件试听页](https://github.com/ecojust/open-media/raw/refs/heads/master/test/chinese-tts-benchmark/Open-Media-Chinese-TTS-Comparison.html)：下载后用浏览器打开，内含全部音频，支持逐句比较和随机盲听。
- [下载完整试听包](https://github.com/ecojust/open-media/raw/refs/heads/master/test/chinese-tts-benchmark/Open-Media-Chinese-TTS-Comparison.zip)：包含试听页面、MP3、原始 WAV、生成参数与来源记录。
- [原始音频与证据包](https://github.com/ecojust/open-media/raw/refs/heads/master/test/chinese-tts-benchmark/Open-Media-Chinese-TTS-Raw-WAV.zip)

大小按实际下载的全部必需模型组件统计，不含推理运行库；解包大小、运行内存与生成时间分别记录。音频没有后期增强或变速，中文前端的规范化差异也保留在记录中。不同模型在不同机器上生成，耗时不能直接作为同机速度排名。

这些是候选模型的研究试听，未接入软件。模型来源、固定音色或合成参考声音、许可和复现脚本都在资料目录中；此目录不上传模型权重。

另见 [IndexTTS2 与 CosyVoice 2 下载体积核对](chinese-tts-benchmark/MODEL-DOWNLOAD-SIZES.md)。

## 已有可下载音色试听

三种待下载音色各 10 段，共 **30 段真实合成音频**，总时长约 9 分 38 秒。两个中文音色使用相同原文，英文音色使用对应英文语料。

| 资料 | 内容 |
| --- | --- |
| [完整资料包](voice-auditions/Open-Media-Voice-Auditions.zip) | 约 37.5 MB，包含 30 段 MP3、30 段原始 WAV、3 份音色连播、对应文本、试听页面、生成记录与来源许可 |
| [单文件试听页](voice-auditions/Open-Media-Voice-Auditions.html) | 约 12.4 MB，内含全部音频；下载后用浏览器打开，可逐段对照或按音色连播 |
| [文件校验值](voice-auditions/SHA256SUMS) | 资料包和单文件试听页的 SHA256 |

音色包括沉稳男声、明亮女声、英文女声。语料涵盖原句回归、功能解说、疑问对话、庆祝、安慰、故事旁白、旅行纪录、操作教学、数字日期及长段落。

资料包中的 `manifest.json` 记录实际模型来源、音色编号、合成参数、音频时长及文件校验值；`corpus.json` 提供全部原文，`chapters.json` 提供连播章节时间。三种音色共用一个按需下载模型包，本目录仅保存试听资料，不附带模型权重。

当前试听用于评估现有可下载音色，候选研究说明不代表其他模型已接入软件。自动化测试仍位于 `tests/`。
