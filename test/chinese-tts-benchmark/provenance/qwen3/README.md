# Qwen3-TTS 1.7B 中文试听来源记录

本组为 10 条中文原文的真实离线推理结果，使用官方内置声音 Serena。所有样本来自同一次成功运行、同一进程、同一套 BF16 参数，没有混入后续矩阵任务或其他模型的音频。

- 原始生成任务：https://github.com/ecojust/open-media/actions/runs/39048371487
- 实际运行源码提交：`46a50b71769f971bfc75c44a29875cbaa85f6f75`
- 模型：`Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice`
- 固定模型 revision：`0c0e3051f131929182e2c023b9537f8b1c68adfe`
- 实际声音：`Serena`；`language=Chinese`
- 推理：`qwen-tts 0.1.1`、`torch 2.9.1+cpu`、BF16、SDPA、4 线程；没有 GPU 或在线语音合成服务。
- 实际机器：GitHub Actions Linux 运行器，Intel Xeon Platinum 8370C @ 2.80 GHz，4 个逻辑 CPU。完整配置见 `logs/cpu.txt`、`logs/memory.txt`。
- 必需模型下载文件：11 个，共 **4,520,159,586 字节**，包含主模型、语音 tokenizer/解码器、文本词表和配置；不含 Python/推理运行库，也不是软件安装包大小。
- 10 条音频合计 **143.52 秒**；逐条模型合成耗时合计 **801.993168616 秒**，不包括下载、模型加载、写盘或 MP3 编码。
- 模型加载耗时 **1.082502978 秒**；无额外预热，因此第一条合成可能包含首次推理开销。
- Python 进程峰值 RSS **6,383,267,840 字节**，由 Linux `resource.getrusage(RUSAGE_SELF).ru_maxrss × 1024` 记录，包含模型加载与生成，不包含 FFmpeg 子进程。
- 原始 WAV 为 24 kHz 单声道 FLOAT，保留模型输出样本；没有增益、变速、音量均衡或静音裁剪。所有 WAV 和原始 128 kbps MP3 均完整解码验证，非静音、无非有限值、无达到满量程的样本，原始峰值最大为 0.5。

`source/` 保存实际生成任务所用的原始脚本、依赖、工作流和语料。主分支后来增强的矩阵工作流不是本组音频的运行来源。

`manifest.original.json` 是生成任务输出的原始清单；`manifest.json` 补充了汇总试听页需要的体积范围、硬件和计时说明，音频内容未改变。`validation.json` 记录原始 WAV / MP3 校验结果。正式音频放在资料包的模型音频目录，本目录不重复保存音频或模型权重。

`api/` 和 `collection.json` 保留生成任务、原始 artifact、迁移来源和逐文件哈希。模型完整来源及文件哈希位于清单与 `model-upstream-metadata.json`；运行包来源位于 `implementation-source.json`。许可证原文与模型说明位于 `licenses/`。

不同模型使用的硬件和后端可能不同，合成用时不能直接作为硬件无关的速度排名；校验项不代表自然度评分。
