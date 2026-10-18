# MCP 服务

Open Media 桌面端提供 MCP 服务，供外部 AI 操作当前剪辑工程。视频剪辑顶部“项目设置”左侧的 **M** 按钮打开简洁的服务弹窗，显示连接地址、Token 和“复制配置”按钮，通过服务开关启停。有已认证的客户端连接时，M 按钮显示青紫色流动荧光；连接断开或服务停止后恢复普通样式。自动化任务的进度和取消操作位于“处理任务”中。

服务直接使用界面中的工程、撤销历史和保存位置。工具覆盖项目设置、全部轨道类型、片段编辑、字幕、水印、转场、背景音乐、片头片尾、配音、模型管理和视频导出，共 **46 个**。完整参数以服务的 `tools/list` 或仓库的[工具清单](../src/mcp-tools.json)为准。

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

连接后先发送 `initialize` 和 `notifications/initialized`，再调用 `tools/list`、`tools/call`。请求使用 `Content-Type: application/json`；初始化之后可发送协商好的 `MCP-Protocol-Version`。所有 HTTP 请求都需要 Token。服务返回 JSON 响应，不提供独立 GET 事件流；调用工具的结果同时包含文字 `content` 和可解析的 `structuredContent`。

连接指示依据已认证且仍保持打开的 HTTP 连接，不缓存历史访问。服务支持连接复用，空闲 40 秒后关闭连接；短连接客户端在请求完成后关闭连接时，指示也会恢复普通样式。

服务默认仅监听本机回环地址。服务拒绝不匹配的 Host 和带有浏览器 Origin 的请求；不提供跨域网页接口、任意命令执行或任意远程 URL 下载。

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
| `open_media_job_list` | 列出本次会话的自动化任务 |
| `open_media_job_get` | 查询任务进度、耗时、错误或完成结果 |
| `open_media_job_cancel` | 请求取消仍可取消的任务 |

锁定轨道遵守界面相同的编辑限制，需先解除锁定。修改通过项目校验后才提交到界面，并使用现有撤销历史；删除素材引用不会删除原文件。录屏和麦克风采集不属于这些编辑工具，仍由用户在界面主动启动并完成系统授权。

## 项目版本和任务

`open_media_project_get` 返回当前 `projectId` 和 `revision`。写操作建议带上 `expectedRevision`，防止把基于旧画面的修改应用到用户刚编辑过的工程。版本不匹配时工具会返回错误，应重新读取工程并据此重试，而不是直接去掉版本参数。

导入、打开、新建、保存、添加内置素材、配音和导出采用异步任务。调用返回相同值的 `id` 和 `jobId`，查询及取消工具的参数名为 `id`。用 `open_media_job_get` 查询，或在“处理任务”中查看进度；`state` 为 `running`、`completed`、`failed` 或 `cancelled`。只有 `completed` 表示操作完成，仍应检查 `result`；创建任务本身不代表已经生成音频或视频。配音提供当前阶段、完成数量及可用的百分比，其他任务按实际能力返回进度。

调用工具时，界面显示当前工具名称，短调用完成后短暂显示结果状态。长任务继续显示“MCP 正在处理”、任务名称、阶段和可用的进度，并提供查看任务和取消入口。

同一工程同时只运行一个需要占用编辑状态的自动化任务；查询进度和取消仍可进行。长任务的提示会说明暂时锁定编辑，结束后自动恢复；只读查询不额外锁定工程。异步编辑在写入前再次校验工程和版本，避免将旧任务结果加入新的工程。批量配音完成后统一提交时间线；中途失败或取消时不提交部分配音。

关闭服务会拒绝新的调用，并取消尚可取消的自动化任务。已经完成的编辑保留在工程中；进入最终文件写入阶段的任务会显示不可取消。关闭 M 弹窗不会停止服务。模型下载使用独立状态：通过 `open_media_speech_model` 的 `action: "status"` 查询、`action: "cancel"` 取消，不使用剪辑任务 ID。

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
