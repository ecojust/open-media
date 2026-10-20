# Transition Sounds

这 10 个转场音效由本项目使用振荡器、确定性伪随机噪声、滤波与音量包络原创合成，不含外部录音、下载素材或第三方采样，随项目使用 MIT 许可证。

运行 `node scripts/generate-transition-sounds.mjs` 可重新生成相同的 WAV、素材清单与类型目录。生成器固定采样率为 24000 Hz，格式为单声道 PCM16；每段首尾平滑收零，并保留音量余量，便于与视频原声混合。

`manifest.json` 记录每段的时长、字节数、SHA-256 与重音位置。`anchor` 为素材内的秒数，添加到时间线时以此位置对齐视频切点。
