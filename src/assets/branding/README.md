# Open Media 图标

`open-media-logo.png` 是根据用户提供的紫色生肖鸡图案，经图像工具整理的透明背景原稿，尺寸为 1254 × 1254 像素。保留黑色与米白色雕刻纹理、紫色圆角底板，不包含名称文字。

应用图标由原稿转换为各平台需要的尺寸和格式：

```sh
./node_modules/.bin/tauri icon src/assets/branding/open-media-logo.png --output src-tauri/icons
```

`public/brand-mark.png` 使用生成的 `128x128@2x.png`，供顶部和信息弹窗显示；`public/favicon.png` 使用生成的 `32x32.png`，供浏览器标签页显示。图标自身带透明边距与圆角，界面无需再次裁切。上述命令只转换图标资源，不构建应用。
