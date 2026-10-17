# 内置水印素材

本目录包含为 Open Media 原创绘制的 18 组循环动画及透明背景预览图，随应用离线提供。图案以手绘几何路径、色块、文字及程序化运动组成，没有下载或截取影视、人物、品牌图像等外部素材。

素材与项目代码一同按根目录 `LICENSE` 中的 MIT 许可提供；生成源码位于 `scripts/generate-watermarks.py`。可以在导出的视频中使用这些内置素材。

## 媒体规格

- 动画：640 × 360，4 秒，24 帧/秒，无音轨。
- 编码：H.264 MP4，同时提供相同动画的 VP9 WebM，供不支持 H.264 解码的浏览器使用。
- 背景：纯绿 `#00ff00`，插入时默认开启绿幕抠像。
- 预览：同尺寸透明 PNG，不包含绿底。
- 分类：互动贴纸、装饰动效、提示标注、字幕标签。
- `manifest.json` 记录媒体规格、大小及 SHA-256，用于核对随包文件。

## 重新生成

需要 Python、Pillow、FFmpeg 以及已安装的中文无衬线粗体字体。默认字体位置位于脚本开头，也可以显式指定：

```sh
python scripts/generate-watermarks.py --font /path/to/cjk-bold-font.ttc
```

保留已有 MP4 与 PNG，仅生成或更新备用视频：

```sh
python scripts/generate-watermarks.py --fallback-only
```

备用视频从同名 MP4 转换，不改变内容、尺寸、播放速率或时长。`manifest.json` 中每项素材的 `fallback` 字段记录对应 WebM 的规格和校验值。

字体仅在本机生成时用于文字栅格化，本目录不分发字体文件。当前文字栅格化使用系统安装的 Noto Sans CJK，其字体遵循 SIL Open Font License；生成脚本和图案路径为本项目原创内容。

生成过程仅处理这些素材文件，不构建应用。每种格式的视频生成后都会检查编码、尺寸、时长、帧率、无音轨，全片解码，并检查不同时间的帧确实存在变化。两种格式的视频与预览图合计限制为 5 MiB。
