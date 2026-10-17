# 小型与中型模型试听生成证据

正式试听音频与对比页面位于资料包的主目录。本目录保留原始记录和复现材料，不包含模型权重、推理库或已安装的依赖。

- `melo/`：Melo FP32正式清单、全部运行日志及原始许可。
- `zipvoice/official-chinese-frontend/`：ZipVoice FP32官方中文前端正式清单、全部运行日志及固定前端源码记录。
- `zipvoice/default-frontend/`：完整10条未恢复中文数字规范化的原始WAV与生成清单，只作诊断，不算另一个模型。
- `zipvoice/reference/`：合成参考女声原始WAV、来源清单与原文，不是真人录音。
- `zipvoice/frontend-evidence/`：原推理实现与官方中文规范化源码证据，正式采用的版本以`official-normalizer/source.json`固定提交和摘要为准。
- `zipvoice/reproduce/`：实际使用的生成脚本；不携带权重，运行前须按清单来源准备相应模型/运行库，并按实际目录调整路径。

中文规范化固定为ZipVoice提交`2f7326fbfe999a3ad179e3f1af82a424d4a62819`的未修改`ChineseTextNormalizer`，使用`cn2an.transform(text, "an2cn")`自动处理中文正文。`text`保留原文，`normalized_text`保留真实模型输入；仅09变化并重新生成，另9条输入/模型/参数相同而明确复用真实WAV及来源摘要、原生成时间和耗时。

Melo下载167,006,755字节，必需解包177,392,822字节；ZipVoice下载531,957,872字节，必需解包569,046,522字节。共享CPU运行库与554,709字节的前端依赖分别列出，不冒充神经网络权重。

Melo许可MIT。ZipVoice官方预训练权重声明CC-BY-NC（未指定版本），代码Apache-2.0；本轮只作研究试听，不据此宣称可以商业集成。
