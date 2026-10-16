Open Media 原生录制组件

macOS 桌面构建会将 native/CaptureHelper.swift 编译为静态归档，并链接到主可执行程序。
安装包不再携带或动态加载单独签名的录屏库，避免主程序与组件签名身份不匹配导致启动失败。
用户选择来源或开始录制时，应用启动同一主可执行程序的 --open-media-capture 模式，
直接调用已链接的录制入口；录制进程与工作台使用同一主程序、应用标识和代码签名身份，
不再以另一个独立可执行录制组件发起权限访问。
组件仅在用户明确开始录制时采集选定的屏幕、独立窗口或屏幕区域。
录制边框由原生透明窗口显示，并从录制内容中排除。
Windows 使用应用内的原生窗口枚举、区域录制和边框实现。

调试命令：
  open-media --open-media-capture sources
  open-media --open-media-capture sources --request-permission
  open-media --open-media-capture record <配置文件.json> <输出文件.mp4>
  open-media --open-media-capture --self-test
  open-media --open-media-capture --capture-smoke-test <新的输出文件.mp4>
  open-media --open-media-capture --capture-smoke-test-no-border <新的输出文件.mp4>

上述 open-media 指应用包内的 Contents/MacOS/open-media。
录制模式使用独立进程保留标准输入、取消和退出清理机制，不启动第二个工作台。

record 成功收到并写入第一帧后输出 READY。
通过标准输入发送 q 并换行或关闭标准输入以结束录制并完成文件。
--self-test 验证主应用身份、坐标、区域边界、固定输出尺寸以及实际编码和解码像素，不访问录制设备。
自测输出应用标识、应用包路径、可执行程序路径和身份模式的 JSON；打包验证要求身份模式为
packaged，应用标识为 com.ecojust.openmedia，避免无法识别应用包时误按开发模式通过。
该自测不会验证真实屏幕录制授权，权限流程仍须在桌面系统中实际选择来源和录制验证。

--capture-smoke-test 是显式触发的真实屏幕采集检查，默认显示录制红框。
它报告系统版本、架构、应用路径、权限预检及采集阶段；收到并编码真实首帧后录制 3 秒，
完成文件并校验时长、画面尺寸、无音轨和两处画面解码，成功才输出 captureSmokeTest: passed。
--capture-smoke-test-no-border 使用相同采集路径，关闭红框用于对照。二者均不采集麦克风，
不覆盖已有文件；授权失败、无显示器、超时或输出无效均返回失败，不能按模拟成功处理。
自动化构建机与用户机器可能使用不同的系统小版本或授权状态，测试报告必须保留这些差异。
临时签名的应用更新后仍可能需要重新授权；长期稳定的授权身份需要稳定的正式代码签名。
