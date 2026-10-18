#!/usr/bin/env python3
"""Render original, silent motion backgrounds for editable opening/ending titles.

Requires Python, NumPy, Pillow, and ffmpeg. No stock artwork, downloaded footage,
fonts, or external media are used. The generated WebM files are application assets.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
from pathlib import Path
import subprocess

import numpy as np
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "src/assets/video-segments"
WIDTH, HEIGHT, FPS, DURATION = 1280, 720, 24, 5
STYLES = [
    ("midnight-orbit", "#071c29", "#174453", "#c6ba81"),
    ("prism-dawn", "#221c52", "#5641aa", "#b2adff"),
    ("gold-horizon", "#16191d", "#342e25", "#c5a562"),
    ("paper-morning", "#f1e7da", "#e3d2bf", "#bc8265"),
    ("azure-grid", "#091a35", "#12365b", "#548cae"),
    ("velvet-curtain", "#2b152b", "#5c344d", "#a16c87"),
    ("ocean-line", "#e7eff0", "#bddbdc", "#7faeaf"),
    ("graphite-frame", "#15191d", "#363b41", "#848d96"),
    ("coral-sunset", "#f0ddd3", "#e7b8a8", "#cd8d7b"),
    ("starlit-finale", "#17172e", "#3a335e", "#a492d6"),
]


def rgb(value: str) -> tuple[int, int, int]:
    return tuple(int(value[index:index + 2], 16) for index in (1, 3, 5))


def background(style: tuple[str, str, str, str], index: int) -> Image.Image:
    yy, xx = np.mgrid[0:HEIGHT, 0:WIDTH].astype(np.float32)
    xx /= WIDTH; yy /= HEIGHT
    blend = np.clip(0.25 * yy + 0.75 * np.exp(-((xx - 0.77) ** 2 / 0.26 + (yy - 0.18) ** 2 / 0.6)), 0, 1)
    low, high = np.array(rgb(style[1])), np.array(rgb(style[2]))
    pixels = low + blend[..., None] * (high - low)
    noise = np.random.default_rng(1729 + index).normal(0, 0.45, (HEIGHT, WIDTH, 1))
    return Image.fromarray(np.clip(pixels + noise, 0, 255).astype(np.uint8), "RGB")


def render(base: Image.Image, style: tuple[str, str, str, str], index: int, time: float) -> Image.Image:
    overlay = Image.new("RGBA", base.size)
    draw = ImageDraw.Draw(overlay)
    accent = rgb(style[3])
    phase = time / DURATION * math.tau
    w, h = WIDTH, HEIGHT
    if index == 0:
        for band in range(8):
            width = 620 + band * 47
            bounds = (-230 - width / 2, -200 - width / 2, -230 + width * 1.6, -200 + width)
            draw.arc(bounds, 13 + time * 5 + band * 5, 123 + time * 5, fill=(*accent, 45 + band * 5), width=1 if band % 3 else 2)
        for star in range(44):
            angle = star * 2.399 + time * 0.028
            radius = 345 + star * 5
            x = w * 0.77 + math.cos(angle) * radius
            y = h * 0.28 + math.sin(angle) * radius * 0.61
            alpha = int(80 + 80 * (0.5 + 0.5 * math.sin(star + time * 1.4)))
            draw.ellipse((x - 1, y - 1, x + 1, y + 1), fill=(*accent, alpha))
        draw.line((w * .2, h * .735, w * .8, h * .735), fill=(*accent, 55), width=1)
    elif index == 1:
        for band in range(6):
            offset = band * 145 + 30 * math.sin(phase * .35 + band)
            draw.polygon([(w - 320 + offset, -120), (w + offset, -120), (580 + offset, h + 80), (470 + offset, h + 80)], fill=(*accent, 12 + band * 5))
            draw.line([(w - 320 + offset, -120), (470 + offset, h + 80)], fill=(*accent, 48), width=2)
        draw.line((100, 110, 260 + time * 18, 110), fill=(*accent, 140), width=2)
        draw.line((w - 320 - time * 18, h - 110, w - 100, h - 110), fill=(*accent, 140), width=2)
    elif index == 2:
        for line in range(15):
            y = h * .78 + line * 16 + 3 * math.sin(time * .5 + line * .3)
            draw.line((0, y, w, y - 40), fill=(*accent, max(12, 65 - line * 4)), width=1)
        draw.line((w * .32, h * .31, w * .68, h * .31), fill=(*accent, 130), width=1)
        for particle in range(70):
            x = (particle * 97.31 + time * (4 + particle % 4)) % w
            y = (particle * 53.7 + time * 6) % h
            alpha = int(40 + 70 * (0.5 + 0.5 * math.sin(time + particle)))
            draw.ellipse((x, y, x + 1.8, y + 1.8), fill=(*accent, alpha))
    elif index == 3:
        x, y = w * .96 + 14 * math.sin(time * .5), h * .16
        draw.ellipse((x - 210, y - 210, x + 210, y + 210), fill=(*accent, 195))
        draw.ellipse((-140, h - 185 + 15 * math.cos(time * .5), 230, h + 185), fill=(117, 137, 119, 115))
        for line in range(11):
            draw.arc((w - 360 + line * 9, -130 + line * 9, w + 50 - line * 9, 280 - line * 9), 40 + time * 8, 220 + time * 8, fill=(245, 237, 226, 180), width=2)
        for line in range(7):
            draw.line((80, 90 + line * 9, 210 + time * 3, 90 + line * 9), fill=(*accent, 80), width=1)
    elif index == 4:
        horizon = h * .7
        for column in range(-10, 12):
            draw.line((w / 2 + column * 42, horizon, w / 2 + column * 170, h), fill=(*accent, 40), width=1)
        for row in range(10):
            distance = ((row / 10 + time * .018) % 1) ** 1.8
            y = horizon + distance * (h - horizon)
            draw.line((0, y, w, y), fill=(*accent, 55), width=1)
        for x, y, sign in ((90, 90, 1), (w - 90, h - 90, -1)):
            draw.line([(x, y + sign * 55), (x, y), (x + sign * 120, y)], fill=(*accent, 180), width=2)
        for cell in range(9):
            x = 95 + cell * 14
            draw.rectangle((x, h - 100, x + 5, h - 95), fill=(*accent, int(50 + 160 * (0.5 + 0.5 * math.sin(time * 2 - cell * .4)))))
    elif index == 5:
        for column in range(17):
            x = column * 88 - 90 + 14 * math.sin(time * .55 + column * .35)
            points = [(x, -1), (x + 50, -1), (x + 90 + 20 * math.sin(time * .4), h + 1), (x + 20, h + 1)]
            draw.polygon(points, fill=(*accent, int(10 + 10 * (0.5 + 0.5 * math.sin(column)))))
            draw.line((x, 0, x + 20, h), fill=(*accent, 30), width=1)
        for radius in (205, 225, 265):
            draw.arc((w - radius, h - radius, w + radius, h + radius), 184 + time * 4, 267 + time * 4, fill=(*accent, 70), width=2)
    elif index == 6:
        for layer in range(5):
            points = [(0, h + 1)]
            for x in range(0, w + 10, 10):
                y = h * (.76 + layer * .055) + 25 * math.sin(x / 250 + time * .42 + layer * .8) + 12 * math.cos(x / 420 - time * .3)
                points.append((x, y))
            points.append((w, h + 1))
            draw.polygon(points, fill=(*accent, 28 + layer * 17))
        draw.ellipse((w - 250, 50 + 8 * math.sin(time), w - 150, 150 + 8 * math.sin(time)), outline=(*accent, 100), width=1)
    elif index == 7:
        progress = min(1, .3 + time / 1.8)
        for inset in (68, 84):
            draw.line((inset, inset, inset + (w - 2 * inset) * progress, inset), fill=(*accent, 100), width=1)
            draw.line((w - inset, h - inset, w - inset - (w - 2 * inset) * progress, h - inset), fill=(*accent, 100), width=1)
            draw.line((inset, inset, inset, h - inset), fill=(*accent, 60), width=1)
            draw.line((w - inset, inset, w - inset, h - inset), fill=(*accent, 60), width=1)
        for line in range(7):
            x = w - 240 + line * 27 + time * 3
            draw.line((x, h - 210, x - 120, h), fill=(*accent, 35), width=2)
        draw.rectangle((w / 2 - 16, 130, w / 2 + 16, 132), fill=(*accent, 180))
    elif index == 8:
        shift = 18 * math.sin(time * .6)
        draw.ellipse((w - 320 + shift, -120, w + 230 + shift, 430), fill=(*accent, 165))
        draw.ellipse((w - 300 + shift, -100, w + 210 + shift, 410), outline=(249, 223, 194, 180), width=2)
        draw.ellipse((-190, h - 260 - shift, 250, h + 180 - shift), fill=(240, 212, 173, 150))
        for line in range(9):
            draw.arc((-200 + line * 12, h - 310 + line * 12, 300 - line * 12, h + 190 - line * 12), 220 + time * 4, 355 + time * 4, fill=(*accent, 80), width=1)
    else:
        for star in range(105):
            x = (star * 163.77 + time * (star % 3 + 1)) % w
            y = (star * 87.31 - time * 3) % h
            size = .6 + (star % 4) * .2
            alpha = int(55 + 120 * (0.5 + 0.5 * math.sin(time * .8 + star)))
            draw.ellipse((x - size, y - size, x + size, y + size), fill=(*accent, alpha))
        for orbit in range(5):
            radius = 340 + orbit * 24
            draw.arc((w * .5 - radius, h * .5 - radius * .68, w * .5 + radius, h * .5 + radius * .68), time * 6 + orbit * 9, 90 + time * 6 + orbit * 9, fill=(*accent, 40 + orbit * 12), width=1)
    return Image.alpha_composite(base.convert("RGBA"), overlay).convert("RGB")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--ids", nargs="*", help="Only regenerate the named designs")
    args = parser.parse_args()
    OUTPUT.mkdir(parents=True, exist_ok=True)
    for index, style in enumerate(STYLES):
        name = style[0]
        if args.ids and name not in args.ids:
            continue
        base = background(style, index)
        command = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{WIDTH}x{HEIGHT}", "-r", str(FPS), "-i", "pipe:0", "-an", "-c:v", "libvpx-vp9", "-b:v", "0", "-crf", "30", "-deadline", "good", "-cpu-used", "3", "-row-mt", "1", "-threads", "2", "-pix_fmt", "yuv420p", "-metadata", "comment=Original Open Media motion background", str(OUTPUT / f"{name}.webm")]
        with subprocess.Popen(command, stdin=subprocess.PIPE) as encoder:
            try:
                for frame in range(FPS * DURATION):
                    encoder.stdin.write(render(base, style, index, frame / FPS).tobytes())
            finally:
                encoder.stdin.close()
            if encoder.wait() != 0:
                raise RuntimeError(f"Video encoding failed for {name}")
        # The poster is extracted from the encoded video rather than a separate illustration.
        subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-ss", "2", "-i", str(OUTPUT / f"{name}.webm"), "-frames:v", "1", "-vf", "scale=640:360", "-q:v", "3", str(OUTPUT / f"{name}.jpg")], check=True)
        print(f"{name}: {(OUTPUT / f'{name}.webm').stat().st_size:,} bytes", flush=True)
    records = []
    for name, *_ in STYLES:
        video = OUTPUT / f"{name}.webm"
        if not video.exists():
            continue
        records.append({"id": name, "filename": video.name, "poster": f"{name}.jpg", "width": WIDTH, "height": HEIGHT, "fps": FPS, "duration": DURATION, "size": video.stat().st_size, "sha256": hashlib.sha256(video.read_bytes()).hexdigest()})
    (OUTPUT / "manifest.json").write_text(json.dumps({"author": "Open Media", "license": "MIT", "generator": "scripts/generate-video-segments.py", "items": records}, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
