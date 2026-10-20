# MCP 服务

Open Media 桌面端提供 MCP 服务，供外部 AI 操作当前剪辑工程。视频剪辑顶部“项目设置”左侧的 **M** 按钮打开简洁的服务弹窗，显示连接地址、Token 和“复制配置”按钮，通过服务开关启停。有已认证的客户端连接时，M 按钮显示青紫色流动荧光；连接断开或服务停止后恢复普通样式。自动化任务的进度和取消操作位于“处理任务”中。

服务直接使用界面中的工程、撤销历史和保存位置。工具覆盖项目设置、全部轨道类型、片段编辑、字幕、水印、转场、背景音乐、片头片尾、配音、共享模型管理、图像／歌曲／视频生成和视频导出，共 **99 个**。完整参数以服务的 `tools/list` 或仓库的[工具清单](../src/mcp-tools.json)为准。

## 连接

| 项目 | 默认值或约定 |
| --- | --- |
| 传输 | MCP Streamable HTTP，JSON-RPC 2.0 |
| 默认地址 | `http://127.0.0.1:39861/mcp`，实际地址以启动后的弹窗为准 |
| 鉴权 | `Authorization: Bearer <Token>` |
| 协议版本 | `2025-11-25`、`2025-06-18`、`2025-03-26` |
| 启动 | 在服务弹窗中主动启动；重启应用后保持关闭 |
| 运行环境 | 桌面端；网页端不能监听本机端口 |

首次使用自动生成随机 Token，默认端口为 `39861`。每次启动优先使用上次保存的端口；端口不可用时，自动获取可用端口并保存。下次只要该端口仍可用，就继续复用，不需要手动配置。地址和 Token 保存在本机，不写入 `.omedia` 工程。关闭弹窗后服务仍运行，退出应用会关闭监听。

支持 HTTP 连接配置的客户端可参考以下内容；具体外层字段以客户端要求为准。服务启动后，弹窗中的“复制配置”会带入当前实际地址和完整 Token。

```json
{
  "mcpServers": {
    "open-media": {
      "type": "http",
      "url": "http://127.0.0.1:39861/mcp",
      "headers": {
        "Authorization": "Bearer REPLACE_WITH_TOKEN_FROM_OPEN_MEDIA"
      }
    }
  }
}
```

连接后先发送 `initialize` 和 `notifications/initialized`，再调用 `tools/list`、`tools/call`。请求使用 `Content-Type: application/json`；初始化之后可发送协商好的 `MCP-Protocol-Version`。所有 HTTP 请求都需要 Token。服务返回 JSON 响应，不提供独立 GET 事件流；调用工具的结果同时包含文字 `content` 和可解析的 `structuredContent`；取帧及联系表还提供 MCP 图片内容，可直接供视觉模型检查。

连接指示依据已认证且仍保持打开的 HTTP 连接，不缓存历史访问。服务支持连接复用，空闲 40 秒后关闭连接；短连接客户端在请求完成后关闭连接时，指示也会恢复普通样式。

服务默认仅监听本机回环地址。服务拒绝不匹配的 Host 和带有浏览器 Origin 的请求；不提供跨域网页接口或任意命令执行。网址素材导入只下载公开 HTTP(S) 媒体，拒绝私网、凭据地址及越界重定向。

## 工具范围

以下均为完整工具名。`trackId`、`clipId`、`assetId` 从工程查询结果获取，素材库 ID 从 `open_media_material_list` 获取。时间统一使用秒，画面坐标使用项目像素；轨道索引从 0 开始，顺序为前景到背景。

| 工具 | 功能 |
| --- | --- |
| `open_media_project_get` | 读取工程、尺寸、帧率、轨道、片段、素材及版本 |
| `open_media_project_validate` | 校验工程引用、时间、转场及字幕问题 |
| `open_media_project_update` | 修改名称、尺寸、帧率与背景，尺寸变化同步缩放视觉片段 |
| `open_media_project_new` | 新建并切换工程 |
| `open_media_project_open` | 从本机路径打开工程 |
| `open_media_project_save` | 保存到当前位置或指定路径 |
| `open_media_project_history` | 撤销或重做 |
| `open_media_asset_list` | 按类型列出工程素材 |
| `open_media_asset_import` | 导入本机视频、音频或图片 |
| `open_media_asset_remove` | 移除未被使用的工程素材引用，保留磁盘原件 |
| `open_media_track_add` | 新增视频、音频、文字或转场轨道 |
| `open_media_track_update` | 修改轨道名、静音／隐藏、锁定状态 |
| `open_media_track_remove` | 删除轨道及其中的片段 |
| `open_media_track_reorder` | 调整轨道顺序 |
| `open_media_clip_add` | 将已有素材添加到轨道，设置位置、时长、速度等 |
| `open_media_text_add` | 添加字幕或可编辑文字水印，支持完整文字样式 |
| `open_media_clip_update` | 修改时间、变换、音量、文字、滤镜或抠像 |
| `open_media_clip_move` | 移动片段位置或转移到兼容轨道 |
| `open_media_clip_split` | 按项目时间分割片段 |
| `open_media_clip_split_idle` | 检测长时间固定画面，按区间原子分割并标记黄色 repeat；保留内容与其他轨道，可撤销 |
| `open_media_clip_classify` | 将视频片段设为 repeat 或 normal，保存分类但不改变播放和导出 |
| `open_media_clip_trim` | 调整源起止时间，或按播放头裁剪开头／结尾 |
| `open_media_clip_duplicate` | 复制片段，可指定放置时间 |
| `open_media_clip_remove` | 删除片段，可接拢删除后形成的公共空白 |
| `open_media_clip_restore_audio_length` | 恢复循环音频的原始长度 |
| `open_media_clip_extract_audio` | 将视频声音分离到音频轨道，保留剪辑时间并静音原视频 |
| `open_media_subtitle_apply_style` | 将当前字幕属性应用到同轨道其他字幕 |
| `open_media_timeline_close_gaps` | 接拢所有轨道共同空白，保留同步关系 |
| `open_media_filter_list` | 列出画面滤镜预设和参数 |
| `open_media_transition_list` | 列出转场预设、已有转场和附近可用切点 |
| `open_media_transition_add` | 在最近的视频切点创建转场，时长前后各半 |
| `open_media_transition_update` | 修改已有转场的效果和时长 |
| `open_media_transition_remove` | 删除转场 |
| `open_media_playback_get` | 查询播放头、播放状态和选中片段 |
| `open_media_playback_set` | 控制播放、定位和片段选择 |
| `open_media_speech_voices` | 查询声音、安装状态和硬件要求 |
| `open_media_speech_settings_get` | 读取公共配音设置 |
| `open_media_speech_settings_set` | 修改音色、语速和字幕时长对齐设置 |
| `open_media_speech_plan` | 检查待配音字幕，返回可处理项及跳过原因 |
| `open_media_speech_generate` | 单条或批量生成配音，完成后加入时间线 |
| `open_media_speech_align` | 将字幕时长与已关联配音对齐 |
| `open_media_speech_model` | 查询、下载、取消下载或修复声音模型 |
| `open_media_material_list` | 搜索并分页浏览水印、配乐、片头片尾素材 |
| `open_media_material_add` | 添加内置素材，片头片尾支持前插／后插及编辑标题 |
| `open_media_export_start` | 按项目尺寸导出 MP4、WebM、MOV 或 GIF |
| `open_media_video_generation_status` | 查询平台支持、视频模型大小、下载和校验状态 |
| `open_media_video_model_download` | 经用户同意许可后按需下载视频模型与运行时，支持统一进度查询和取消 |
| `open_media_video_generation_start` | 通过提示词、首尾帧、参考素材或分镜生成视频，完成后一次加入工程，可选插入时间线 |
| `open_media_ai_status` | 查询全局语音、视频、图像、音乐模型与任务，包含体积、许可、硬件要求及运行环境状态 |
| `open_media_ai_model_download` | 经用户同意后按需安装全局模型及运行环境，已有安装共用 |
| `open_media_ai_model_repair` | 校验并修复已下载的模型或运行环境 |
| `open_media_image_generate` | 文生图或基于工程图片重绘，可选择仅生成、加入素材或插入视频轨道 |
| `open_media_music_generate` | 生成纯音乐或带歌词歌曲，可选择仅生成、加入素材或插入音频轨道 |
| `open_media_ai_job_get` | 查询全局原生 AI 任务，包括界面发起的任务 |
| `open_media_ai_job_cancel` | 请求取消可取消的全局原生 AI 任务 |
| `open_media_job_list` | 列出本次会话的自动化任务 |
| `open_media_job_get` | 查询任务进度、耗时、错误或完成结果 |
| `open_media_job_cancel` | 请求取消仍可取消的任务 |

### 分析、预览与高级编辑

这些工具与素材右键菜单、片段属性、字幕／配音面板及项目设置共用实现。只修改工程的操作可以撤销；处理媒体的工具先准备结果，再一次性写回工程。

| 工具 | 功能 |
| --- | --- |
| `open_media_asset_upload` | 分块上传媒体并导入当前工程 |
| `open_media_asset_import_url` | 从公开 HTTP/HTTPS 直链下载图片、音频或视频并导入工程，保存来源与 SHA-256 |
| `open_media_asset_probe` | 读取素材真实编码、显示尺寸、时长、帧率、音轨、旋转角度和 Alpha 通道信息；返回已保存的来源记录 |
| `open_media_asset_get_frame` | 按素材源时间提取真实 PNG 帧，返回可读取的图像数据、请求时间和实际帧时间 |
| `open_media_asset_storyboard` | 在素材源时间范围内均匀抽取 1–24 张真实图像帧，返回联系表帧集合及每张图像的实际时间 |
| `open_media_asset_detect_scenes` | 根据真实画面差异检测场景切换，返回源时间、分数、阈值与检测依据 |
| `open_media_asset_detect_idle` | 检测真实黑场、画面冻结和静音区间，返回源时间范围、置信依据和检测阈值 |
| `open_media_speech_generate_preview` | 合成一句可试听的配音，不加入时间线 |
| `open_media_speech_pronunciation_set` | 保存当前应用读法词典；按最长原文优先替换，仅影响合成发音，不改字幕文字 |
| `open_media_speech_timing_plan` | 根据文字和标点估算时长及溢出风险 |
| `open_media_speech_alignment_set` | 设置后续配音对齐策略：subtitle只调整字幕；ripple顺延后续字幕及配音；extend_visual延长覆盖画面（视频减速）并顺延后文 |
| `open_media_subtitle_import_export` | 导入或导出SRT、VTT、ASS字幕，支持按句分段和自动换行 |
| `open_media_audio_loudness_analyze` | 实际测量选中音频片段的综合响度LUFS、响度范围及真峰值dBTP，返回可取消任务 |
| `open_media_audio_balance` | 批量实测人声响度并调整片段音量，为背景音乐生成自动压低关键帧；保留原素材，一次提交并可整体撤销 |
| `open_media_audio_normalize` | 按目标LUFS及真峰值做双遍响度归一，生成新本地音频并替换片段，保留原素材供撤销 |
| `open_media_audio_process` | 离线处理音频片段：降噪、三段EQ、动态压缩、去齿音、峰值限制 |
| `open_media_audio_ducking` | 在人声轨道片段时段压低选中背景音频，含渐入和恢复；基于时间线区间烘焙新音频，非实时说话检测 |
| `open_media_music_fit_duration` | 将选中音乐适配目标秒数 |
| `open_media_audio_transcribe` | 使用按需下载的离线识别模型生成真实逐句或逐词时间戳 |
| `open_media_speech_pronunciation_get` | 读取当前配音读法词典，不修改设置 |
| `open_media_speech_alignment_get` | 读取当前配音对齐模式及间隔秒数 |
| `open_media_timeline_get_frame` | 返回指定时间的最终合成PNG画面，包含字幕、水印、滤镜和转场 |
| `open_media_preview_render` | 生成指定范围的低清预览视频并返回可分块下载的artifactId |
| `open_media_audio_preview` | 生成指定片段或范围的真实WAV试听 |
| `open_media_artifact_read` | 分块读取预览文件的原始二进制数据（base64） |
| `open_media_asset_ocr` | 离线识别素材帧中的简体中文和英文，返回文字、行/词区域及置信度；区域坐标以返回图像像素计 |
| `open_media_export_validate` | 检查缺失素材、字幕越界、配音重叠及无效剪辑 |
| `open_media_timeline_batch_edit` | 原子批量编辑时间线与项目 |
| `open_media_timeline_markers_set` | 完整替换当前项目的章节、重点和待检查标记 |
| `open_media_project_snapshot` | 管理当前工程的本地命名版本：create 需要 name；list 列出版本；compare 需要 id，省略 comparisonId 时与当前工程比较；restore 和 delete 需要 id |
| `open_media_project_video_compress` | 为当前工程引用的视频生成压缩工作副本；按文件去重，原件保留，所有分割片段及视频音频引用一起更新；支持 lossless 与 quality，质量为 high / balanced / compact |
| `open_media_project_video_restore` | 恢复当前时间线中的工程压缩视频到最初原件；可用 assetIds 限定范围，保留片段时序和效果，支持撤销 |
| `open_media_clip_keyframes_set` | 设置片段关键帧 |
| `open_media_clip_crop` | 裁剪视频或图片的源画面，坐标及宽高为0..1归一化值 |
| `open_media_focus_region` | 在当前片段显示矩形内框定归一化区域，生成等比放大、停留与恢复关键帧；保留位置、裁切与画面比例，保护已有动画 |
| `open_media_overlay_add` | 新增可编辑视觉标注 |
| `open_media_title_add` | 添加可编辑标题 |
| `open_media_template_customize` | 统一定制指定片段的透明度、布局和时长；可编辑文字与标注另支持颜色、字体和背景 |
| `open_media_clip_freeze_frame` | 将选中视频片段变为指定源帧的停帧，按duration展示且静音 |
| `open_media_clip_speed_ramp` | 设置视频或音频的变速曲线；points覆盖源片段0和1端点，按源位置插值 |
| `open_media_transition_parameters_set` | 调整转场方向、缓动、过渡颜色、模糊半径及作用范围 |

上传通过 `asset_upload` 的 `begin → chunk → commit` 流程：开始时提供文件名称、总大小和 SHA-256，每块携带 offset、base64 数据和分块 SHA-256；支持 status 查询与 abort 清理。每块最大 512 KiB，单文件最大 1 GiB；提交会核对全文件哈希并探测真实媒体类型。上传和网址导入成功后返回可用于剪辑的 assetId，并在工程中保存来源信息。

视频与音频预览每次最多 60 秒，视频预览宽度最多 1280 像素。只准备与请求范围相交的素材和字幕，合成保留原时间线的动画时刻；任务返回实际编码帧数 `encodedFrames`、已输出时长 `outputTime`（秒）和已用时间 `elapsedSeconds`。这些值与 `stage` 一起用于区分素材准备、合成和文件写入阶段。结果的 artifactId 可通过 `artifact_read` 分块下载；响应包含总大小和完整 SHA-256。缓存单个文件最大 64 MiB，最多保留 20 个／256 MiB，24 小时过期；请及时下载需要保留的结果。预览与取帧不会改变播放头或向工程添加素材。

桌面端 `timeline_get_frame` 使用原生合成并经内部通信返回 PNG，不从原生媒体画布读取像素。失败任务的 `errorDetails` 保留结构化错误，其中 `details.stage` 标明具体阶段，能定位到素材或字幕时返回 `details.resource` 的标识与名称；`details.relatedResources` 仅表示相关输入，并不表示它们全部出错。`details.context` 保留请求时间和宽度，便于复现。

创建动画标题时，可在 `title_add` 中直接指定 `x`、`y`、`width`、`height`，进入动画以最终位置为基准。移动已有动画片段时，在 `clip_update` 顶层传 `translatePositionKeyframes: true`，按基础位置变化量同步平移 X/Y 关键帧；省略或设为 false 时保留已有关键帧绝对坐标。该选项不能与显式替换 `patch.keyframes` 同时使用。

`focus_region` 的 `duration` 表示放大时间，`holdDuration` 与 `returnDuration` 分别表示停留和恢复时间；省略恢复时间时保持放大。`maxScale` 默认 3，`strength` 可调整强度。已有位置或缩放曲线需明确设置 `replaceExisting: true` 才能替换；聚焦生效期间存在动态旋转时会提示冲突。

`audio_balance` 接受人声 `speechTrackIds`、音乐 `musicTrackIds`，可分别启用 `normalize` 与 `ducking`。默认目标 -16 LUFS、真峰值上限 -1 dBTP、音乐压低 12 dB，进入 0.15 秒、恢复 0.6 秒；短停顿合并以避免音乐忽大忽小。返回每段实测响度、调整后预计响度和受峰值或音量上限限制的情况。音乐按人声片段区间压低，不检测片段内部的停顿；手动音量曲线受到保护，自动生成的曲线可重新计算。

`timeline_batch_edit` 只接受工具清单中的同步工程编辑操作，最多 100 项；可先 dryRun，带 expectedRevision 校验，任何一项失败都不会写入部分修改，成功后共用一个撤销步骤。`project_snapshot` 保存包含素材的命名版本，可比较、恢复、删除；本地最多 100 个版本、总容量 1 GiB，恢复也可撤销。

文字识别引擎与中英文文字模型随应用提供。语音识别使用独立离线模型，首次通过 `audio_transcribe` 查询状态并主动下载；支持逐句和基于模型 token 的逐词时间戳，识别结果仍需人工核对。配音时长计划为估计值，会明确标注估计区间，不作为实际合成时长。

导出检查分别报告工程结构检查和所选媒体范围。开启 analyzeMedia 后，会真实渲染并解码该范围，列出黑场、峰值风险及其他证据；黑场可能是正常设计，只作为待检查项。低清局部检查不能代替完整成片核验。

锁定轨道遵守界面相同的编辑限制，需先解除锁定。修改通过项目校验后才提交到界面，并使用现有撤销历史；删除素材引用不会删除原文件。录屏和麦克风采集不属于这些编辑工具，仍由用户在界面主动启动并完成系统授权。

## 共享 AI 模型与图像、歌曲生成

`open_media_ai_status` 返回主应用的统一模型目录，已有配音、视频模型继续使用原安装，图像与歌曲工作区使用同一份下载和任务状态。下载或修复先取得用户对许可和体积的明确同意，再提供 `modelId` 与 `acceptedLicense: true`。生成不会隐式下载。旧配音、视频工具继续兼容。

模型安装、修复和生成沿用统一 MCP 异步响应：先取得 `jobId`，通过 `open_media_job_get` 查询阶段与真实进度，通过 `open_media_job_cancel` 取消。`ai_status`、项目读取和任务查询在忙碌期间可用；其他写操作被阻塞时，错误包含阻塞任务的类型、ID 和查询／取消链接。

图像与歌曲生成的 `destination` 默认是 `generated`，只把结果保留在本地全局任务历史，不修改工程。`assets` 将结果加入工程素材；`timeline` 同时插入轨道。需要写入工程时建议传入最新 `expectedRevision`，全部成功后才一次提交，可以整体撤销。失败、取消或项目版本变化不会留下部分片段。仅生成结果中的素材 ID 尚不属于当前工程，不能直接用于只接受工程素材的编辑工具。

图生图使用已导入工程的 `inputAssetId`，只接受图片，不能提交本地路径、下载地址或伪造素材对象。它表示参考图片重绘，不等同于指令式图片编辑。图片宽高为 256–2048 范围内的 16 倍数。下面的请求会从第 3 秒插入一张展示 5 秒的图片；省略 `trackId` 时新建视频轨道：

```json
{
  "modelId": "z-image-turbo",
  "prompt": "深蓝背景中的抽象玻璃雕塑，柔和轮廓光，留出标题空间",
  "width": 1024,
  "height": 576,
  "destination": "timeline",
  "insert": { "start": 3, "duration": 5 },
  "expectedRevision": 7
}
```

快速图像模型默认 9 步，`guidance` 只能为 0，不支持负面提示词。另一图像模型默认 50 步，`guidance` 对应真实的提示词引导强度。GPU 优先，具体设备、内存要求和回退提示以模型状态与任务信息为准；低内存模式不代表系统内存无需容纳完整权重。

歌曲生成默认 30 秒，支持 10–600 秒；建议先尝试短片段。有歌词时默认生成人声歌曲，无歌词时默认纯音乐。显式 `instrumental: true` 不能同时填写有效歌词。快速音乐模型默认 8 步且 `guidance` 只支持 1，另一模型默认 50 步和强度 7。下面的请求生成纯音乐，并插入音频轨道：

```json
{
  "modelId": "ace-step-1.5-turbo",
  "prompt": "安静的钢琴与柔和弦乐，舒缓的纪录片配乐，无人声",
  "instrumental": true,
  "seconds": 30,
  "bpm": 80,
  "destination": "timeline",
  "insert": { "start": 0 }
}
```

生成结果包含 `nativeJobId`。全局原生任务（包括界面任务）使用 `open_media_ai_job_get` 和 `open_media_ai_job_cancel`；MCP 包装任务使用原响应给出的 `open_media_job_get` 和 `open_media_job_cancel`，两种 ID 不混用。原生任务查询是同步快照，是否完成看 `state`，不是该次查询的 `final` 字段。素材响应只包含名称、尺寸、时长等元数据，不暴露本地路径或内部媒体地址。

## 本地视频生成

视频生成模型按需下载，当前仅支持 Apple 芯片 Mac；其他平台的状态查询会明确返回 `supported: false` 和原因。先调用 `open_media_video_generation_status` 查看模型大小、运行时和许可地址。下载前需取得用户对模型许可和下载的明确同意，再调用 `open_media_video_model_download`，必须包含 `acceptedLicense: true`。模型文件与执行程序均由本机按照固定清单验证，接口不接受任意运行时下载地址或命令。

```json
{
  "modelId": "h3-base-fl2va",
  "acceptedLicense": true
}
```

下载和生成都返回统一异步任务，用 `open_media_job_get` 获取阶段和进度，或 `open_media_job_cancel` 取消；模型状态、项目查询和任务查询在处理期间仍可用。只有模型与运行时完成校验，才能开始生成，不会隐式下载或接受许可。

`open_media_video_generation_start` 支持四种方式。默认 512 × 512、每镜 1 秒、20 步和低内存模式；宽高必须是 32 的倍数且不小于 256，像素总数不能超过 1344 × 768。每镜可请求 1–15 秒，实际帧数由模型取整，插入时间线使用真实生成时长。

| mode | 输入 | 模型 |
| --- | --- | --- |
| `prompt` | 顶层 `prompt`、可选 `seconds` | `h3-base-fl2va` |
| `image` | 提示词，加 `firstFrameAssetId` 或 `lastFrameAssetId` | `h3-base-fl2va` |
| `reference` | 提示词，加 `references` 中已有图片、视频或音频的 `assetId` 和 `kind`；至少有图片或视频 | `h3-base-ref2va` |
| `storyboard` | `shots`，最多 20 镜；每镜包含 `prompt`、可选 `title`、`seconds`、首尾帧素材 ID | `h3-base-fl2va` |

参考模式最多 12 个素材，其中图片最多 9 张、视频最多 3 段；音视频每段 2–15 秒，视频和音频各自累计最多 15 秒、音频最多 3 段。视频的 `includeAudio: true` 会计入音频限制；此时未提供 `seconds` 默认 2 秒，明确请求过短时会返回错误（要求实际生成至少 56 帧）。首尾帧与参考模式不能混用。所有素材须先导入当前工程，只接受工程 `assetId`，不接受文件路径、外部 URL 或伪造的素材对象。

下面的分镜请求会完成两镜及合并视频，并从第 5 秒开始逐镜插入新建的视频轨道：

```json
{
  "modelId": "h3-base-fl2va",
  "mode": "storyboard",
  "width": 512,
  "height": 512,
  "shots": [
    { "title": "开场", "prompt": "深蓝背景中的玻璃球缓慢旋转，柔和边缘光", "seconds": 2 },
    { "title": "收尾", "prompt": "玻璃球中的金色光点散开，镜头缓慢后退", "seconds": 2 }
  ],
  "joinShots": true,
  "insert": { "start": 5, "mode": "shots" },
  "expectedRevision": 7
}
```

省略 `insert` 只加入项目素材。`insert.trackId` 可指定未锁定的视频轨道；省略时新建“生成视频”轨道，`insert.mode: "combined"` 插入合并视频而非逐镜插入。成功结果包括 `assetIds`、可选 `combinedAssetId`、`clipIds`、`trackId` 和 `nativeJobId`，后续可通过已有素材、预览和剪辑工具使用。

全部镜头完成后才原子写入工程，共用一个撤销步骤。取消、失败或工程版本变化都不会插入部分结果；已完成的本地生成文件保留在视频生成历史，便于稍后取用。任务完成后，当前会话仍可通过 `open_media_job_get` 读取结果。生成任务不会自动导出整个剪辑工程。

## 项目版本和任务

`open_media_project_get` 返回当前 `projectId` 和 `revision`。写操作建议带上 `expectedRevision`，防止把基于旧画面的修改应用到用户刚编辑过的工程。版本不匹配时工具会返回错误，应重新读取工程并据此重试，而不是直接去掉版本参数。

导入、打开、新建、保存、添加内置素材、配音、媒体分析、取帧、预览、批量编辑、版本操作、视频模型下载、视频生成、导出检查和导出采用异步任务。上传的 begin／chunk／status／abort 以及 artifact_read 直接返回协议结果，commit 返回导入任务。调用返回相同值的 `id` 和 `jobId`，查询及取消工具的参数名为 `id`。用 `open_media_job_get` 查询，或在“处理任务”中查看进度；`state` 为 `running`、`completed`、`failed` 或 `cancelled`。只有 `completed` 表示操作完成，仍应检查 `result`；创建任务本身不代表已经生成音频或视频。配音提供当前阶段、完成数量及可用的百分比，其他任务按实际能力返回进度。

任务响应保留原有 `id/state/result`，同时明确返回以下字段。同步操作返回 `responseType: "result"`、`execution: "synchronous"`、`final: true`；为保持兼容，任务列表仍是数组，其中每个任务都包含完整查询契约。

`tools/list` 中每个工具的 `_meta["openmedia/execution"]` 说明同步、异步或随 action 变化的执行方式，并提供查询工具、结果字段与终止状态；客户端可在调用前读取这份契约。

| 字段 | 含义 |
| --- | --- |
| `responseType: "job"`、`execution: "asynchronous"` | 本次结果是异步任务 |
| `jobId`、`status` | 与原字段 `id`、`state` 相同 |
| `final` | 是否已经结束；失败和取消也属于结束，不能当作成功 |
| `poll` | 可直接调用的 `{tool, arguments}` 查询信息 |
| `pollAfterMs` | 建议查询间隔；结束后为 0 |
| `cancel` | 可直接调用的取消信息；不可取消或已结束时为 null |

调用工具时，全局悬浮状态条显示当前工具名称，短调用完成后短暂显示结果状态。长任务继续显示“MCP 正在处理”、任务名称、阶段和可用的进度，并提供查看任务和取消入口。状态条和展开的任务详情不参与编辑器布局，文字或进度更新不会推移画布与时间线。

同一工程同时只运行一个需要占用编辑状态的自动化任务；查询进度和取消仍可进行。长任务的提示会说明暂时锁定编辑，结束后自动恢复；普通状态查询不额外锁定工程；取帧、媒体分析及预览任务使用稳定的工程快照并暂时锁定编辑。异步编辑在写入前再次校验工程和版本，避免将旧任务结果加入新的工程。批量配音完成后统一提交时间线；中途失败或取消时不提交部分配音。

写操作遇到阻塞时返回 `code: "PROJECT_BUSY"`、`retryable: true` 和 `blockingJob`，包含阻塞任务的 `jobId`、`kind`、工具名称、阶段及 `poll/cancel` 信息。客户端应先查询或取消该任务，再用最新工程版本重试；若阻塞来自本地交互且没有任务标识，则 `jobId` 和查询／取消入口为 null，不会虚构可取消任务。

关闭服务会拒绝新的调用，并取消尚可取消的自动化任务。已经完成的编辑保留在工程中；进入最终文件写入阶段的任务会显示不可取消。关闭 M 弹窗不会停止服务。模型下载和修复使用独立状态：`download`、`repair` 接受后返回 `responseType: "model-status"` 与 `final: false`，通过响应的查询／取消链接调用 `open_media_speech_model` 的 `action: "status"` 或 `action: "cancel"`，不使用剪辑任务 ID。

工具参数错误或执行失败会通过 JSON-RPC 错误或 `isError: true` 返回；客户端应读取具体说明。编辑器请求等待上限为 30 秒，长操作通过任务查询继续跟踪。没有收到确认时，先重新读取工程或任务状态，避免盲目重复执行新增、删除、导出等操作。

## 调用示例

下列为独立的 `tools/call` 请求。ID、工程版本和文件路径需要替换为当前运行环境中的真实值；不要将多个请求包装成 JSON 数组发送。

读取工程，获得轨道、片段 ID 和最新 `revision`：

```json
{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"open_media_project_get","arguments":{}}}
```

假设刚读取的 `revision` 为 7，将画面改成竖屏，预览同步更新：

```json
{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"open_media_project_update","arguments":{"patch":{"width":1080,"height":1920,"fps":30},"expectedRevision":7}}}
```

在已有文字轨道添加字幕；成功后使用响应中的新版本执行下一步：

```json
{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"open_media_text_add","arguments":{"trackId":"text-track-id","text":"用 Open Media 完成录制、剪辑与配音。","start":2,"duration":5,"style":{"fontSize":52,"color":"#ffffff","background":"rgba(0,0,0,0.6)","textAlign":"center","textVerticalAlign":"bottom"},"expectedRevision":8}}}
```

先调用 `open_media_speech_voices` 确认音色已就绪，再为指定字幕生成配音。`voiceId` 使用查询结果，不填写模型显示名称：

```json
{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"open_media_speech_generate","arguments":{"clipIds":["subtitle-clip-id"],"voiceId":"f5_zh_female","rate":1,"alignText":true,"expectedRevision":9}}}
```

查询返回的任务标识，不给轮询附加旧的工程版本：

```json
{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"open_media_job_get","arguments":{"id":"returned-job-id"}}}
```

给靠近 10 秒位置、首尾相接的两个视频片段添加总长 1 秒的淡出淡入转场；实际长度受两侧可用时长限制：

```json
{"jsonrpc":"2.0","id":6,"method":"tools/call","params":{"name":"open_media_transition_add","arguments":{"time":10,"effect":"fade","duration":1,"expectedRevision":10}}}
```

缩放淡入淡出使用 `zoom-fade`，或 `zoom-fade-left`、`zoom-fade-right`、`zoom-fade-up`、`zoom-fade-down` 固定对应边缘。前半段从 100% 缩至 80% 并淡出，后半段从 80% 放至 100% 并淡入；每半段各占转场时长的一半。

通用转场还提供 `iris`（圆形光圈）、`diamond`（菱形开幕）、`blinds`（阶梯百叶）、`flash-white`（柔光闪白）、`defocus`（失焦叠化）、`zoom-through`（推近穿越）、`diagonal`（斜向揭幕）和 `radial`（环弧开幕）。这些效果在画布预览、区间预览、取帧和视频导出中使用一致的时间与几何定义。

碎片与切片转场还提供 `fragment-burst`（碎片爆散）、`fragment-vortex`（旋涡碎片）、`fragment-collapse`（碎片聚拢）、`pixel-dissolve`（像素消散）、`pixel-wave`（像素波浪）、`slice-stagger`（交错横切）、`slice-vertical`（交错纵切）、`checker-flip`（棋盘翻片）、`tile-orbit`（环绕重组）、`glitch-slices`（数字故障）、`zipper-slices`（拉链开幕）和 `stepped-shutter`（阶梯折屏）。效果直接切分原视频画面，以确定的运动规则析出、析入；同一时间点重复预览不改变碎片位置。沿用 `transition_add` / `transition_update`，使用 `transition_parameters_set` 设置缓动和 `scope`（前后两段、仅析出或仅析入），不额外插入素材或改变项目时长。

素材目录搜索“科普”可找到 24 款标注/文字水印及 12 款片头片尾，返回的 `collection: "science"` 标识专题，`editableText` 与 `placement` 分别表示文字编辑能力和默认插入位置。动画中的刻度与图表是视觉示意；需要填写真实数值、来源或结论时，可选择原生文字模板。

使用 `collection: "general"` 可筛出 24 款通用文字布局或 16 款通用片头片尾。文字水印的 `text`、`color`、`background`、`duration`、`watermarkPlacement`、`animation` 均可在添加时设定，之后仍保留为可编辑文字。`animation` 支持 `none`、`fade`、`slide-up`、`slide-down`、`slide-left`、`slide-right`、`push-in`、`pull-back`；入场与退场之间保持稳定阅读。参数不适用于已经编码的图片或视频水印。

```json
{"jsonrpc":"2.0","id":20,"method":"tools/call","params":{"name":"open_media_material_list","arguments":{"kind":"watermark","collection":"general","limit":100}}}
```

```json
{"jsonrpc":"2.0","id":21,"method":"tools/call","params":{"name":"open_media_material_add","arguments":{"kind":"watermark","id":"general-hero-title","start":3,"text":"自定义标题","color":"#edbd72","background":"transparent","duration":5,"watermarkPlacement":"center","animation":"slide-up"}}}
```

片头片尾可指定 `duration`（0.5–30 秒，实际速度须在 0.1–16 倍内）和 `titleLayout`（`center`、`left`、`lower-third`）；目录也返回默认 `titleLayout`。调整时长使用完整背景动画变速，文字与项目后移时长同步。

原生视觉标注现支持 `arrow`、`rectangle`、`highlight`、`mask`、`spotlight`、`blur`、`ellipse`、`brackets`、`double-arrow`、`leader`、`underline`、`check`。`overlay_add` 可选择上述入退场 `animation`；`clip_update.patch.overlay` 可更新完整标注定义，保持可编辑颜色、线宽和几何形状。

先查询片头片尾模板，再使用返回的素材 ID 前插，并编辑标题：

```json
{"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"name":"open_media_material_list","arguments":{"kind":"video_segment","limit":10}}}
```

```json
{"jsonrpc":"2.0","id":8,"method":"tools/call","params":{"name":"open_media_material_add","arguments":{"kind":"video_segment","id":"returned-material-id","placement":"prepend","heading":"我的创作日记","subheading":"从录制到成片","expectedRevision":11}}}
```

## 文件路径和导出

路径指运行 Open Media 的电脑上的绝对路径，父目录必须已经存在，不是客户端电脑上的路径或网络地址。导入使用 `paths`，打开和保存工程使用 `path`，视频导出使用 `outputPath`。

保存工程首次需要指定 `.omedia` 路径。已有保存位置时，省略 `path` 会覆盖当前工程文件，行为与界面“保存”一致；显式指定的其他现有文件默认不覆盖，须提供 `overwrite: true`。新建或打开工程遇到未保存修改时会拒绝，除非明确提供 `discardUnsaved: true`。

```json
{"jsonrpc":"2.0","id":9,"method":"tools/call","params":{"name":"open_media_project_save","arguments":{"path":"/Users/your-name/Movies/创作日记.omedia","expectedRevision":12}}}
```

视频导出尺寸使用当前工程设置，工具没有独立宽高参数。以下路径为示例；其他系统改用对应的本机绝对路径，例如 JSON 字符串 `"C:\\Users\\your-name\\Videos\\成片.mp4"`。

```json
{"jsonrpc":"2.0","id":10,"method":"tools/call","params":{"name":"open_media_export_start","arguments":{"outputPath":"/Users/your-name/Movies/成片.mp4","format":"mp4","quality":"high","expectedRevision":12}}}
```

导出任务完成后，结果包含输出路径、实际编码方式及耗时。现有输出文件同样需要显式 `overwrite: true` 才能覆盖。导入及导出遵守现有媒体处理规则，不把预览成功或任务已受理当作文件导出成功。

## Project video compression

这两个工具复用界面“项目设置 → 工程视频压缩”的任务通道，返回 `jobId`，由 `open_media_job_get` 查询阶段、进度与结果，`open_media_job_cancel` 取消。压缩在全部处理完成并通过版本校验后一次提交；失败、取消或工程版本变化均不替换当前素材。

```json
{"name":"open_media_project_video_compress","arguments":{"mode":"quality","quality":"high","expectedRevision":12}}
```

`mode: "lossless"` 保留解码画面，不接受 `quality`；已压缩的视频不保证还能变小，体积不减时跳过。质量模式在高画质、均衡和小体积之间选择；保持原分辨率与时间轴，重复操作从最初原件开始。结果包含 `processedCount`、`skippedCount`、`sourceBytes`、`outputBytes`、`savedBytes` 及逐项状态。加速收益取决于源编码与工程效果，文件变小不等于所有导出都会提速。

原视频及工作副本都随工程保存，因此工程文件大小可能增加。恢复调用 `open_media_project_video_restore`，可通过 `assetIds` 指定原件或压缩副本，省略时恢复当前时间线使用的全部压缩视频。恢复不会删除任何文件，且可撤销；引用待修改视频的锁定轨道需要先解锁。

## Static frame editing

视频片段右键的“检测静止画面并分割”与 `open_media_clip_split_idle` 使用同一处理流程。默认连续 3 秒的近静止画面会独立成段，并标记为黄色 `repeat`。这是源画面的技术检测：旁白、字幕、背景音乐或持续阅读画面的价值不在判断范围内，所有内容都会保留，其他轨道不移动。右键“片段类型”或 `open_media_clip_classify` 可改回普通类型；一次撤销可恢复整个检测分割。

```json
{"name":"open_media_clip_split_idle","arguments":{"clipId":"clip-id","minDuration":3,"freezeNoiseDb":-60,"expectedRevision":12}}
```

检测仅扫描所选片段的源范围，返回 `sourceIntervals`（源秒数）和 `segments`（时间线秒数、片段 ID、分类与是否被本次检测命中），以及 `repeatCount`、`splitCount`、`repeatDuration`。先按源速度检测，再以裁剪、倍速及变速曲线换算后的时间线时长筛选。没有命中时不修改工程；取消、源文件错误或版本冲突不会留下部分分割。静止区间的切点若会截断已有淡入淡出或缩短转场，会提示先调整效果，整次修改不写入。

```json
{"name":"open_media_clip_classify","arguments":{"clipId":"clip-id","classification":"normal"}}
```
