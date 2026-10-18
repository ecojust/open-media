#!/usr/bin/env python3
"""Decode every distributed science overlay and verify frame, key and inventory facts."""
import hashlib
import json
from pathlib import Path
import subprocess
import sys

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
ASSETS = ROOT / 'public/watermarks'


def run(args):
    return subprocess.run(args, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE).stdout


def main():
    manifest = json.loads((ASSETS/'science-manifest.json').read_text())
    checked = []
    for item in manifest['materials']:
        for file in item['files']:
            path = ASSETS/file['file']
            data = path.read_bytes()
            assert len(data) == file['bytes']
            assert hashlib.sha256(data).hexdigest() == file['sha256']
            if path.suffix not in ['.mp4', '.webm']:
                continue
            probe = json.loads(run(['ffprobe','-v','error','-count_frames','-show_streams','-show_format','-of','json',str(path)]))
            assert len(probe['streams']) == 1, 'Watermarks must not introduce an audio stream'
            stream = probe['streams'][0]
            assert stream['codec_name'] == ('h264' if path.suffix == '.mp4' else 'vp9')
            assert stream['width'] == 640 and stream['height'] == 360
            assert stream['avg_frame_rate'] == '24/1'
            assert int(stream['nb_read_frames']) == 96
            assert abs(float(probe['format']['duration'])-4) < .05
            run(['ffmpeg','-hide_banner','-loglevel','error','-xerror','-i',str(path),'-f','null','-'])
            frames=[]
            for time in [.125, .75, 2.5, 95/24]:
                decoded=run(['ffmpeg','-hide_banner','-loglevel','error','-ss',str(time),'-i',str(path),'-frames:v','1','-f','rawvideo','-pix_fmt','rgb24','pipe:1'])
                pixels=np.frombuffer(decoded,dtype=np.uint8).reshape((360,640,3)).astype(float)
                distance=np.sqrt(np.sum((pixels/255-np.array([0,1,0]))**2,axis=2)/3)
                alpha=np.clip((distance-.18)/.08,0,1)
                assert np.count_nonzero(alpha<.01) > 640*360*.35, 'Every graphic must retain transparent space'
                if time == 2.5:
                    assert np.count_nonzero(alpha>.95)>400, 'The held frame must contain solid, readable geometry'
                    assert np.all(alpha[:15,:] < .01) and np.all(alpha[-15:,:] < .01), 'Artwork cannot touch frame edges'
                if time == 95/24:
                    assert np.max(alpha) < .01, 'The last distributed frame must fade fully into the keyed background'
                frames.append(hashlib.sha256(decoded).hexdigest())
            assert frames[0] != frames[2], 'The distributed file must contain actual animation'
            checked.append({'file':path.name,'codec':stream['codec_name'],'frames':96,'duration':float(probe['format']['duration']),'sha256':file['sha256'],'sampledFrames':frames})
            print('PASS',path.name,flush=True)
    assert len(checked)==32
    output=Path(sys.argv[1] if len(sys.argv)>1 else '/tmp/open-media-science-watermarks/decode-verification.json')
    output.parent.mkdir(parents=True,exist_ok=True)
    output.write_text(json.dumps({'allFramesDecoded':True,'files':checked},indent=2)+'\n')
    print('Verified 32 encoded videos:',output)


if __name__ == '__main__': main()
