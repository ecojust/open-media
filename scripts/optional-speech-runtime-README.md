# 可选配音运行组件

`optional-speech-runtime.yml` 只构建、验证按需下载的运行组件，不构建应用。应用本身不要求用户安装 Python、推理依赖或命令行媒体工具。

平台锁位于 `optional-speech-runtime.lock.json`：独立 Python 3.11.14 发行文件由完整下载大小及 SHA-256 固定，F5 推理源码固定到 Git 提交。macOS ARM64 使用 PyTorch 2.6.0，macOS Intel 使用最后提供该架构官方安装包的 2.2.2，Windows x64 使用 2.9.1 CPU。共同依赖及其传递依赖在 `optional-speech-runtime-requirements.txt` 中固定；实际安装文件来源、哈希和最终版本记录随包保留。Qwen 推理 API 独立安装，不引入未使用的网页演示依赖。

macOS 兼容性依据每个实际 Mach-O 文件的最低系统要求检查，不能仅依据安装包文件名。ARM64 的 2.7.1、2.8.0 和 2.9.1 自带并行计算库要求 macOS 14.0，因此使用库最低要求为 11.1 的 2.6.0；ONNX Runtime 固定为最低要求 11.0 的 1.19.2。保留已有有效签名，对明确未签名的组件在打包时使用 ad-hoc 签名，并严格验证所有架构；签名前后哈希、操作和验证结果随包记录。Windows 会审计实际 DLL 导入并附带缺失的可再分发运行库与原始许可，不依赖宿主已经安装的开发环境。

运行包固定保留 F5 的 FP32 和 Qwen 的 BF16 推理，禁止静默降低或替换精度。CPU 是必要的跨平台基线，不要求显卡。声音模型权重独立下载，不放入运行包。

应用通过 `speech-voice-adapter.py` 和 `speech-device-runtime.py` 在私有任务目录中选择声音与推理设备，保持已发布运行包不可变。优先使用实际可用且通过必需算子检测的 CUDA / MPS，音频处理部分不兼容时显式使用 CPU 并报告混合路径，主模型 GPU 初始化或合成失败时清理并重试 CPU 一次。macOS ARM64 的现有依赖含 MPS，Qwen 还需满足 BF16 算子支持；Windows 当前固定 CPU wheel，不能因有显卡就声称支持 CUDA。设备、回退原因及真实生成进度通过标准输出传回应用，详见 `docs/SPEECH_RUNTIME.md`。

ZIP 根目录为：

```text
manifest.json
runtime-info.json
python/...
runner/tts.py
runner/vendor/f5_tts/...
licenses/...
```

`manifest.json` 列出除自身外每一个普通文件的相对路径、大小、SHA-256 和可执行权限。制作时只允许运行根目录内部的链接，最终全部转换为普通文件。产出的 `runtime-metadata.json` 记录 ZIP 大小、解压大小、ZIP 哈希、内部清单哈希、解释器和脚本入口，应用下载器必须使用这些真实值。

在对应实际平台执行：

```sh
python scripts/optional-speech-runtime-build.py \
  --platform macos-arm64 \
  --work /temporary/optional-speech-runtime \
  --output artifacts/optional-speech-runtime
```

构建目录必须为空。可分成 `--phase build` 和 `--phase validate`；前者安装运行环境并自检，后者下载校验完整模型并执行真实合成。模型文件来自应用的 `speech-models.json`，尚未发布的小型配置和参考音频优先从 `scripts/optional-speech-assets/` 读取，仍必须通过目录中记录的大小与哈希校验。海外构建节点优先使用同一文件的原始下载源，应用目录仍保留面向用户的镜像优先顺序；所有来源必须匹配同一大小和哈希。

验证先生成完整测试句，再制作 ZIP 并解压到包含中文和空格的新目录，同时移动模型目录。第二次使用独立解释器的 `-I -B` 隔离模式、去除宿主包路径及外部工具 PATH，并在导入任何模型前阻止网络连接，再次完整合成。检查单声道 24 kHz、非静音、有限样本和合理时长，保存实际 WAV、日志和结果，不用导入成功代替模型可用。离线推理结束和应用实际命令测试结束后分别核对整个运行目录；新增缓存、内容修改和权限变化都会阻止发布。可单独执行 `--phase integrity` 重复核对，不重新下载模型或生成音频。

三个平台全部通过后，通过 `publish-speech-runtime.yml` 输入构建运行 ID 和完整源提交 SHA。若只有 Windows 的应用集成需要修复，可保留原运行中两个 macOS 平台已通过的产物，再提供成功的 `recover-speech-runtime-windows.yml` 运行 ID 和应用修复提交 SHA。恢复流程从原提交构建运行组件，使用修复后的应用代码重新验证；运行时来源（`sourceCommit` / `runtimeSourceCommit`）、应用来源（`applicationSourceCommit`）及验证运行 ID 分别记录。发布器逐平台要求真实推理、应用调用和完整性步骤成功，不能用原运行的失败结果替代 Windows 恢复验证。

发布器复核已有 ZIP、内部清单和每个文件的哈希，不重复构建。`speech-runtime-v1` 先作为草稿上传，只有附件集合、大小及服务端 SHA-256 全部匹配后才公开为独立预发布；异常保留草稿供排查。它不设置为最新应用版本，不覆盖已存在的同名组件。模型权重和临时测试目录不会上传。
