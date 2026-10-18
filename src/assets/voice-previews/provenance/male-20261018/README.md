# 男声固定试听的原始生成代码

本目录逐字节保留 2026-10-18 生成三段男声试听与独立男声参考时使用的生成器及应用调用入口。它们的 SHA-256 与 `male-manifest.json`、`scripts/optional-speech-assets/male-reference.json` 中原有记录完全一致。

这些文件是历史来源快照，不随当前推理设备支持的改动更新。生成时间、参数、耗时、原始 WAV 和 MP3 的哈希均未修改，也没有重新生成音频。当前清单中的 `generator.script`、`generator.adapter` 指向本目录，以便核验当时实际运行的版本。

快照中的脚本依赖当时的项目目录结构；核对或历史重现时，应在独立工作目录中恢复其原有 `scripts/` 位置，并使用清单记录的模型及运行库。日常重新生成使用根目录下的 `scripts/generate-male-voice-previews.py`。当前生成器会把设备模块一同复制到任务目录，并显式选择 CPU，保持固定试听的推理条件。
