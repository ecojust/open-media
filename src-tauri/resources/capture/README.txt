Open Media 原生录制组件

macOS 桌面构建会从 native/CaptureHelper.swift 编译 libopen_media_capture.dylib，
将其放入应用的 Contents/Frameworks，并在签署外层应用前签署此动态库。
用户选择来源或开始录制时，应用启动同一主可执行程序的 --open-media-capture 模式，
由该模式加载动态库；录制进程与工作台使用同一主程序、应用标识和代码签名身份，
不再以另一个独立可执行录制组件发起权限访问。
组件仅在用户明确开始录制时采集选定的屏幕、独立窗口或屏幕区域。
录制边框由原生透明窗口显示，并从录制内容中排除。
Windows 使用应用内的原生窗口枚举、区域录制和边框实现。

调试命令：
  open-media --open-media-capture sources
  open-media --open-media-capture sources --request-permission
  open-media --open-media-capture record <配置文件.json> <输出文件.mp4>
  open-media --open-media-capture --self-test

上述 open-media 指应用包内的 Contents/MacOS/open-media。
录制模式使用独立进程保留标准输入、取消和退出清理机制，不启动第二个工作台。

record 成功收到并写入第一帧后输出 READY。
通过标准输入发送 q 并换行或关闭标准输入以结束录制并完成文件。
--self-test 验证主应用身份、坐标、区域边界、固定输出尺寸以及实际编码和解码像素，不访问录制设备。
自测输出应用标识、应用包路径、可执行程序路径和身份模式的 JSON；打包验证要求身份模式为
packaged，应用标识为 com.ecojust.openmedia，避免无法识别应用包时误按开发模式通过。
该自测不会验证真实屏幕录制授权，权限流程仍须在桌面系统中实际选择来源和录制验证。
临时签名的应用更新后仍可能需要重新授权；长期稳定的授权身份需要稳定的正式代码签名。
