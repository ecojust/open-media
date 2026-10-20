#!/bin/bash
# Restore only the omitted configuration in an existing pinned model installation.
set -euo pipefail

app_data="${1:-$HOME/Library/Application Support/com.ecojust.openmedia}"
revision='42ed227ee7df40d41602854ae760620d6eb651fe'
expected='3edd2cdd1ebc823c868be55ef917e1b3b8a398fde4d3150dae44a3bf05d9f627'
temporary=''
trap 'if [ -n "$temporary" ]; then rm -f "$temporary"; fi' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

if [ ! -d "$app_data/video-generation/models" ]; then
  echo '未找到已安装的视频模型。此脚本只补配置，不下载模型权重。' >&2
  exit 1
fi
models_root="$(cd "$app_data/video-generation/models" && pwd -P)"
found=0
for model in h3-base-fl2va h3-base-ref2va; do
  for family in FL2VA Ref2VA; do
    directory="$models_root/$model/$revision/$family/video_vae"
    [ -f "$directory/source/model.safetensors" ] || continue
    directory="$(cd "$directory" && pwd -P)"
    case "$directory/" in
      "$models_root/"*) ;;
      *) echo '模型配置目录位于模型存储范围之外，已停止。' >&2; exit 1 ;;
    esac
    target="$directory/config.json"
    found=$((found + 1))
    if [ -L "$target" ]; then
      echo "配置文件是符号链接，已停止：$target" >&2
      exit 1
    fi
    if [ -e "$target" ]; then
      if [ -f "$target" ] && [ "$(shasum -a 256 "$target" | awk '{print $1}')" = "$expected" ]; then
        echo "配置已正确：$model / $family"
        continue
      fi
      echo "已有配置与固定版本不一致，未覆盖：$target" >&2
      exit 1
    fi
    temporary="$(mktemp "$directory/.open-media-vae.XXXXXX")"
    verified=0
    for origin in https://huggingface.co https://hf-mirror.com; do
      url="$origin/MiniMaxAI/MiniMax-H3/resolve/$revision/$family/video_vae/config.json"
      if curl --fail --location --silent --show-error --proto '=https' --proto-redir '=https' \
        --connect-timeout 15 --max-time 60 --max-filesize 65536 "$url" --output "$temporary"; then
        if [ "$(shasum -a 256 "$temporary" | awk '{print $1}')" = "$expected" ]; then
          verified=1
          break
        fi
        echo '下载内容校验不通过，正在尝试备用来源。' >&2
      fi
    done
    if [ "$verified" -ne 1 ]; then
      echo '配置下载失败或校验不通过，原有模型文件未修改。' >&2
      exit 1
    fi
    chmod 644 "$temporary"
    mv "$temporary" "$target"
    temporary=''
    echo "已补齐配置：$model / $family"
  done
done
if [ "$found" -eq 0 ]; then
  echo '未找到此固定版本的已安装视频权重，未修改任何模型。' >&2
  exit 1
fi
echo '配置检查完成，原有模型权重保留。重新打开应用后可再次生成。'
