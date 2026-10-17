# 可选配音下载验证资料

本目录记录下载渠道与文件校验的实际结果。测试从当前开发工作区网络发起，**不是中国大陆运营商网络的直连实测**，不能据此保证所有地区、时间和网络都能访问。

## 已完成的下载验证

[download-source-probes.json](download-source-probes.json) 记录了使用 Rust 下载逻辑对 7 个来源进行的真实完整文件下载与 SHA-256 校验，全部通过：

| 来源 | 完整下载的文件 | 大小 | SHA-256 |
| --- | --- | ---: | --- |
| ModelScope、原始模型源、HF Mirror | F5 固定版本 `vocab.txt`，每个来源分别下载 | 13,800 B | `2a05f992e00af9b0bd3800a8d23e78d520dbd705284ed2eedb5f4bd29398fa3c` |
| GitHub、ghfast.top、ghproxy.net、gh-proxy.com | 已发布的 `v0.1.12/SHA256SUMS`，每个来源分别下载 | 869 B | `4676f6f763093940c100081a714f009086e79b0f22304a748a471ff0df1abc25` |

这些结果证明下载逻辑能从上述来源取得正确的小文件；它们不等于已完整下载并验证所有大模型或新的运行包。

[optional-speech-mirror-audit.json](../../scripts/optional-speech-mirror-audit.json) 保存了 2026 年 10 月 17 日的另外 45 次 HTTP 核验：

- 18 个模型文件各验证 ModelScope 与 HF Mirror 两条路径，共 36 次请求。
- 已发布的校验文件、54 MB 声码器及 650 MB 源码归档各验证 3 个 GitHub 镜像，共 9 次请求。
- 其中 27 次读取完整小文件并核对 SHA-256，18 次只读取大文件前缀并检查响应长度；大模型完整 SHA-256 另外与固定版本的仓库元数据核对。
- 19 组文件映射中，不同镜像返回的完整小文件或所读取的大文件前缀一致。证据未保存会过期的签名跳转地址。

HF Mirror 的大权重请求在本次测试中跳转到了海外模型 CDN，因此下载目录优先使用提供独立文件分发的 ModelScope，并保留其他来源回退。三个 GitHub 镜像也可能随时间变化；其中一个曾忽略 Range 请求并返回 HTTP 200，下载方必须正确处理从头读取的情况。

## 新运行包的发布后核验

2026 年 10 月 17 日，独立的[可选配音运行组件 v1](https://github.com/ecojust/open-media/releases/tag/speech-runtime-v1) 完成发布后核验。它是按需下载的运行组件预发布包，不是应用安装包。

| 平台 | 压缩包大小 | 解压后大小 | 下载路径结果 |
| --- | ---: | ---: | --- |
| macOS ARM64 | 229,466,785 B | 833,310,647 B | 原站及 3 个镜像全部通过 |
| macOS Intel | 335,981,482 B | 1,212,713,611 B | 原站及 3 个镜像全部通过 |
| Windows x64 | 291,456,476 B | 985,590,814 B | 原站及 3 个镜像全部通过 |

本次共实测 12 条路径，均返回 HTTP 206，读取的 4096 字节与原始发布文件前缀一致，响应总长度与固定压缩包大小一致。通过的镜像为 `ghfast.top`、`ghproxy.net`、`gh-proxy.com`；每个平台的实际地址已写入 [runtime-metadata.json](runtime-metadata.json)，供下载目录生成脚本使用。

可复查的原始资料：

- [runtime-published-metadata.json](runtime-published-metadata.json)：原始发布元数据，保留下载字节；完整 SHA-256 为 `b0498939380ad8d4f9c48a13d66a64cb96de313543fbb34b2faa2fc8a25e3a98`。
- [runtime-published-SHA256SUMS.txt](runtime-published-SHA256SUMS.txt)：原始发布校验清单，保留下载字节；完整 SHA-256 为 `ea7adc3cfad0d3210d0c02100970b98acaac7516e0f28cfa9d435f49662f45ff`。
- [runtime-publication-evidence.json](runtime-publication-evidence.json)：发布状态与服务端附件摘要。实际下载的元数据、校验清单和 Windows 来源说明均与发布器预先提供的摘要及服务端摘要匹配；元数据中的三个 ZIP 大小与摘要也与校验清单及服务端记录一致。
- [runtime-mirror-evidence.json](runtime-mirror-evidence.json)：12 次真实 HTTP 探测结果，保留状态、范围、长度和前缀摘要，不保留会过期的签名地址。
- [windows-validation-source.json](windows-validation-source.json)：Windows 运行组件与应用调用验证的独立来源说明。

三个运行组件均来自固定源码 `6d72c6e5347a553733c214c3e32f568db46cee43`。macOS 的真实语音合成、断网运行、路径移动、应用调用及文件完整性检查见[三平台验证任务](https://github.com/ecojust/open-media/actions/runs/39056847155)中的两个成功任务；Windows 对应[恢复验证任务](https://github.com/ecojust/open-media/actions/runs/39060595430)。Windows 运行组件源码保持相同，应用调用修正来自 `affdff1bd54f6577694f95dc8b7c0c159eeff31c`，两项来源分别记录。附件发布前的完整 ZIP 与文件清单重验见[组件发布任务](https://github.com/ecojust/open-media/actions/runs/39063477755)。

[optional-speech-runtime-mirrors.py](../../scripts/optional-speech-runtime-mirrors.py) 用于核验真实发布的三平台运行包。它先验证输入 `runtime-metadata.json` 的完整 SHA-256，再分别探测每个平台的原始 ZIP 地址及 3 个镜像，每条路径最多读取 4096 字节。

HTTP 206 必须返回与该平台固定文件大小一致的 Content-Range；忽略 Range 的 HTTP 200 必须提供正确的完整 Content-Length。镜像前缀还必须与原始发布文件一致。只有每个平台都至少有一个镜像通过时，脚本才输出带 `mirrors` 的新元数据；各平台原有的完整 SHA-256、文件大小、入口及验证信息均保留。

```bash
python scripts/optional-speech-runtime-mirrors.py \
  --metadata /path/to/runtime-metadata.json \
  --sha256 <该元数据文件预先确认的完整SHA256> \
  --output /path/to/runtime-metadata-with-mirrors.json \
  --evidence /path/to/runtime-mirror-evidence.json
```

原站在当前网络不可访问时，可增加 `--archives /path/to/original-archives`，目录内放置元数据指向的三个原始 ZIP。脚本会逐个完整读取本地 ZIP，核对其大小与 SHA-256 后，使用该副本的前缀作为镜像对照。未通过完整校验的本地文件不能充当基准。

前缀探测仅验证下载路径的可用性和一致性。应用安装时仍须完整校验每个运行包的大小与 SHA-256，以及解压后清单和文件的完整性。上述结果反映测试时当前网络的可访问情况，不等于中国大陆各运营商或今后所有网络均可直连。
