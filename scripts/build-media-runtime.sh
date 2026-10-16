#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(cd "$(dirname "$0")/.." && pwd)"
work_dir="$repo_dir/.media-runtime"
prefix_dir="$work_dir/prefix"
source_dir="$work_dir/sources"
output_dir="$repo_dir/src-tauri/resources/media"
jobs="${MEDIA_BUILD_JOBS:-4}"
mkdir -p "$prefix_dir" "$output_dir" "$work_dir/logs"
export PKG_CONFIG_PATH="$prefix_dir/lib/pkgconfig"
export PKG_CONFIG_LIBDIR="$prefix_dir/lib/pkgconfig"
export CFLAGS="${CFLAGS:--O2}"
export CXXFLAGS="${CXXFLAGS:--O2}"
export CPPFLAGS="-I$prefix_dir/include ${CPPFLAGS:-}"
export LDFLAGS="-L$prefix_dir/lib ${LDFLAGS:-}"

common=(--prefix="$prefix_dir" --disable-shared --enable-static)
ffmpeg_platform=()
x264_platform=()
vpx_platform=()
assembly=()
case "$(uname -s)" in
  MINGW*|MSYS*)
    common+=(--host=x86_64-w64-mingw32)
    x264_platform+=(--host=x86_64-w64-mingw32)
    vpx_platform+=(--target=x86_64-win64-gcc)
    ffmpeg_platform+=(--target-os=mingw32 --arch=x86_64 --disable-pthreads --enable-w32threads)
    export LDFLAGS="$LDFLAGS -static -static-libgcc -static-libstdc++"
    ;;
  Darwin)
    export MACOSX_DEPLOYMENT_TARGET="${MACOSX_DEPLOYMENT_TARGET:-11.0}"
    vpx_platform+=(--target="$(uname -m)-darwin23-gcc")
    ffmpeg_platform+=(--enable-avfoundation)
    ;;
esac
if ! command -v nasm >/dev/null 2>&1; then
  case "$(uname -m)" in
    x86_64|amd64) assembly=(--disable-asm); vpx_platform=(--target=generic-gnu); ffmpeg_platform+=(--disable-x86asm) ;;
  esac
fi

build_component() {
  local name="$1"
  shift
  printf 'Building %s\n' "$name"
  (cd "$source_dir/$name" && "$@" && make -j"$jobs" && make install) >"$work_dir/logs/$name.log" 2>&1 || {
    tail -n 100 "$work_dir/logs/$name.log"
    return 1
  }
}

printf 'Building zlib\n'
case "$(uname -s)" in
  MINGW*|MSYS*)
    (cd "$source_dir/zlib"; make -f win32/Makefile.gcc -j"$jobs" libz.a) >"$work_dir/logs/zlib.log" 2>&1 || { tail -n 100 "$work_dir/logs/zlib.log"; exit 1; }
    mkdir -p "$prefix_dir/lib/pkgconfig" "$prefix_dir/include"
    cp "$source_dir/zlib/libz.a" "$prefix_dir/lib/"
    cp "$source_dir/zlib/zlib.h" "$source_dir/zlib/zconf.h" "$prefix_dir/include/"
    sed -e "s|@prefix@|$prefix_dir|g" -e 's|@exec_prefix@|${prefix}|g' -e 's|@libdir@|${exec_prefix}/lib|g' -e 's|@sharedlibdir@|${libdir}|g' -e 's|@includedir@|${prefix}/include|g' -e 's|@VERSION@|1.3.1|g' "$source_dir/zlib/zlib.pc.in" > "$prefix_dir/lib/pkgconfig/zlib.pc"
    ;;
  *) build_component zlib ./configure --prefix="$prefix_dir" --static ;;
esac

build_component x264 ./configure --prefix="$prefix_dir" --enable-static --disable-cli --disable-opencl "${x264_platform[@]}" "${assembly[@]}"
build_component libvpx ./configure --prefix="$prefix_dir" --disable-shared --enable-static --disable-examples --disable-tools --disable-docs --disable-unit-tests --enable-vp9-highbitdepth "${vpx_platform[@]}"
build_component opus ./configure "${common[@]}" --disable-doc --disable-extra-programs
build_component libwebp ./configure "${common[@]}" --disable-everything --enable-libwebpmux --enable-libwebpdemux
build_component lame env CFLAGS="$CFLAGS -std=gnu99 -Wno-implicit-function-declaration" ./configure "${common[@]}" --disable-frontend --disable-gtktest --disable-dependency-tracking

build_component ffmpeg ./configure \
  --prefix="$prefix_dir" --disable-shared --enable-static --enable-gpl \
  --disable-autodetect --disable-doc --disable-debug --disable-ffplay \
  --enable-libx264 --enable-libvpx --enable-libopus --enable-libwebp --enable-libmp3lame --enable-zlib \
  --pkg-config-flags=--static --extra-cflags="-I$prefix_dir/include" \
  --extra-ldflags="$LDFLAGS" "${ffmpeg_platform[@]}"

extension=''
case "$(uname -s)" in MINGW*|MSYS*) extension='.exe' ;; esac
cp "$prefix_dir/bin/ffmpeg$extension" "$output_dir/ffmpeg$extension"
cp "$prefix_dir/bin/ffprobe$extension" "$output_dir/ffprobe$extension"
chmod +x "$output_dir/ffmpeg$extension" "$output_dir/ffprobe$extension"
case "$(uname -s)" in
  MINGW*|MSYS*)
    for executable in "$output_dir/ffmpeg.exe" "$output_dir/ffprobe.exe"; do
      if objdump -p "$executable" | grep -Ei 'DLL Name:.*(libgcc|libstdc\+\+|libwinpthread|msys-|libvpx|libopus|libwebp|libmp3lame|libx264|zlib)'; then
        printf 'Media executable depends on an unbundled runtime library: %s\n' "$executable" >&2
        exit 1
      fi
    done
    ;;
  Darwin)
    for executable in "$output_dir/ffmpeg" "$output_dir/ffprobe"; do
      if otool -L "$executable" | tail -n +2 | grep -Ev '^[[:space:]]*(/usr/lib/|/System/Library/)'; then
        printf 'Media executable depends on a non-system dynamic library: %s\n' "$executable" >&2
        exit 1
      fi
    done
    ;;
esac
cp "$source_dir/ffmpeg/config.h" "$output_dir/build-config.h"
cp "$source_dir/ffmpeg/ffbuild/config.mak" "$output_dir/build-config.mak"
node "$repo_dir/scripts/media-runtime.mjs" finalize
node "$repo_dir/scripts/media-runtime.mjs" verify
