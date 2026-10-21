# 风格成片

将项目中的图片、视频与每镜文字组合成带统一配色、版式和动画节奏的短片。生成结果直接加入当前工程，素材、标题、说明、装饰、标志和音乐保留为可编辑的轨道与片段，可以继续调整位置、时长、关键帧和音量。

合成使用本地素材与本地绘制的装饰，无须下载生成模型，也不会替用户上传素材到外部网站。画面沿用当前工程的尺寸和帧率，并根据横屏、方形或竖屏调整布局。

## 素材与分镜

- 每次组合 1–16 镜，按场景顺序选择已导入的图片或视频，填写标题、说明与时长。每镜默认 4 秒，可设置为 2–12 秒；视频还可指定素材起点。
- 视频剩余时间不足时，场景按剩余长度缩短，并返回提示。视频保持原速，不自动补帧或重复播放。
- 可调整强调色、背景色、文字颜色，以及舒缓、均衡、轻快三档动画节奏。节奏控制入场速度与运动幅度，不执行音乐节拍识别。
- 可使用项目中的图片作为标志，音频作为背景音乐；音乐按成片时长循环并在首尾淡入淡出。视频原声默认关闭，可选择保留。
- 可追加到现有时间线末尾，或放到开头并整体后移原有片段和标记。向前添加时，需要先解锁含有片段的轨道。

生成不会替换原工程或改名。整次添加作为一次编辑提交，可以一步撤销；后续也可以分别修改生成的片段。

## 15 种风格

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

下图为同一组示例素材在实际时间线预览中生成的画面，展示 15 种风格的配色与版式。

![15 种风格的实际时间线预览](screenshots/motion-style-gallery.png)

这些风格使用二维图层、预绘光影与关键帧组合：等轴与柔光风格不生成三维模型；柔形风格不改变素材的连续轮廓；流彩不执行流体模拟，玻璃也不计算逐帧折射。像素与贴纸装饰保留源素材本身的内容。

## MCP 调用

`open_media_motion_style_list` 同步返回风格目录、配色、标签与能力说明，可用 `search` 搜索。`open_media_motion_compose` 根据场景生成方案或添加轨道，素材 ID 均来自当前打开的工程。外部素材应先通过素材导入工具加入项目。

先查询风格：

```json
{
  "name": "open_media_motion_style_list",
  "arguments": {}
}
```

以下示例先检查两镜科技介绍短片的安排。将占位 ID 替换成当前工程与素材的实际 ID；未准备音乐或标志时，可省略对应字段。

```json
{
  "name": "open_media_motion_compose",
  "arguments": {
    "styleId": "tech-hud",
    "title": "从问题到发现",
    "scenes": [
      {
        "assetId": "image-asset-id",
        "heading": "提出问题",
        "caption": "用一张图片建立主题和观察重点。",
        "duration": 4
      },
      {
        "assetId": "video-asset-id",
        "trimIn": 1,
        "heading": "观察变化",
        "caption": "用实际画面解释过程与结论。",
        "duration": 5
      }
    ],
    "placement": "append",
    "tempo": "balanced",
    "accent": "#5BE2DA",
    "background": "#0A1925",
    "textColor": "#E2F6F5",
    "musicAssetId": "audio-asset-id",
    "musicVolume": 0.2,
    "logoAssetId": "logo-image-asset-id",
    "sourceAudio": false,
    "dryRun": true,
    "expectedProjectId": "current-project-id",
    "expectedRevision": 12
  }
}
```

`dryRun: true` 只校验并返回每镜起止时间、实际时长、配色和提示，不创建素材或修改轨道。确认方案后，用相同参数将 `dryRun` 改为 `false` 执行；工程版本应使用调用时的实际版本。

两种调用都会返回任务 ID，通过 `open_media_job_get({"id":"返回的任务 ID"})` 查询进度与结果，也可用 `open_media_job_cancel` 取消。正式生成完成后，结果包含 `clipIds`、`trackIds`、`sceneCount`、`start`、`duration` 和 `warnings`。提交前会检查当前工程与版本；失败或取消不会留下半成品时间线。

完整连接方式、素材导入和任务约定见 [MCP 文档](MCP.md)。

## 验证

浏览器回归覆盖 15 种风格的横屏、竖屏合成与动画像素变化，以及视频和配乐的真实编码、完整解码。界面测试覆盖分镜排序、前插保护、一次撤销和取消不修改工程。

原生路径使用同一份真实素材工程验证：640 × 360、24 fps、4 秒，包含图片、视频、文字、装饰和配乐。在当前 Linux CPU 测试环境中，编码约 2.86 秒，96 帧完整解码，声音非静音；这是该短测试工程的结果，不代表其他硬件或长片耗时。默认模板使用平移、缩放、逐格运动和普通淡入淡出，避免逐像素旋转计算。

运行 `npm run test:motion-styles` 可复现浏览器验证，默认产物位于临时目录 `open-media-motion-render`。原生复验使用该目录的 `native-project.json`：

```bash
OPEN_MEDIA_MOTION_FIXTURE=/tmp/open-media-motion-render/native-project.json \
  cargo test --manifest-path src-tauri/Cargo.toml --no-default-features --locked --lib \
  browser_composed_motion_style_exports_real_frames_and_audio -- --ignored --nocapture
```

## 设计研究参考

[动态视觉风格研究](https://vincentwei1021.github.io/mg-styles-15/)：观察版式、色彩、入场、停留与收尾的节奏，形成适用于用户素材的独立实现；未使用参考网站的源码或视频素材。
