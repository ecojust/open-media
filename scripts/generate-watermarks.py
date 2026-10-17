#!/usr/bin/env python3
"""Render original vector-like overlay animations and verify the encoded media.

Requires Python Pillow, ffmpeg and a CJK sans-serif font. This generates media
only; it does not build the application. No remote media is downloaded.
"""

import argparse
import hashlib
import json
import math
import pathlib
import subprocess
from functools import lru_cache

from PIL import Image, ImageDraw, ImageFont


ROOT = pathlib.Path(__file__).resolve().parents[1]
SIZE = (640, 360)
SCALE = 2
FPS = 24
DURATION = 4
INK = '#202039'
WHITE = '#fffaf4'
PURPLE = '#9062f5'
PINK = '#ff6a9c'
GOLD = '#ffd467'
CYAN = '#77dbf4'
IDS = [
    'thumb-pulse', 'star-save', 'follow-pop', 'share-plane', 'heart-wave',
    'celebrate', 'sparkle-trail', 'ripple-rings', 'corner-frame', 'loading-dots',
    'rec-label', 'notice-bubble', 'cursor-click', 'point-arrow', 'focus-circle',
    'chapter-card', 'note-strip', 'thanks-card',
]
FONT_PATH = pathlib.Path('/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc')


@lru_cache(maxsize=32)
def font(size):
    return ImageFont.truetype(str(FONT_PATH), int(size * SCALE))


class Painter:
    def __init__(self):
        self.image = Image.new('RGBA', (SIZE[0] * SCALE, SIZE[1] * SCALE))
        self.draw = ImageDraw.Draw(self.image)

    def box(self, box):
        return tuple(round(value * SCALE) for value in box)

    def points(self, points):
        return [(round(x * SCALE), round(y * SCALE)) for x, y in points]

    def rounded(self, box, radius, color, outline=None, width=3):
        self.draw.rounded_rectangle(self.box(box), radius=round(radius * SCALE),
                                    fill=color, outline=outline, width=round(width * SCALE))

    def ellipse(self, box, color=None, outline=None, width=3):
        self.draw.ellipse(self.box(box), fill=color, outline=outline, width=round(width * SCALE))

    def line(self, points, color, width=4):
        self.draw.line(self.points(points), fill=color, width=round(width * SCALE), joint='curve')

    def polygon(self, points, color, outline=None, width=3):
        self.draw.polygon(self.points(points), fill=color)
        if outline:
            self.line(points + [points[0]], outline, width)

    def text(self, position, text, size, color=WHITE, anchor='mm'):
        self.draw.text(self.box(position), text, fill=color, font=font(size), anchor=anchor)

    def arc(self, box, start, end, color, width=4):
        self.draw.arc(self.box(box), start=start, end=end, fill=color, width=round(width * SCALE))

    def star(self, x, y, radius, color, points=5, rotation=-math.pi / 2, inner=.46, outline=None):
        coords = []
        for index in range(points * 2):
            angle = rotation + math.pi * index / points
            r = radius if index % 2 == 0 else radius * inner
            coords.append((x + math.cos(angle) * r, y + math.sin(angle) * r))
        self.polygon(coords, color, outline, 4)

    def diamond(self, x, y, radius, color):
        self.star(x, y, radius, color, points=4, inner=.24)

    def card(self, box, color=WHITE, radius=28):
        x0, y0, x1, y1 = box
        self.rounded((x0 + 5, y0 + 8, x1 + 5, y1 + 8), radius, INK)
        self.rounded(box, radius, color, INK, 4)

    def finish(self, zoom=1, rotation=0, offset=(0, 0)):
        image = self.image
        if zoom != 1:
            size = (round(image.width * zoom), round(image.height * zoom))
            scaled = image.resize(size, Image.Resampling.BICUBIC)
            image = Image.new('RGBA', self.image.size)
            image.paste(scaled, ((image.width - size[0]) // 2, (image.height - size[1]) // 2))
        if rotation:
            image = image.rotate(rotation, resample=Image.Resampling.BICUBIC)
        if offset != (0, 0):
            translated = Image.new('RGBA', image.size)
            translated.paste(image, (round(offset[0] * SCALE), round(offset[1] * SCALE)))
            image = translated
        return image.resize(SIZE, Image.Resampling.LANCZOS)


def particles(p, phase, center=(320, 180), radius=145, count=8):
    for index in range(count):
        angle = math.tau * index / count + phase * .4
        x = center[0] + math.cos(angle) * radius * 1.25
        y = center[1] + math.sin(angle) * radius * .73
        size = 7 + 4 * math.sin(phase * 2 + index)
        p.diamond(x, y, size, [GOLD, PINK, CYAN, PURPLE][index % 4])


def heart(p, x, y, size, color, outline=None):
    points = []
    for index in range(120):
        angle = math.tau * index / 120
        hx = 16 * math.sin(angle) ** 3
        hy = 13 * math.cos(angle) - 5 * math.cos(2 * angle) - 2 * math.cos(3 * angle) - math.cos(4 * angle)
        points.append((x + hx * size / 32, y - hy * size / 32))
    p.polygon(points, color, outline, 5)


def frame(material, time):
    p = Painter()
    phase = math.tau * time / DURATION
    wave = math.sin(phase)
    beat = math.sin(phase * 2)

    if material == 'thumb-pulse':
        particles(p, phase, radius=153, count=7)
        p.ellipse((201, 62, 441, 302), '#e4d8ff', INK, 4)
        p.polygon([(291, 160), (319, 121), (328, 87), (345, 88), (357, 105),
                   (349, 153), (391, 153), (404, 166), (390, 233), (376, 250),
                   (304, 250), (288, 237)], WHITE, INK, 5)
        p.rounded((251, 160, 293, 249), 10, PURPLE, INK, 4)
        p.ellipse((265, 228, 276, 239), WHITE)
        p.line([(350, 176), (386, 176)], '#b8adc9', 3)
        p.line([(348, 201), (381, 201)], '#b8adc9', 3)
        p.text((322, 281), '赞', 25, INK)
        return p.finish(1 + .045 * beat, rotation=2 * wave)

    if material == 'star-save':
        p.ellipse((181, 47, 459, 325), None, '#c5b4f5', 3)
        p.arc((191, 57, 449, 315), time * 90, time * 90 + 65, PURPLE, 9)
        p.star(320, 172, 101, GOLD, rotation=-math.pi / 2 + wave * .07, outline=INK)
        p.ellipse((286, 152, 295, 165), INK)
        p.ellipse((341, 152, 350, 165), INK)
        p.arc((301, 171, 337, 194), 0, 180, INK, 4)
        particles(p, phase, radius=151, count=6)
        p.card((255, 262, 385, 307), WHITE, 18)
        p.text((320, 283), '收藏', 24, INK)
        return p.finish(1 + .025 * beat)

    if material == 'follow-pop':
        particles(p, phase, radius=180, count=7)
        p.card((98, 107, 542, 253), PURPLE, 52)
        p.ellipse((121, 129, 221, 229), WHITE, INK, 3)
        spin = wave * .2
        for angle in [spin, spin + math.pi / 2]:
            p.line([(171 - math.cos(angle) * 25, 179 - math.sin(angle) * 25),
                    (171 + math.cos(angle) * 25, 179 + math.sin(angle) * 25)], PURPLE, 10)
        p.text((365, 172), '关注一下', 48)
        p.line([(276, 220), (478, 220)], '#d7c3ff', 4)
        return p.finish(1 + .025 * beat, offset=(0, wave * 5))

    if material == 'share-plane':
        p.arc((116, 94, 459, 298), 22, 214, '#b59ae8', 5)
        for index in range(3):
            x = 150 + index * 26 + wave * 7
            p.ellipse((x, 214 + index * 16, x + 10, 224 + index * 16), PURPLE)
        p.polygon([(213, 174), (458, 75), (396, 276), (333, 218), (290, 253), (286, 198)], CYAN, INK, 5)
        p.polygon([(286, 198), (429, 96), (333, 218), (290, 253)], '#c7f0fa', INK, 4)
        p.line([(213, 174), (286, 198)], INK, 4)
        p.diamond(177, 106, 20 + wave * 4, GOLD)
        p.diamond(486, 223, 13 - wave * 3, PINK)
        return p.finish(offset=(wave * 13, -wave * 8))

    if material == 'heart-wave':
        for index in range(3):
            radius = 100 + ((time / DURATION + index / 3) % 1) * 60
            p.ellipse((320 - radius, 179 - radius * .79, 320 + radius, 179 + radius * .79), None, ['#f9b3ce', '#f5c5dc', '#e9c7f9'][index], 4)
        heart(p, 320, 177, 196 + 10 * beat, PINK, INK)
        p.arc((277, 111, 325, 152), 176, 270, '#ffdfed', 10)
        particles(p, phase, radius=168, count=6)
        return p.finish()

    if material == 'celebrate':
        p.polygon([(222, 291), (266, 175), (362, 261)], GOLD, INK, 5)
        p.polygon([(239, 244), (250, 214), (310, 273), (285, 281)], PINK, INK, 3)
        p.line([(282, 187), (292 + wave * 9, 144), (321, 115)], PURPLE, 7)
        p.line([(325, 219), (374, 198 + wave * 5), (408, 204)], CYAN, 7)
        for index in range(19):
            progress = (time / DURATION + index / 19) % 1
            angle = -2.65 + (index % 9) / 8 * 2.25
            distance = 48 + progress * 176
            x = 300 + math.cos(angle) * distance
            y = 213 + math.sin(angle) * distance + 25 * progress * progress
            color = [PINK, GOLD, PURPLE, CYAN][index % 4]
            if index % 3 == 0:
                p.star(x, y, 8, color)
            else:
                p.line([(x, y), (x + math.sin(index + phase) * 14, y + 8)], color, 7)
        return p.finish()

    if material == 'sparkle-trail':
        for index in range(14):
            x = 101 + index * 34
            y = 183 + math.sin(index * .58) * 77
            shimmer = .55 + .45 * math.sin(phase * 2 + index * .8)
            size = (12 + index % 4 * 5) * shimmer
            p.diamond(x, y, size, [GOLD, WHITE, PINK, CYAN][index % 4])
            if index % 3 == 0:
                p.ellipse((x - 34, y + 29, x - 29, y + 34), '#c6afff')
        p.diamond(310, 180, 43 + 7 * beat, GOLD)
        return p.finish()

    if material == 'ripple-rings':
        for index in range(4):
            progress = (time / DURATION + index / 4) % 1
            radius = 45 + progress * 107
            color = ['#d9c6ff', PURPLE, PINK, CYAN][index]
            p.ellipse((320 - radius * 1.2, 180 - radius * .78, 320 + radius * 1.2, 180 + radius * .78), None, color, 3 + (1 - progress) * 4)
        for index in range(5):
            angle = phase + math.tau * index / 5
            x, y = 320 + math.cos(angle) * 187, 180 + math.sin(angle) * 112
            p.diamond(x, y, 10, GOLD if index % 2 else WHITE)
        return p.finish()

    if material == 'corner-frame':
        inset = 10 * wave
        left, right, top, bottom = 103 + inset, 537 - inset, 77 + inset, 283 - inset
        for x, y, sx, sy in [(left, top, 1, 1), (right, top, -1, 1), (left, bottom, 1, -1), (right, bottom, -1, -1)]:
            p.line([(x, y + sy * 48), (x, y), (x + sx * 61, y)], INK, 12)
            p.line([(x, y + sy * 48), (x, y), (x + sx * 61, y)], GOLD, 7)
        p.line([(305, 180), (335, 180)], WHITE, 3)
        p.line([(320, 165), (320, 195)], WHITE, 3)
        p.ellipse((487, 96, 502, 111), PINK if beat > -.2 else '#e5c5d4')
        return p.finish()

    if material == 'loading-dots':
        p.card((130, 119, 510, 241), INK, 56)
        for index in range(5):
            bounce = max(0, math.sin(phase * 2 - index * .75))
            x, y = 205 + index * 57, 184 - bounce * 27
            p.ellipse((x - 17, y - 17, x + 17, y + 17), [PURPLE, PINK, GOLD, CYAN, WHITE][index])
            p.ellipse((x - 11, 219, x + 11, 223), '#55516a')
        return p.finish()

    if material == 'rec-label':
        p.card((129, 117, 511, 243), INK, 25)
        p.ellipse((160, 148, 224, 212), PINK if beat > -.3 else '#773b58')
        p.ellipse((177, 165, 207, 195), '#ffc5d9' if beat > -.3 else '#a76f87')
        p.text((335, 171), 'REC', 60)
        p.rounded((257, 217, 453, 221), 2, '#78738b')
        p.rounded((257, 217, 257 + 196 * (.5 + .48 * wave), 221), 2, PINK)
        return p.finish()

    if material == 'notice-bubble':
        p.card((96, 90, 540, 242), GOLD, 33)
        p.polygon([(395, 240), (438, 277), (447, 239)], INK)
        p.polygon([(400, 237), (434, 268), (441, 237)], GOLD)
        p.ellipse((123, 118, 203, 198), INK)
        p.rounded((158, 134, 168, 170), 4, GOLD)
        p.ellipse((158, 180, 168, 190), GOLD)
        p.text((354, 157), '重点来了', 46, INK)
        p.line([(245, 208), (464, 208)], '#d59539', 4)
        p.diamond(557, 93, 15 + beat * 4, PINK)
        return p.finish(rotation=wave * 1.7, offset=(0, wave * 5))

    if material == 'cursor-click':
        radius = 31 + (time / DURATION * 2 % 1) * 64
        p.ellipse((286 - radius, 120 - radius, 286 + radius, 120 + radius), None, '#c6afff', 5)
        for index in range(5):
            angle = -math.pi + index * math.pi / 4
            p.line([(286 + math.cos(angle) * 60, 120 + math.sin(angle) * 60),
                    (286 + math.cos(angle) * 83, 120 + math.sin(angle) * 83)], GOLD, 6)
        p.polygon([(278, 111), (286, 274), (321, 240), (356, 293), (386, 273), (352, 222), (401, 210)], WHITE, INK, 6)
        p.line([(296, 150), (302, 229)], '#c1b3ed', 5)
        return p.finish(1 + .018 * beat)

    if material == 'point-arrow':
        offset = wave * 14
        points = [(129, 256), (160, 211), (207, 179), (276, 165), (373 + offset, 165)]
        p.line(points, INK, 34)
        p.line(points, GOLD, 24)
        p.polygon([(354 + offset, 102), (483 + offset, 165), (354 + offset, 228)], INK)
        p.polygon([(365 + offset, 116), (465 + offset, 165), (365 + offset, 214)], GOLD)
        p.line([(153, 258), (171, 233)], WHITE, 4)
        p.diamond(145, 137, 19, PINK)
        p.diamond(503, 241, 12 + beat * 4, CYAN)
        return p.finish()

    if material == 'focus-circle':
        p.arc((110, 74, 534, 285), 13, 347, INK, 15)
        p.arc((110, 74, 534, 285), 13, 347, GOLD, 8)
        p.arc((124, 89, 518, 269), 26 + wave * 5, 181 + wave * 5, PINK, 4)
        p.line([(475, 278), (516, 303), (558, 307)], GOLD, 8)
        p.line([(510, 61), (522, 44)], PINK, 6)
        p.line([(541, 79), (561, 71)], PINK, 6)
        return p.finish(1 + .018 * beat, rotation=wave * 1.5)

    if material == 'chapter-card':
        p.card((86, 107, 548, 254), INK, 23)
        p.rounded((86, 107, 112, 254), 12, PURPLE)
        p.rounded((129, 128, 251, 155), 9, GOLD)
        p.text((190, 140), 'HIGHLIGHT', 14, INK)
        p.text((304, 196), '精彩回顾', 49)
        for index in range(3):
            x = 453 + index * 24
            y = 139 + math.sin(phase * 2 - index) * 4
            p.line([(x, y - 9), (x + 10, y), (x, y + 9)], '#c6aaff', 4)
        return p.finish(offset=(wave * 3, 0))

    if material == 'note-strip':
        p.polygon([(100, 121), (540, 121), (521, 150), (540, 181), (520, 214), (540, 243), (100, 243)], INK)
        p.polygon([(94, 113), (534, 113), (515, 142), (534, 173), (514, 206), (534, 235), (94, 235)], '#fff1b3', INK, 4)
        p.rounded((116, 132, 196, 214), 14, '#f3b642', INK, 3)
        p.line([(143, 152), (169, 152)], INK, 5)
        p.line([(143, 172), (169, 172)], INK, 5)
        p.line([(143, 192), (158, 192)], INK, 5)
        p.text((348, 169), '温馨提示', 48, INK)
        p.line([(239, 211), (455 + wave * 13, 211)], '#d8973a', 3)
        return p.finish(rotation=wave * 1.2)

    if material == 'thanks-card':
        particles(p, phase, radius=183, count=8)
        p.card((101, 98, 539, 261), '#e5dbff', 35)
        p.rounded((127, 118, 512, 244), 26, None, '#b896ee', 2)
        p.text((320, 160), '感谢观看', 50, INK)
        p.text((319, 215), 'THANK YOU', 21, '#7851b9')
        p.diamond(144, 212, 13 + beat * 3, PURPLE)
        p.diamond(495, 143, 12 - beat * 3, PINK)
        return p.finish(1 + .018 * beat)

    raise ValueError(material)


def verify(path, codec='h264'):
    probe = subprocess.run([
        'ffprobe', '-v', 'error', '-show_streams', '-show_format', '-of', 'json', str(path),
    ], check=True, capture_output=True, text=True)
    data = json.loads(probe.stdout)
    streams = data['streams']
    assert len(streams) == 1 and streams[0]['codec_name'] == codec, path
    assert (streams[0]['width'], streams[0]['height']) == SIZE, path
    assert abs(float(data['format']['duration']) - DURATION) < .05, path
    assert streams[0]['pix_fmt'] == 'yuv420p', path
    assert streams[0]['r_frame_rate'] == f'{FPS}/1', path
    # Decode every frame to catch damaged files, then verify two actual frames differ.
    subprocess.run(['ffmpeg', '-v', 'error', '-i', str(path), '-f', 'null', '-'], check=True)
    samples = []
    for time in [.25, 1.5]:
        samples.append(subprocess.run([
            'ffmpeg', '-v', 'error', '-ss', str(time), '-i', str(path),
            '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-',
        ], check=True, capture_output=True).stdout)
    assert len(samples[0]) == SIZE[0] * SIZE[1] * 3 and samples[0] != samples[1], path
    return {
        'file': path.name, 'bytes': path.stat().st_size,
        'sha256': hashlib.sha256(path.read_bytes()).hexdigest(),
        'duration': float(data['format']['duration']), 'codec': codec,
        'width': SIZE[0], 'height': SIZE[1], 'framesPerSecond': FPS,
        'audio': False, 'chromaColor': '#00ff00',
    }


def encode_fallback(source, destination):
    """Derive the same animation in a format usable without an H.264 decoder."""
    subprocess.run([
        'ffmpeg', '-v', 'error', '-y', '-i', str(source), '-map', '0:v:0', '-an',
        '-c:v', 'libvpx-vp9', '-b:v', '0', '-crf', '24', '-deadline', 'good',
        '-cpu-used', '2', '-row-mt', '1', '-threads', '2', '-pix_fmt', 'yuv420p',
        '-map_metadata', '-1', '-metadata', 'title=Open Media original overlay',
        str(destination),
    ], check=True)


def main():
    global FONT_PATH
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--font', type=pathlib.Path, default=FONT_PATH)
    parser.add_argument('--output', type=pathlib.Path, default=ROOT / 'public/watermarks')
    parser.add_argument('--only', choices=IDS)
    parser.add_argument('--fallback-only', action='store_true',
                        help='Keep existing MP4/PNG files and regenerate their VP9/WebM alternatives.')
    args = parser.parse_args()
    FONT_PATH = args.font
    if not args.fallback_only and not FONT_PATH.is_file():
        parser.error('Provide an installed CJK sans-serif bold font with --font.')
    args.output.mkdir(parents=True, exist_ok=True)
    records = []
    for material in [args.only] if args.only else IDS:
        path = args.output / f'{material}.mp4'
        poster = args.output / f'{material}.png'
        fallback = args.output / f'{material}.webm'
        if args.fallback_only:
            if not path.is_file() or not poster.is_file():
                raise RuntimeError(f'Existing MP4 and PNG required: {material}')
        else:
            frame(material, .75).save(poster, optimize=True)
            encoder = subprocess.Popen([
                'ffmpeg', '-v', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'rgb24',
                '-s', f'{SIZE[0]}x{SIZE[1]}', '-r', str(FPS), '-i', '-', '-an',
                '-c:v', 'libx264', '-preset', 'slow', '-crf', '17', '-pix_fmt', 'yuv420p',
                '-movflags', '+faststart', '-metadata', 'title=Open Media original overlay', str(path),
            ], stdin=subprocess.PIPE)
            try:
                for index in range(FPS * DURATION):
                    overlay = frame(material, index / FPS)
                    background = Image.new('RGB', SIZE, '#00ff00')
                    background.paste(overlay, (0, 0), overlay)
                    encoder.stdin.write(background.tobytes())
            finally:
                encoder.stdin.close()
            if encoder.wait() != 0:
                raise RuntimeError(f'Encoding failed: {material}')
        record = verify(path)
        encode_fallback(path, fallback)
        record['fallback'] = verify(fallback, 'vp9')
        record['poster'] = {'file': poster.name, 'bytes': poster.stat().st_size,
                            'sha256': hashlib.sha256(poster.read_bytes()).hexdigest()}
        records.append(record)
        print(f'{material}: verified MP4 {record["bytes"]:,} bytes, '
              f'WebM {record["fallback"]["bytes"]:,} bytes', flush=True)
    if not args.only:
        manifest = {
            'schemaVersion': 1, 'license': 'MIT',
            'source': 'scripts/generate-watermarks.py',
            'description': 'Original geometric illustrations and motion designed for Open Media.',
            'materials': records,
        }
        (args.output / 'manifest.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n')
        total = sum(record['bytes'] + record['fallback']['bytes'] + record['poster']['bytes'] for record in records)
        if total > 5 * 1024 * 1024:
            raise RuntimeError(f'Media budget exceeded: {total:,} bytes')
        print(f'{len(records)} animations verified; media total {total:,} bytes', flush=True)


if __name__ == '__main__':
    main()
