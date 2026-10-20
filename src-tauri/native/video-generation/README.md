# 本地视频生成进程

运行进程与编辑器分离；`runner.m` 只负责校验请求、调用已固定版本的推理 API，
以及输出机器可读进度。不会执行模型仓库中的脚本，也不要求用户安装编译器。
`upstream/` 是固定提交的原始依赖文件，版权声明和许可证保留原文。

## 构建

`src-tauri/build.rs` 在 macOS arm64 目标上使用 macOS 26 SDK（Xcode 26 或更新）
编译独立进程，部署目标为 macOS 15。最终生成：

- `$OUT_DIR/open-media-video-generation`：临时签名的独立可执行文件。
- `$OUT_DIR/h3_shaders.metal`：原始 GPU 内核，运行时由系统编译。

Rust 通过 `include_bytes!` 嵌入上述文件，再按内容校验后原子写入运行目录。
主程序不动态加载自带推理库，运行进程也不共享主程序的签名身份。
非 macOS arm64 平台不编译或运行此后端。

## 进程协议 v1

父进程设置工作目录为上述两个文件所在目录，并通过环境变量
`H3_FFMPEG`、`H3_FFPROBE` 指定经过验证的内置媒体工具绝对路径。
父进程独占输出目录；全部输入和输出路径使用绝对路径，禁止由 MCP 传入任意路径。

启动：`open-media-video-generation --request /absolute/request.json`。

```json
{
  "modelDir": "/absolute/models/snapshot",
  "outputPath": "/absolute/jobs/job-123/shot-1.mp4",
  "prompt": "清晨的山谷，镜头缓慢向前推进，光线柔和",
  "width": 512,
  "height": 512,
  "frames": 56,
  "steps": 20,
  "seed": 42,
  "ssdStreaming": true
}
```

基础模式可另外设置 `firstFrame`、`lastFrame` 图片路径；参考模式设置
`references: [{kind, path, audioPath?, includeEmbeddedAudio?}]`。
`kind` 为 `image`、`video`、`audio` 或 `video-audio`。
参考模式与首尾帧模式互斥；参考音频需与至少一个视觉参考共同使用。
图片最多 9 张，视频最多 3 段，音频最多 3 段，总参考数量最多 12。
`modelDir` 必须含 `FL2VA/` 目录；参考模式另外需要 `Ref2VA/`，共享文件按
SHA-256 内容缓存复用后映射到各自目录。

可选性能参数为 `renderWidth`、`renderHeight`、`denoiseReuse`、`ditLayers`、
`coreReuse`。降低内部画布需保持宽高比且不超过输出尺寸；步数复用与核心复用不能同时开启。
默认开启 SSD 流式加载以降低权重常驻内存，同时把文本编码器预取深度限制为一层；
默认不启用占用额外内存的中途解码预览。

加载权重前先检查视频与音频的归一化配置。视频使用 `video_vae/config.json`
中的 24 维 `latents_mean` / `latents_std`，并非 `video_vae/source/config.json`；
音频使用 `audio_vae/config.json` 中的 32 维数组。缺文件、损坏 JSON、
数组长度不匹配或无效标准差会立即失败；参考模式同时检查两个模型目录。

输出固定 24 fps。帧数向上对齐到 `5 + 17n`，因此实际时长需读取结果，不能
把请求秒数当作精确结果；最长 362 帧。宽高均为 32 的倍数，最多 768×1344 像素。

标准输出逐行输出 JSON，标准错误用于原始引擎诊断：

```json
{"type":"progress","stage":"text encoder","completed":12,"total":50}
{"type":"progress","stage":"FFmpeg","completed":56,"total":56}
{"type":"result","outputPath":"/absolute/jobs/job-123/shot-1.mp4","width":512,"height":512,"frames":56,"fps":24,"sampleRate":32000,"seed":42}
```

错误输出为 `{"type":"error","message":"..."}`，退出状态为 1。
进度是当前阶段计数，不是整体耗时百分比；父进程应单独保留阶段和计数。
取消由父进程终止整个进程组，避免遗留媒体编码子进程。
分镜由父进程顺序生成各镜头，再用内置媒体工具拼接；每镜头输出都须实际探测验证。

## 针对性验证

`node scripts/video-generation-verify.mjs` 验证锁定文件、源代码完整性、许可及共享清单。
在 macOS arm64 上，把工作目录切换到 runner 与 shader 所在目录后：

- `./open-media-video-generation --probe` 查询真实 GPU 和统一内存。
- `./open-media-video-generation --self-test` 编译完整内核并执行、读回真实 GPU 小矩阵运算。
- `./open-media-video-generation --check-model-configs /absolute/models/snapshot FL2VA`
  只检查基础模型归一化配置；最后一个参数改为 `Ref2VA` 时同时检查参考模型。
  此操作不读取大权重，也不启动 GPU。

这些检查不需要下载权重，**不代表完成真实视频生成质量或性能验证**。
完整生成验证另需用户安装约 144 GB 基础模型；参考模式增量约 66 GB。
