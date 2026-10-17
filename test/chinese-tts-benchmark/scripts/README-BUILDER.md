# 中文模型试听资料打包器

此目录是制作工具和页面模板，不是最终评测资料。请仅发布打包脚本成功生成的输出目录。

`corpus.json` 原样保留统一的 10 条中文语料和关注点，已经移除旧音色的音频映射。

复现工具可随最终资料放入 `scripts/package.py` 与 `scripts/template.html`。脚本先找同目录 `corpus.json`，不存在时自动读取上一级 `../corpus.json`；也可用 `--corpus` 指定。输出目录请放到另一处，避免覆盖正在运行的脚本。

## 生成

依赖 Python 3、FFmpeg 和 FFprobe。无需联网，不下载模型，不产生合成音频。

```bash
python3 package.py \
  --manifest /path/to/model-a/manifest.json \
  --manifest /path/to/model-b/manifest.json \
  --manifest /path/to/model-c/manifest.json \
  --provenance-dir /path/to/curated-original-records \
  --output /path/to/publishable-comparison \
  --standalone --zip --raw-zip
```

- 默认至少 3 个模型，每模型必须是同一套原文的 10 条真实 WAV。
- 各模型接收相同原文；内部标准中文前端可按模型的官方实现进行规范化，这不是手工改写语料。若前端输出被单独提供，记录在 `normalized_text`，原文继续保留在 `text`。
- 页面按 `model_download_bytes` 从小到大排列。盲听时随机排序，隐藏名称、大小、性能信息；恢复名称后保留盲听字母以便核对。
- 浏览器默认不播放；点击才试听，同时只播放一段。没有音量增强或语速调节。
- 原始 WAV 原样复制并核对 SHA256。MP3 仅以 192 kbps 编码，保留采样率和声道，不执行滤镜、变速、增益或静音裁剪。
- `--provenance-dir` 可选：将整理后的原始记录、日志、参考音频、来源与诊断证据原样递归复制到 `provenance/`，逐文件核对复制前后 SHA256。请传入整理好的证据目录，不要传包含模型权重的整个工作目录。证据与输出目录不能互相包含。
- 证据目录纳入完整 ZIP、原始 WAV ZIP 及各自校验清单；`provenance-index.json` 记录来源文件字节数与哈希。诊断组音频不计入正式 10 条样本。
- `index.html` 和所有音频可在本地打开。单文件 HTML 内嵌 MP3；完整试听 ZIP 包含网页、MP3 和原始 WAV，避免原始音频下载链接失效；另可单独提供原始 WAV ZIP。完整试听包同时保留 `scripts/` 中的打包与浏览器核对工具。各 ZIP 有可独立验证的 SHA256 清单。单文件 HTML 单独提供，完整 ZIP 不重复包含这份嵌入音频的页面。
- 打包会实际解码 WAV / MP3，核对清单时长，记录峰值、RMS、接近满量程与超过满量程样本数；浮点 WAV 的有限超满量程数值原样保留，不归一化；这些是客观校验项，不能作为自然度评分。
- 已有输出目录默认拒绝覆盖。`--overwrite` 仅覆盖带本工具标记的旧输出目录。

## 模型清单字段

每个模型一个 JSON。以下是字段说明，不是包含虚构数据的示例结果：

| 字段 | 要求 |
| --- | --- |
| `id` | 独立模型标识，仅字母数字及 `._-` |
| `name` | 真实模型名称及必要版本、精度标识 |
| `model_family` | 架构或模型家族 |
| `voice` | 本次固定的声音，可字符串或对象 |
| `model_download_bytes` | 本次推理全部必需模型文件的实际下载字节合计；若经压缩包分发，以下载包计量 |
| `weights_bytes` | 可选，单独的解包权重字节数，可能大于压缩下载包 |
| `model_unpacked_bytes` | 可选，解包后实际推理必需组件的字节合计 |
| `download_scope` | 必填，说明已包括哪些组件、公共依赖是否计入 |
| `runtime_download_bytes` | 可选，运行库下载字节数；未测量留空 |
| `runtime_size_notes` | 说明运行库是否未计，明确不是完整应用安装包体积 |
| `model_files` | 可选，数组 `[{path, bytes, sha256, url}]`；若提供 `model_unpacked_bytes`，`bytes` 合计须与其一致 |
| `download_files` | 可选，实际下载文件 `[{path, bytes, sha256, url}]`，合计须等于 `model_download_bytes` |
| `peak_rss_bytes` | 可空，实际峰值进程常驻内存，不可用模型大小代替 |
| `memory_notes` | 峰值内存的测量范围、方式，或未测量说明 |
| `runtime` | 必填，实际后端、版本、设备，字符串或对象 |
| `hardware` | 必填，真实测试机器 CPU / GPU 等，字符串或对象 |
| `settings` | 必填，固定声音、采样策略、线程、精度、随机种子等实际设置 |
| `sources` | 必填，模型来源 URL 数组，或 `[{name, url}]` |
| `license` | 必填，许可及必要限制；字符串或对象 |
| `notes` | 可选，包括参考音频来源、研究用途或本次生成限制 |
| `generation_notes` | 耗时是否含启动加载、预热等范围说明 |
| `samples` | 以下样本数组，恰好 10 条 |

样本字段：

| 字段 | 要求 |
| --- | --- |
| `id` | `01`—`10` |
| `text` | 与 `corpus.json` 完全一致的中文原文；不预先改写日期、数字和多音词 |
| `normalized_text` | 可选，模型官方前端规范化后实际送入推理的文本；必须保留 `text` 原文，两者可不同 |
| `wav` | 原始 WAV 路径，相对本清单所在目录，或绝对路径 |
| `generation_seconds` | 实际生成用时，不得估算；允许真实计时结果为 0 |
| `audio_seconds` | 可选，源记录的音频时长；脚本会实际解码复核 |
| `wav_sha256` | 可选，源记录的 WAV 校验值；脚本会重新计算核对 |
| `generation_notes` | 可选，本条计时范围，覆盖顶层说明 |
| `notes` | 可选，逐句前端日志或生成情况说明，页面可见 |
| `reuse` / `reused_from` 等 | 可选，原始音频复用来源、哈希、原次计时。页面明确显示，不能将复制耗时当作重新生成耗时 |

也支持顶层 `model` 对象包裹模型字段。原始清单会原样保存在输出的 `manifests/`，统一清单在 `manifest.json`。每条样本的原始字段完整保存在 `source_record`，页面“本句输入与生成记录”可展开查看；盲听时隐藏这些可能暴露模型身份的信息。

## 发布核对

成功产物应有 `validation.json`、`SHA256SUMS.txt`、完整模型和 10 条样本。不得把此目录下未填数据的 `template.html` 或回归测试夹具作为试听结果上传。模型名仅用于识别实际测试对象，不表示产品已内置或可商用。页面明确不提供未经评定的质量排名。

可在装有项目开发依赖的仓库目录运行浏览器核对，环境需有 Chromium：

```bash
COMPARISON_ROOT=/path/to/publishable-comparison \
COMPARISON_ARTIFACTS=/path/to/verification-artifacts \
COMPARISON_MODELS=4 \
node /path/to/scripts/verify-browser.cjs
```

检查原文、大小排序、真实耗时与前端记录、每模型 10 条、独占播放、盲听映射及窄屏布局。单文件页面载入后切断网络，逐条实际解码全部内嵌 MP3，验证非静音与时长，并实际播放每个模型。环境策略禁止 `file://` 时，通过本地 HTTP 载入后断网进行该核对，报告会注明这一边界。
