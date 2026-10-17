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

前缀探测仅验证下载路径的可用性和一致性。应用安装时仍须完整校验每个运行包的大小与 SHA-256，以及解压后清单和文件的完整性。本目录当前不将尚未完成的新版运行包或语音合成验证记录为成功。
