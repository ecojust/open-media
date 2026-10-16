# 内置离线语音

安装包携带独立语音进程、量化模型和 103 种音色：100 种中文音色及 3 种英文音色。语音合成使用 CPU，输出 24 kHz、单声道、16 位 PCM WAV。用户使用配音时不联网、不下载模型，也不依赖系统安装的声音。模型和音色约 207 MiB，另加各平台推理库。

## 固定输入

`scripts/speech-runtime.lock.json` 固定每个原始归档的来源、版本和 SHA256。运行组件采用 sherpa-onnx 1.13.8 的官方 C API 分发，模型采用 Kokoro v1.1 中文版的 INT8 权重及原始音色。必要依赖名和原始版权声明仅用于准确记录供应链。

模型中的 `speaker_names` 元数据确定音色顺序；清单中的 `speakerId` 与 `voices.bin` 使用相同顺序。不能根据音色名称中的数字推算索引。中英文文本均通过 UTF-8 文件送入独立进程。

## 准备和验证

需要 Node.js、curl、系统 tar 和 C 编译器。Windows 使用 x64 MSVC 开发环境；macOS 使用系统 C 编译工具；Linux 使用系统 C 编译工具。下载仅在构建过程中发生，缓存保存在 `.speech-runtime/downloads`。现有缓存每次使用前都校验 SHA256，校验失败立即停止。

```sh
node scripts/speech-runtime.mjs prepare
node scripts/speech-runtime.mjs verify
```

可用 `--target windows-x64`、`--target macos-arm64`、`--target macos-x64` 或 `--target linux-x64` 显式指定目标，但必须在相同系统和架构的主机编译及验证。`prepare` 编译 `scripts/speech-runtime-runner.c`，直接链接官方 C API 库，精确编译和链接参数保存在准备脚本中。其 Windows 清单启用 UTF-8 进程代码页；输入文本文件、模型路径和输出路径支持中文。独立进程不调用 shell，不播放音频，不访问麦克风。

`verify` 实际生成两个不同中文音色和一个英文音色，验证模型收到的中文未损坏、真实合成回调已结束、音频格式正确且具有可听样本，并检查两个中文音色结果确实不同。验证输入和输出路径特意包含中文及空格。模型加载阶段保持不定进度；开始生成后回调报告实际句子批次完成比例。

## 安装目录

公共资源位于 `resources/speech/`：

```text
manifest.json          音色及模型调用路径
runtime.json           固定输入和每个资源文件的 SHA256
source-lock.json       构建时使用的固定清单
model/                 模型、音色、字典及文本规范化数据
licenses/              原始许可证和声明
runtime/bin/           独立语音进程及 Windows 动态库
runtime/lib/           macOS、Linux 动态库
```

macOS 安装包将 `runtime/` 放入 `Contents/Helpers/speech/runtime/`，其余公共资源保留在 `Contents/Resources/speech/`。可执行文件保留相对动态库搜索路径 `@executable_path/../lib`。Windows 动态库与可执行文件放在同一目录。Linux 使用 `$ORIGIN/../lib`。

macOS 独立进程显式以 13.0 为最低系统版本编译，避免构建机器的系统版本意外提高安装要求。验证会读取独立进程及所有动态库的 Mach-O 架构和最低系统版本，拒绝与当前架构不符或要求高于 13.0 的组件。

准备阶段对独立进程及两份动态库逐一进行本地代码签名并严格验证，随后才记录最终文件哈希；不同架构不依赖编译器是否自动签名。应用打包时继续签名外层应用，安装后的语音验证再次检查每个独立组件的签名。

macOS 安装后验证：

```sh
node scripts/speech-runtime.mjs verify \
  --directory '/path/Open Media.app/Contents/Resources/speech' \
  --executable-directory '/path/Open Media.app/Contents/Helpers/speech' \
  --packaged
```

`--packaged` 只允许 macOS 可执行代码在应用签名时改变原二进制字节，仍逐字校验模型、音色、清单及许可证，并实际运行合成。Windows 安装后仍校验全部二进制哈希。应用不会用这些构建审计哈希限制用户替换独立组件。

## 完整对应源码

```sh
node scripts/speech-runtime.mjs sources --output speech-runtime-source.tar.gz
```

源码包根目录为 `speech-runtime-source/`，包括 `.speech-runtime/downloads/` 中全部固定归档、独立进程源码和 Windows 清单、精确构建脚本、模型原包、许可证和本说明。源码与音色不省略，不能仅分发预编译库或链接列表。

源码范围包含：语音组件 1.13.8 完整原始源码和其中的发布工作流；实际使用的语音前端分支提交；所有通用构建依赖；推理库 1.28.2 完整源码、该二进制发布标签对应的构建工作流、CPU 和 macOS 平台所用依赖源码。推理库的 ONNX 子模块与固定 v1.22.0 归档对应同一提交。未使用的 GPU、训练、网页和模糊测试组件不进入已分发的 CPU 二进制，无须另外安装。

重新生成本项目独立进程：解压源码包，在目标平台按上述 `prepare`、`verify` 命令执行。准备脚本会从已提供且固定哈希的原始运行归档中提取 C API 头文件及链接库，重新编译独立进程；该步骤不需要重新下载归档。

若需修改推理库或语音前端，解压相应源归档和依赖。语音组件的 `cmake/download-all-deps.py` 和 `cmake/*.cmake` 记录依赖名称和构建选项；按各 CMake 文件的 `possible_file_locations` 中记录的本地文件名放置对应归档，可供上游 CMake 自动找到；固定清单的归档名用于避免不同依赖文件同名，不应直接照搬 URL 末尾的通用版本名。官方平台编译参数完整保留在其 `.github/workflows/linux.yaml`、`macos.yaml` 和 `windows-x64.yaml` 中。推理库对应发布的构建流程保留在 `onnxruntime-build` 归档的 `.github/workflows/`；其 CMake 输入记录在推理库 `cmake/deps.txt`。这些工作流包含上游为分发版本采用的库名和打包修改，不以未修改的上游发行版替代。修改后使用相同 C API 头文件与动态库重建独立进程。

原始归档中有大型测试数据，完整展开源码需要额外磁盘空间；发布源码包直接保留原始压缩归档。标准编译器、系统 SDK、CMake、Python 和打包工具由构建者安装。所有下载包的 SHA256 与出处均在固定清单中。

用户可在自己的安装副本中替换已重建的独立组件和模型。macOS 修改可执行文件或库后，对库、独立进程及应用副本重新执行系统代码签名工具的本地签名，即可使系统加载修改后的文件；应用不校验供应商签名密钥。无需项目私钥或外部激活服务。具体许可与原始文本见 `licenses/speech-runtime/README.md`。
