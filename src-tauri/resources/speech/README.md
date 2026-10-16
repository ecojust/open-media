# 离线语音资源

运行 `node scripts/speech-runtime.mjs prepare` 准备当前平台的独立语音进程、模型及音色；运行 `node scripts/speech-runtime.mjs verify` 进行真实离线语音验证。生成文件仅进入安装包，不提交到版本库。

公共数据：`manifest.json`、`runtime.json`、`source-lock.json`、`model/` 和 `licenses/`。可执行组件位于 `runtime/`；macOS 安装时单独放到应用的 `Contents/Helpers/speech/runtime/`。

完整来源、固定哈希、源码及许可要求见 `docs/SPEECH_RUNTIME.md`。
