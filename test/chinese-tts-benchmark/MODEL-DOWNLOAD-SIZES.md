# 两个候选中文语音模型的下载体积

核对日期：2026-10-17。以下按十进制 GB 统计官方仓库文件与实际加载所需组件，**不含 Python、推理运行库和安装缓存，也不是运行内存或软件安装包大小**。

| 模型 | 官方主仓库文件总量 | 完整推理所需模型文件 |
| --- | ---: | --- |
| IndexTTS2 | 5.90 GB | 必需组件约 **8.87 GB**；当前官方下载脚本默认约 **11.20 GB**，其中包含一份未用于该推理路径的重复权重 |
| CosyVoice 2 0.5B | 4.86 GB | 标准推理所需约 **4.07 GB**；完整下载官方仓库约 **4.86 GB** |

IndexTTS2 的主仓库之外，还要下载语音编码器、语义编码器、说话人编码器与声码器，不能只用主仓库的 5.90 GB 估计首次安装的总下载量。必需模型组件共 8,872,334,145 字节；官方默认脚本会完整下载语音编码器快照，包括额外的重复权重，因此共约 11,201,472,439 字节。

CosyVoice 2 的标准推理文件共 4,073,955,322 字节，已经包括语言模型初始化文件、声学模型、声码器、语音分词器与说话人编码器。官方仓库全量为 4,856,505,002 字节，额外包含批处理和推理加速相关的可选文件。另一套可选文本前端资源约 348 MB，不计入默认推理路径。

这些体积来自固定版本的文件清单和加载代码，未来版本可能变化。上述两个模型尚未在本批试听中生成音频，也未接入软件；本批实际试听模型以 [对比记录](README.md) 为准。

关于“精确时长控制”：所核对的 **IndexTTS2 发布版说明明确表示该功能尚未启用**，不能把后续版本或论文中的能力直接视为这个发布版已经可用。“情感表达最佳”也不是本次验证得出的结论。

## 官方来源

- [IndexTTS2 模型文件清单](https://huggingface.co/IndexTeam/IndexTTS-2/tree/740dcaff396282ffb241903d150ac011cd4b1ede)
- [IndexTTS2 附加模型下载实现](https://github.com/index-tts/index-tts/blob/d9e41aac89fd00b3d71497fddb287b7f24613712/indextts/utils/model_download.py)
- [IndexTTS2 发布版功能说明](https://github.com/index-tts/index-tts/blob/d9e41aac89fd00b3d71497fddb287b7f24613712/README.md#L42-L44)
- [CosyVoice 2 模型文件清单](https://huggingface.co/FunAudioLLM/CosyVoice2-0.5B/tree/eec1ae6c79877dbd9379285cf8789c9e0879293d)
- [CosyVoice 2 模型加载实现](https://github.com/FunAudioLLM/CosyVoice/blob/074ca6dc9e80a2f424f1f74b48bdd7d3fea531cc/cosyvoice/cli/cosyvoice.py#L139)
