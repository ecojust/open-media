# MCP 素材二创

先开启 MCP 服务，再在 MCP 弹窗中开启“素材二创”，选择当前工程素材与视觉风格。每种风格自动附带默认提示词，定义其构图、运动、材质、素材分层方案和检查要求；“创作要求”是用户额外提示，不会替代默认风格。

外部 Agent 读取合并后的 `effectivePrompt`，理解源素材后用代码生成可复用图片、透明图层，以及需要时的独立透明或绿幕特效素材。Agent 将每份素材导入工程并放入独立轨道，使用剪辑工具设置位置、尺寸、时长、动画和声音，最终成片由 Open Media 的时间线合成与导出。

主视频、图片、标题、字幕、装饰和配乐保持独立可编辑，不将完整主画面与装饰预先烘焙成一个视频。代码运行在 Agent 自己的环境中，应用不执行任意代码；开启配置也不会自动发起生成。

## 从素材到轨道

- **选择素材**：按当前工程实际可用图片、视频显示数量，可选择全部视觉素材。搜索显示匹配数，音频与内置包装素材不计入视觉素材数量。
- **自动附加要求**：`workflowPrompt` 提供素材生成与轨道编排流程，`stylePrompt` 提供当前风格及分层方案，`userPrompt` 保留额外要求，`effectivePrompt` 合并三者。切换风格保留用户文本。
- **代码生成素材**：先探测、抽帧和分块读取真实素材。静态底图、纹理、边框、箭头与装饰生成独立 PNG，需要透出底层时保留 alpha；SVG 可用作生成源，但必须栅格化为 PNG 后再回传，MCP 上传不接收 SVG。复杂局部动效可生成独立透明视频或绿幕特效视频，文件中不混入主视频、字幕和配乐。
- **轨道分层**：数组顺序从底层到顶层，`zIndex` 等于下标，从 0 开始，越大越靠上。底图放前面的轨道，原视频与主内容放中间，装饰和文字放后面的轨道；拖动或调用轨道排序工具会同步改变堆叠关系。
- **定位与动画**：图片和固定字幕一样具有独立的时间、位置、尺寸与透明度。常规移动、缩放、旋转、透明度变化、裁切、字幕和转场使用编辑器工具，保留参数以便继续调整。
- **抠像**：绿幕特效作为独立片段添加后，用 `clip_update.patch.chromaKey` 指定实际幕色、相似度、边缘柔化和溢色抑制。先检查编码、透明通道和边缘，避免绿色残边或黑底。
- **检查与成片**：由编辑器读取最终合成帧、渲染短区间预览并检查黑帧、遮挡、字幕与音量；按用户要求调用编辑器导出，不能用网页预览、代码文件或单张海报代替完成的工程。

全部 25 种风格都采用上述流程，并分别给出可生成素材和轨道编排方案。旧的整片预设合成工具不再向 MCP 开放。独立动态图效内部的形变需要修改时可以重新生成该素材，其他轨道仍可直接调整，无须重做完整成片。

## 25 种视觉风格

### 新增 10 种风格

这些风格的提示词描述具体的素材生成、镜头结构、分层方式与检查方法，适用于不同主题的用户素材。Agent 按当前素材、画幅和额外要求生成独立素材，并在编辑器里完成镜头与合成。

| 风格 | MCP 标识 | 画面与运动特点 |
| --- | --- | --- |
| 发布会聚焦 | `product-keynote` | 真实截图和录屏居于舞台中央，从全景推进到功能重点，再定格展示结果。 |
| 证据档案 | `evidence-dossier` | 文档、图片与录屏形成档案台，原文局部放大、划线和来源标注随镜头对应。 |
| 双屏对照 | `split-compare` | 成对素材统一尺度与动作起点，以滑动分界、同步推近和成对标注呈现差异。 |
| 节拍声场 | `lyric-spectrum` | 主素材配合真实音频包络、波形或频谱；有歌词时按时间揭示，没有音频时使用明确的固定节奏。 |
| 银幕胶片 | `vintage-film` | 胶片片门、颗粒与柔和漏光串联真实照片和视频，缓慢推进后保留稳定阅读时间。 |
| 路线漫游 | `route-atlas` | 路线逐段展开，镜头沿路径经过素材站点，最后拉回全程；位置未知时使用抽象路径示意。 |
| 微距解构 | `macro-lens` | 全景保留主体，局部放大窗与取样框对应，通过整体—局部—整体的结构解释细节。 |
| 视差长镜 | `parallax-panorama` | 前景、主体与背景沿连续镜头路径形成不同幅度的运动；没有可靠分层时采用整幅素材轻推移。 |
| 数据叙事 | `data-story` | 源素材中的可核对数据逐步转化为图表，数值、图形与标签同步变化并保留共同尺度。 |
| 工程分解 | `blueprint-explode` | 已知部件或界面模块沿装配轴展开、标注并复位；只有真实几何和渲染条件具备时才进行三维剖切。 |

下图是这 10 种风格的静态设计示意，展示构图和配色方向，不是已渲染的视频帧或最终效果验证。

![10 种素材二创风格的静态设计示意](screenshots/motion-code-style-gallery.png)

### 其他 15 种风格

| 风格 | MCP 标识 | 画面与运动特点 |
| --- | --- | --- |
| 纸感手绘 | `paper-ink` | 纸张颗粒、铅笔线框与逐格轻摆，适合手作、生活和温暖叙事。 |
| 等轴卡片 | `iso-cards` | 等轴网格、层叠基座与弹性升起，展示产品模块和信息结构。 |
| 扁平跃动 | `flat-pop` | 大胆色块、圆点与弹性入场，让素材在清晰构图中接力。 |
| 极简线描 | `line-focus` | 细线、圆环与留白，配合轻缓平移和标题揭示。 |
| 柔光立体 | `studio-depth` | 柔光球体、层次阴影和悬浮卡片，形成产品展台的空间感。 |
| 柔形律动 | `shape-rhythm` | 圆弧、胶囊与缩放呼应，以图形节奏连接素材和文字。 |
| 知识贴纸 | `sticker-notes` | 白边卡片、网格和重点标签，适合讲解、步骤和知识总结。 |
| 科技视窗 | `tech-hud` | 精细网格、定位括角与环形标尺，突出数据和操作画面。 |
| 杂志拼贴 | `editorial-collage` | 撕纸、半调点阵与错位叠层，给照片和观点鲜明的版面节奏。 |
| 极光玻璃 | `aurora-glass` | 弥散光斑、透明面板和轻缓漂移，适合科技介绍与视觉展示。 |
| 几何构成 | `geometric-grid` | 圆、方块和网格按节奏错位，强调秩序与色彩对比。 |
| 霓虹复古 | `neon-retro` | 落日光晕、透视网格与霓虹色带，营造复古电子气氛。 |
| 像素节拍 | `pixel-arcade` | 像素边框、阶梯色块与离散步进，适合游戏和轻快记录。 |
| 流彩色团 | `liquid-color` | 色团交错与呼吸缩放，让素材随有机节奏出现。 |
| 活力花字 | `expressive-type` | 醒目标题、放射贴片和弹性强调，适合人物、日常和轻松表达。 |

下图展示同一组示例素材的 15 种风格配色与版式。

![15 种风格的配色与版式](screenshots/motion-style-gallery.png)

上图是风格配色与版式示意。实际工程使用独立素材图层和编辑器关键帧；三维、形变、流彩等复杂局部图效取决于 Agent 可用的生成能力，不能用简单图层移动冒充物理模拟。

## MCP 调用

`open_media_motion_brief_get` 返回 `generationMode: agent-assets-timeline`。`workflow.codeExecution` 为 `external-agent`，`finalComposition` 为 `editor-timeline`，`trackOrder` 为 `back-to-front`，`zIndex` 为 `array-index`；`assetOutputs` 列出图片、透明图片、独立图效视频和绿幕图效，`presetGenerationTool` 为 `null`。`workflow` 同时列出素材读取、生成、导入、轨道编辑、检查和编辑器导出工具。

`motion_brief_get` 自动刷新图像与音乐的本地运行条件，通过 `additionalAssetGeneration` 返回 `checked`、`busy`、默认策略，以及对应能力的 `selectedModelId`、`availability`、`route`、`readyModelIds`。这些已就绪标识最多包含用户当前所选模型，不能改用其他已下载模型。状态未知或检查失败时，先调用 `open_media_ai_status({probeRuntime:true})`；忙碌须等待，不能当成无模型。检测只核对文件与运行环境，不代表实际推理成功。

需要补充图片或音乐时，用户当前所选模型可用就优先通过 `open_media_image_generate`／`open_media_music_generate` 生成；省略 `modelId` 沿用当前选择。使用 `destination: assets` 或 `timeline`，背景音乐设置 `instrumental: true`。配音同样沿用用户当前音色。只有所选模型确认不可用或用户明确要求 Agent 自制，才由 Agent 生成后上传。模型不自动下载或修复，新生成素材不改变用户既有素材选择。

建议按以下顺序组织调用，所有写操作使用当前 `expectedProjectId` 和 `expectedRevision`，每次修改后读取最新版本：

1. 读取 `motion_brief_get` 和 `project_get`，确认 `ready=true`，取得用户选择、风格与 `effectivePrompt`。
2. 使用 `asset_probe`、`asset_get_frame`、`asset_storyboard` 检查内容；使用 `asset_read` 分块读取所选素材，保持 `sourceVersion` 并核对分块哈希。
3. 列出独立素材清单与轨道分层计划，生成需要的底图、透明装饰和局部图效，通过 `asset_upload` 或 `asset_import_url` 导入；异步任务完成后取得真实 `assetId`。
4. 用 `track_add`、`track_reorder` 编排底图、主内容和装饰轨道；用 `clip_add` 分别添加图片、原视频与图效。图片位置尺寸使用项目像素，时长由片段控制。
5. 用 `text_add`／`title_add` 保留可编辑文字，用 `clip_keyframes_set` 设置运动，用 `clip_crop` 裁切，用 `transition_add` 添加转场；需要时用 `clip_update` 配置绿幕抠像。批量操作可先通过 `timeline_batch_edit` 预检查再原子提交。
6. 用 `timeline_get_frame`、`preview_render`、`export_validate` 检查实际融合效果，最后按用户要求调用 `export_start`，由剪辑器生成完整视频。

上述简写均带 `open_media_` 前缀。新上传的透明边框可这样作为独立图片片段放入已有的前景轨道。示例尺寸以 1920 × 1080 工程为例，ID、版本与坐标需替换为实际值：

```json
{
  "name": "open_media_clip_add",
  "arguments": {
    "assetId": "uploaded-frame-image-id",
    "trackId": "foreground-track-id",
    "options": {
      "name": "科技边框",
      "start": 2,
      "trimIn": 0,
      "trimOut": 6,
      "x": 120,
      "y": 80,
      "width": 1680,
      "height": 920,
      "opacity": 1,
      "fit": "contain"
    },
    "expectedProjectId": "current-project-id",
    "expectedRevision": 12
  }
}
```

绿幕图效导入并添加为独立片段后，配置抠像；幕色必须与实际素材一致，参数按预览边缘调整：

```json
{
  "name": "open_media_clip_update",
  "arguments": {
    "clipId": "effect-clip-id",
    "patch": {
      "chromaKey": {
        "enabled": true,
        "color": "#00ff00",
        "similarity": 0.18,
        "blend": 0.08,
        "spillSuppression": true
      }
    },
    "expectedProjectId": "current-project-id",
    "expectedRevision": 13
  }
}
```

风格查询通过 `open_media_motion_style_list` 返回 25 种风格的 `prompt`、配色与标签。各提示词包含具体素材清单、轨道分层方案、标志性运动和检查要求；用户额外要求单独保留。软件不执行 Agent 的代码，也不会用内置整片快捷合成替代分层工程。完整连接方式、批量操作和异步任务约定见 [MCP 文档](MCP.md)。

## 设计研究参考

[动态视觉风格研究](https://vincentwei1021.github.io/mg-styles-15/)：观察版式、色彩、入场、停留与收尾的节奏，形成适用于用户素材的独立实现；未使用参考网站的源码或视频素材。

新增风格研究了公开的代码示例、动画制作提示词与布局文档，提炼为本项目独立编写的创作要求。此次研究以阅读公开资料为主，没有将示例视频观看或性能实测作为验证结果，也没有复制来源项目的代码或媒体素材。

| 研究方向 | 公开资料 | 用于本项目的设计要点 |
| --- | --- | --- |
| 真实素材舞台与镜头 | [舞台制作要求](https://github.com/openfilm/openfilm/blob/main/packages/openfilm/skills/keynote/SKILL.md)、[录屏演示要求](https://github.com/openfilm/openfilm/blob/main/packages/openfilm/skills/screen-demo/SKILL.md) | 原始画面证明标题要点，镜头围绕真实动作与结果移动。 |
| 证据与比较 | [信息图构图要求](https://github.com/jincheng2026/jc-remotion-skills/blob/main/skills/remotion-design-system/references/infographic.md) | 原文、来源和结论分级，双屏保持同等尺度。 |
| 声音驱动动画 | [频谱与波形示例](https://github.com/remotion-dev/skills/blob/main/skills/remotion-best-practices/remotion-markup/audio-visualization.md)、[歌词制作要求](https://github.com/openfilm/openfilm/blob/main/packages/openfilm/skills/lyric-video/SKILL.md) | 读取真实音频能量，所有视觉变化沿同一时间轴。 |
| 胶片叙事 | [照片与视频质感要求](https://github.com/openfilm/openfilm/blob/main/packages/openfilm/skills/vintage-film/SKILL.md) | 保留原始主体，质感变化不遮挡重要信息。 |
| 路线与章节镜头 | [路径运动示例](https://github.com/maplibre/maplibre-gl-js/blob/main/test/examples/animate-a-point-along-a-route.html)、[章节镜头示例](https://github.com/maplibre/maplibre-gl-js/blob/main/test/examples/fly-to-a-location-based-on-scroll-position.html) | 路径按距离推进，镜头跟随并在站点减速。 |
| 局部放大与数据 | [局部放大示例](https://github.com/ManimCommunity/manim/blob/main/docs/source/examples.rst)、[图表插值实现](https://github.com/ManimCommunity/manim/blob/main/manim/mobject/graphing/probability.py) | 取样框与放大窗对应，数值和图形同步插值。 |
| 连续镜头与视差 | [镜头控制文档](https://github.com/motion-canvas/motion-canvas/blob/main/packages/docs/docs/getting-started/camera.mdx)、[分段运动文档](https://github.com/pmndrs/drei/blob/master/docs/controls/scroll-controls.mdx) | 以统一帧时间控制连续镜头、层次速度和显隐。 |
| 展开、复位与剖切 | [部件位置插值实现](https://github.com/zxcwhhyy/spatial-3d-audio/blob/main/spatialModel.js)、[剖切与遮挡示例](https://github.com/mrdoob/three.js/blob/dev/examples/webgl_clipping_stencil.html) | 部件保留原位与展开位置，检查引线、遮挡和复位路径。 |
