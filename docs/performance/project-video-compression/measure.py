#!/usr/bin/env python3
"""Measure source compression size, full decode, and accurate seeking on a bounded fixture."""
import argparse
import json
import os
import platform
import statistics
import subprocess
import tempfile
import time
from pathlib import Path


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--output', type=Path, default=Path(__file__).with_name('measurements.json'))
    args = parser.parse_args()
    commands = []

    def run(command, *, timeout=120):
        command = [str(item) for item in command]
        started = time.perf_counter()
        result = subprocess.run(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=timeout, check=True)
        return result.stdout, time.perf_counter() - started

    ffmpeg = ['ffmpeg', '-hide_banner', '-nostdin', '-loglevel', 'error']
    version = run(['ffmpeg', '-version'])[0].decode().splitlines()[0]
    with tempfile.TemporaryDirectory(prefix='open-media-compression-') as temporary:
        root = Path(temporary)
        source = root / 'source.mp4'
        static_a = 'color=c=0x202632:s=1920x1080:r=30:d=12,drawgrid=w=160:h=120:t=2:c=0x4b5b72,drawbox=x=100:y=100:w=1000:h=700:c=0x6881ac:t=fill,drawbox=x=140:y=160:w=800:h=40:c=white:t=fill'
        motion = 'testsrc2=s=1920x1080:r=30:d=12'
        static_b = 'color=c=0x152b27:s=1920x1080:r=30:d=12,drawgrid=w=240:h=180:t=2:c=0x649b8c,drawbox=x=600:y=160:w=1000:h=700:c=0x2c8574:t=fill,drawbox=x=680:y=220:w=700:h=50:c=white:t=fill'
        creation = ffmpeg + ['-y', '-f', 'lavfi', '-i', static_a, '-f', 'lavfi', '-i', motion, '-f', 'lavfi', '-i', static_b,
                            '-f', 'lavfi', '-i', 'sine=frequency=330:sample_rate=48000:duration=36',
                            '-filter_complex_threads', '1', '-filter_complex', '[0:v][1:v][2:v]concat=n=3:v=1:a=0[v]',
                            '-map', '[v]', '-map', '3:a', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '12',
                            '-threads', '2', '-g', '300', '-keyint_min', '300', '-sc_threshold', '0', '-pix_fmt', 'yuv420p',
                            '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', source]
        commands.append(creation)
        _, fixture_seconds = run(creation)
        paths = {'source': source}
        metrics = {}
        for quality, crf in [('quality_18', '18'), ('quality_23', '23')]:
            target = root / f'{quality}.mp4'
            command = ffmpeg + ['-y', '-threads', '2', '-i', source, '-map', '0:v:0', '-map', '0:a?', '-c:v', 'libx264',
                                '-preset', 'veryfast', '-crf', crf, '-threads', '2', '-g', '60', '-keyint_min', '60',
                                '-sc_threshold', '0', '-c:a', 'copy', '-movflags', '+faststart', target]
            commands.append(command)
            _, seconds = run(command)
            paths[quality] = target
            metrics[quality] = {'compression_seconds': seconds, 'crf': int(crf), 'gop_frames': 60}

        # The same six timestamps are used in every round. Input-side seeking
        # includes accurate decode to the target frame, not just demuxer seek.
        seek_times = [5.7, 11.3, 17.9, 23.1, 29.5, 34.7]
        for key, path in paths.items():
            metric = metrics.setdefault(key, {'crf': 12, 'gop_frames': 300})
            metric['bytes'] = path.stat().st_size
            metric['size_ratio_to_source'] = metric['bytes'] / source.stat().st_size
            probe = ['ffprobe', '-v', 'error', '-show_entries', 'stream=codec_type,codec_name,width,height,pix_fmt,r_frame_rate,avg_frame_rate,nb_frames,sample_rate,channels:format=duration,size', '-of', 'json', path]
            metric['probe'] = json.loads(run(probe)[0])
            decode = ffmpeg + ['-threads', '2', '-i', path, '-map', '0:v:0', '-an', '-sn', '-f', 'null', '-']
            run(decode)  # Read the entire file once before timed warm-cache rounds.
            commands.append(decode)
            metric['decode_seconds'] = []
            metric['seek_batch_seconds'] = []
            metric['seek_seconds_by_round'] = []
            for _ in range(3):
                metric['decode_seconds'].append(run(decode)[1])
                timings = []
                for timestamp in seek_times:
                    seek = ffmpeg + ['-ss', str(timestamp), '-threads', '2', '-i', path, '-map', '0:v:0', '-frames:v', '1', '-an', '-sn', '-f', 'null', '-']
                    timings.append(run(seek)[1])
                metric['seek_seconds_by_round'].append(timings)
                metric['seek_batch_seconds'].append(sum(timings))
            commands.append(ffmpeg + ['-ss', 'TIMESTAMP', '-threads', '2', '-i', path, '-map', '0:v:0', '-frames:v', '1', '-an', '-sn', '-f', 'null', '-'])
            metric['median_decode_seconds'] = statistics.median(metric['decode_seconds'])
            metric['median_seek_batch_seconds'] = statistics.median(metric['seek_batch_seconds'])
            print(json.dumps({'variant': key, **{k: metric[k] for k in ['bytes', 'median_decode_seconds', 'median_seek_batch_seconds']}}), flush=True)

        output = {
            'environment': {'platform': platform.platform(), 'machine': platform.machine(), 'logical_cpu_count': os.cpu_count(), 'runtime': version},
            'fixture': {'seconds': 36, 'width': 1920, 'height': 1080, 'fps': 30, 'scenes': ['static shape grid, 12 s', 'moving pattern, 12 s', 'different static shape grid, 12 s'], 'creation_seconds': fixture_seconds},
            'protocol': {'rounds': 3, 'cache': 'full decode warm-up per input; no cache flushing', 'seek_times': seek_times, 'threads_per_input': 2, 'hardware_acceleration': False, 'concurrent_application_load': 'not controlled', 'timing_includes_process_startup': True},
            'variants': metrics,
            'commands': [[str(value).replace(temporary, '$WORK') for value in command] for command in commands],
            'limitations': ['Synthetic 36-second footage, not the user project.', 'Measurements exclude timeline compositing, transitions, text rasterization, and final output encoding.', 'Lossy CRF values are quality controls, not mathematically lossless.', 'Shorter keyframe intervals and lower bitrate may improve seeking; continuous decoding and final export are not guaranteed faster.', 'Runtime results describe this CPU-only environment; no hardware encoder performance was measured.'],
        }
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(output, ensure_ascii=False, indent=2) + '\n')


if __name__ == '__main__':
    main()
