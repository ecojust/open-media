# 内置水印素材

本目录随应用离线提供 500 个水印，分为互动贴纸、装饰动效、提示标注、字幕标签、可编辑文字五类，每类 100 个。题材涵盖日常、美食、旅行、运动、学习、科技、创作、工作、情感、节日、自然与成长。图案由本项目原创的几何路径、配色、文字和程序化运动组成，不下载或截取外部影视、人物或品牌素材。

素材与项目代码一同按根目录 `LICENSE` 中的 MIT 许可提供，可以用于导出视频。原有 18 个动画的 ID 与文件保持兼容；扩展目录新增 482 个素材。图片类使用透明背景，动画类提供绿幕及自动抠像。

| 类别 | 数量 | 内容 |
| --- | ---: | --- |
| 互动贴纸 | 100 | 5 个原有动画与 95 个独立主题插画，使用双色立体轮廓与精简字标 |
| 装饰动效 | 100 | 5 个原有动画与 95 个主题光轨、粒子、弧线和节奏动效，全部有真实运动 |
| 提示标注 | 100 | 5 个原有动画与 95 个引导线、定位点及高对比场景提示 |
| 字幕标签 | 100 | 3 个原有动画与 97 个编辑式标题、衬线排版和章节标签 |
| 可编辑文字 | 100 | 100 个原生文字模板，保留字体类别、字重、分行、颜色、背景、对齐及尺寸 |

可编辑文字的 PNG 仅用于素材库预览。插入项目后创建可编辑的文字片段，使用 `textTemplate` 保存原文与样式，不会把文字作为固定图片导入。

## 媒体规格

- 画布与海报尺寸：640 × 360；PNG 保留透明背景。
- 动画：4 秒循环，24 帧/秒，无音轨。
- 每个动画同时提供 H.264 MP4 与 VP9 WebM，兼容不同播放环境。
- 动画背景：纯绿 `#00ff00`，插入时默认开启绿幕抠像。
- 新增的 95 个柔光动效同时启用边缘溢色抑制，避免绿色背景污染光晕；原有 18 个动画保持原来的抠像行为。
- 图片与文字模板默认显示 5 秒，可在时间线上调整。
- `manifest.json` 记录原有 18 个动画的规格与 SHA-256。
- `catalog-manifest.json` 记录新增 482 个素材的规格、文件 SHA-256、文字源数据和全部五类的数量。

## 重新生成

需要 Python、Pillow、FFmpeg 以及已安装的中文无衬线粗体字体。原有素材的生成脚本支持指定字体路径：

```sh
python scripts/generate-watermarks.py --font /path/to/cjk-bold-font.ttc
```

扩展目录使用同一原始绘图工具，并需要本机安装下述中文衬线、无衬线字体与等宽字体，生成目录元数据、透明图片及实际动画：

```sh
python scripts/generate-watermark-catalog.py --workers 3
```

默认字体路径对应常见 Linux 字体目录；其他环境可明确指定本机字体文件，粗体和常规字重分别提供，以保持海报与模板字体类别对应：

```sh
python scripts/generate-watermark-catalog.py \
  --sans-regular /path/to/cjk-sans-regular.ttc \
  --sans-bold /path/to/cjk-sans-bold.ttc \
  --serif-regular /path/to/cjk-serif-regular.ttc \
  --serif-bold /path/to/cjk-serif-bold.ttc \
  --mono-font /path/to/mono-regular.ttf
```

`--font` 保留为 `--sans-bold` 的别名；字体文件仅参与本机生成，不复制到应用中。

只更新目录元数据或检查现有媒体：

```sh
python scripts/generate-watermark-catalog.py --catalog-only
python scripts/generate-watermark-catalog.py --verify-only --workers 3
```

生成过程只处理媒体与目录数据，不构建应用。每种视频格式生成后均检查编码、尺寸、时长、无音轨、完整解码和不同时刻的实际画面变化；全部新增海报也检查尺寸、透明背景与内容唯一性。全部素材的媒体体积预算为 45 MiB。

字体只在生成海报或固定标签时用于文字栅格化，本目录不分发字体文件。当前使用系统安装的 Noto Sans CJK、Noto Serif CJK（SIL Open Font License）与 DejaVu Sans Mono（DejaVu 字体许可）；生成脚本与图形路径为本项目原创内容。可编辑文字在使用时由用户系统对应的衬线、无衬线或等宽字体渲染，海报不会添加原生文字模型不支持的投影或描边。
