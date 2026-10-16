# 离线语音组件的许可与源码

本目录保留离线语音组件及其构建依赖的原始许可、版权和第三方声明。`manifest.json` 记录每份文件在固定源码归档中的原路径和 SHA256，`files/` 内的原文不得改写、翻译或规范化换行。

独立语音进程通过动态库使用含有 GPL-3.0-or-later 代码的语音处理组件。因此，`scripts/speech-runtime-runner.c` 及所分发的独立语音组合按 GPL-3.0-or-later 提供；本项目主程序通过文件和独立进程与其通信。完整 GPL 文本保留于 `files/sherpa-espeak_ng/COPYING`。其余组件原许可同时保留，不能把整个组合仅标为 Apache 或 MIT。

主要组件与原许可：

| 组件 | 许可与位置 |
| --- | --- |
| sherpa-onnx 1.13.8 | Apache-2.0，`files/sherpa-onnx/LICENSE` |
| espeak-ng，固定提交 ed530aa113046142eb5115cf2fc9157854d0ffe1 | GPL-3.0-or-later，含所用上游修改，`files/sherpa-espeak_ng/` |
| piper-phonemize，固定提交 f3ff95afc03640bc1399e113e83361192a2fafb4 | MIT，含所用上游修改，`files/sherpa-piper_phonemize/` |
| ONNX Runtime 1.28.2 | MIT 和随附第三方声明，`files/onnxruntime/` |
| Kokoro v1.1 中文量化模型及 103 份音色 | Apache-2.0，`files/model/LICENSE` |
| Eigen | MPL-2.0 及原版权声明，`files/sherpa-eigen/`、`files/onnx-eigen/` |
| 文本规范化、解析、数值计算及其他构建依赖 | 各自原文保留在 `files/`，对应源归档见固定清单 |

`files/onnx-mp11/include/boost/mp11.hpp` 保留该库的原始版权及 Boost Software License 引用；完整 Boost 许可也包含在原始第三方声明和其他使用该许可的组件内。`onnxruntime-build` 上游仓库未提供独立的 LICENSE 文件；其固定发布提交中的工作流作为对应二进制的构建信息原样包含在源码包中，不为它另行赋予许可。

发布时必须同时提供 `speech-runtime-source.tar.gz`。该包包含固定源码归档、实际版本的构建工作流、所需 CPU 和桌面平台依赖源码、模型与音色原包、本项目独立进程源码及精确编译命令。它不是仅含下载链接的源码承诺。详见 `docs/SPEECH_RUNTIME.md`。
