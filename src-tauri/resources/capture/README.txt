Open Media 原生录制组件

macOS 桌面构建会从 native/CaptureHelper.swift 编译 open-media-capture。
组件仅在用户明确开始录制时采集选定的屏幕、独立窗口或屏幕区域。
录制边框由原生透明窗口显示，并从录制内容中排除。
Windows 使用应用内的原生窗口枚举、区域录制和边框实现。

调试命令：
  open-media-capture sources
  open-media-capture sources --request-permission
  open-media-capture record <配置文件.json> <输出文件.mp4>
  open-media-capture --self-test

record 成功收到并写入第一帧后输出 READY。
通过标准输入发送 q 并换行或关闭标准输入以结束录制并完成文件。
--self-test 验证坐标、区域边界、固定输出尺寸以及实际编码和解码像素，不访问录制设备。
