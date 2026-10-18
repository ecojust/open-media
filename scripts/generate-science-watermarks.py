#!/usr/bin/env python3
"""Generate original explanatory graphics, encoded media, honest posters and inventory.

No application build. Requires Python, Pillow, numpy, ffmpeg/ffprobe, Noto CJK fonts.
Graphics are illustrative, not measured scientific data. No external artwork is used.
"""
import argparse
import hashlib
import io
import json
import math
from pathlib import Path
import subprocess
from functools import lru_cache

import numpy as np
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'public/watermarks'
W, H, FPS, DURATION, S = 640, 360, 24, 4, 2
INK, IVORY, CYAN, AMBER, MUTED = '#182632', '#f3efdf', '#83d7ec', '#edbd72', '#a4b6c4'
MOTION = ['measurement', 'orbit', 'brackets', 'leader', 'waveform', 'comparison', 'steps', 'bars', 'axes', 'dimension', 'scale', 'process', 'path', 'angle', 'section', 'pin']
TITLES = ['相对刻度', '轨道指示', '聚焦括角', '目标引线', '波形窗口', '双向分隔', '四步进度', '三组示意', '坐标投影', '纵向测量', '分级比例尺', '流程分支', '曲线轨迹', '角度扇区', '分层剖面', '编号引脚']


def ease(t):
    t = max(0, min(1, t))
    return 1 - (1 - t) ** 3


@lru_cache(None)
def font(size, family='sans-serif', bold=False):
    name = 'NotoSerifCJK' if family == 'serif' else 'NotoSansCJK'
    return ImageFont.truetype(f'/usr/share/fonts/opentype/noto/{name}-{"Bold" if bold else "Regular"}.ttc', round(size * S))


class Painter:
    def __init__(self):
        self.image = Image.new('RGBA', (W*S, H*S))
        self.draw = ImageDraw.Draw(self.image)

    def line(self, points, color=IVORY, width=2):
        self.draw.line([(round(x*S), round(y*S)) for x, y in points], fill=color, width=max(2*S, round(width*S)), joint='curve')

    def ellipse(self, box, fill=None, stroke=IVORY, width=2):
        self.draw.ellipse([round(v*S) for v in box], fill=fill, outline=stroke, width=max(1, round(width*S)))

    def rect(self, box, fill=INK, stroke=None, width=1, radius=0):
        self.draw.rounded_rectangle([round(v*S) for v in box], radius=round(radius*S), fill=fill, outline=stroke, width=max(1, round(width*S)))

    def polygon(self, points, fill=None, stroke=IVORY, width=2):
        if fill: self.draw.polygon([(round(x*S),round(y*S)) for x,y in points],fill=fill)
        if stroke: self.line([*points,points[0]],stroke,width)

    def text(self, x, y, text, size=16, color=IVORY, anchor='lt', family='sans-serif', bold=False):
        self.draw.text((round(x*S), round(y*S)), text, font=font(max(14,size), family, bold), fill=color, anchor=anchor)

    def polyline_reveal(self, points, value, color=IVORY, width=2):
        lengths = [math.dist(a, b) for a, b in zip(points, points[1:])]
        remaining = sum(lengths) * value
        for a, b, length in zip(points, points[1:], lengths):
            if remaining <= 0:
                return
            t = min(1, remaining/length) if length else 1
            self.line([a, (a[0]+(b[0]-a[0])*t, a[1]+(b[1]-a[1])*t)], color, width)
            remaining -= length


def render(kind, t):
    p = Painter()
    intro = ease(t/.6)
    if kind == 'measurement':
        left, right, y = 96, 544, 197
        p.line([(left, 147), (left, 224)], MUTED, 1)
        p.line([(right, 147), (right, 224)], MUTED, 1)
        p.line([(left, y), (left+(right-left)*intro, y)], IVORY, 2)
        for index in range(41):
            x = left + (right-left)*index/40
            if x > left+(right-left)*intro:
                continue
            major = index % 10 == 0
            p.line([(x, y-12 if major else y-6), (x, y+12 if major else y+6)], CYAN if major else MUTED, 2 if major else 1)
            if major:
                p.text(x, y+22, str(round(index*2.5)), 14, IVORY, 'mt')
        p.text(320, 112, '相 对 刻 度', 18, IVORY, 'mt')
        p.text(320, 260, '无单位 · 示意', 12, MUTED, 'mt')
        x = left + (right-left)*(.25 + .5*ease((t-.3)/.9))
        p.ellipse((x-5, y-5, x+5, y+5), AMBER, AMBER)
    elif kind == 'orbit':
        cx, cy, rx, ry = 320, 182, 214, 82
        angle = -.6 + 1.9*ease((t-.2)/1.3)
        points = [(cx+rx*math.cos(a), cy+ry*math.sin(a)) for a in np.linspace(0, math.tau*intro, 200)]
        if len(points) > 1: p.line(points, MUTED, 1.5)
        p.ellipse((cx-17, cy-17, cx+17, cy+17), INK, IVORY, 2)
        p.ellipse((cx-4, cy-4, cx+4, cy+4), AMBER, AMBER, 1)
        x, y = cx+rx*math.cos(angle), cy+ry*math.sin(angle)
        p.line([(cx, cy), (x, y)], '#334a5a', 1)
        p.ellipse((x-8, y-8, x+8, y+8), CYAN, CYAN, 1)
        p.ellipse((x-13, y-13, x+13, y+13), None, CYAN, 1)
        p.text(320, 298, '轨 道 示 意', 13, IVORY, 'mt')
    elif kind == 'brackets':
        box = (150, 99, 490, 261)
        for x, y, dx, dy in [(box[0],box[1],1,1),(box[2],box[1],-1,1),(box[0],box[3],1,-1),(box[2],box[3],-1,-1)]:
            p.line([(x, y+dy*28*intro),(x,y),(x+dx*40*intro,y)], IVORY, 3)
        p.line([(310,180),(330,180)], CYAN, 1)
        p.line([(320,170),(320,190)], CYAN, 1)
        p.ellipse((317,177,323,183), CYAN, CYAN, 1)
        p.text(150, 75, '观 测 区 域', 13, IVORY)
        x = 165+310*ease((t-.2)/1.1)
        p.line([(x,111),(x,124)], CYAN, 2)
        p.line([(x,236),(x,249)], CYAN, 2)
    elif kind == 'leader':
        x, y = 174, 238
        p.ellipse((x-17,y-17,x+17,y+17), None, IVORY, 1.5)
        p.ellipse((x-5,y-5,x+5,y+5), CYAN, CYAN)
        p.polyline_reveal([(188,224),(291,124),(516,124)], intro, IVORY, 2)
        p.line([(516,118),(516,130)], CYAN, 2)
        if t > .8:
            p.text(300, 93, '观 测 目 标', 18, IVORY)
            p.text(300, 139, '局部结构 · 重点关注', 12, MUTED)
        radius = 25
        p.ellipse((x-radius,y-radius,x+radius,y+radius), None, '#496475', 1)
    elif kind == 'waveform':
        p.rect((70,77,570,283), INK, '#354856', 1, 12)
        p.text(91, 96, '信 号 示 意', 15, IVORY)
        p.text(548, 99, 'AMPLITUDE / t', 10, MUTED, 'rt')
        for x in range(96, 550, 56): p.line([(x,137),(x,253)], '#2b3d4a', 1)
        for y in [145,194,243]: p.line([(94,y),(548,y)], '#2b3d4a', 1)
        points=[]
        for x in range(96, int(96+452*intro)+1, 2):
            u=(x-96)/452
            wave=math.sin(u*math.tau*2.5-t*1.5)*math.exp(-((u-.55)*2.4)**2)
            points.append((x,194-45*wave))
        if len(points)>1: p.line(points, CYAN, 2.5)
        if points:
            x,y=points[-1];p.ellipse((x-3,y-3,x+3,y+3),IVORY,IVORY,1)
    elif kind == 'comparison':
        p.line([(320,82),(320,82+196*intro)], IVORY, 2)
        p.line([(307,82),(333,82)], CYAN, 2)
        p.line([(307,278),(333,278)], CYAN, 2)
        for x,label,color in [(235,'A',CYAN),(405,'B',AMBER)]:
            p.rect((x-27,153,x+27,207), INK, '#354856', 1, 8)
            p.text(x,180,label,26,color,'mm')
        p.line([(300,180),(278,180)], MUTED, 1)
        p.line([(340,180),(362,180)], MUTED, 1)
        p.text(320, 300, '对 照 观 察', 13, IVORY, 'mt')
    elif kind == 'steps':
        xs=[110,250,390,530]
        progress=ease((t-.3)/1.2)
        p.line([(xs[0],178),(xs[-1],178)], '#3a4c58', 2)
        p.line([(xs[0],178),(xs[0]+420*progress,178)], CYAN, 3)
        for n,x in enumerate(xs):
            active=progress>=n/3
            p.ellipse((x-20,158,x+20,198), INK, CYAN if active else MUTED, 2)
            p.text(x,178,str(n+1).zfill(2),14,IVORY if active else MUTED,'mm')
            p.text(x,222,['提出问题','建立假设','实验验证','得到结论'][n],14,IVORY if active else MUTED,'mt')
        p.text(320,99,'探 究 过 程',15,IVORY,'mt')
    elif kind == 'bars':
        p.rect((83,67,557,293), INK, '#354856', 1, 12)
        p.text(108,88,'三 组 对 比',15,IVORY)
        p.text(530,91,'示意数据',11,MUTED,'rt')
        for index,(ratio,color) in enumerate([(.76,CYAN),(.48,IVORY),(.90,AMBER)]):
            y=145+48*index
            p.text(111,y+8,str(index+1).zfill(2),13,MUTED,'lm')
            p.rect((145,y,526,y+16),'#293e4b',radius=3)
            grow=ease((t-index*.14-.2)/1.05)
            if grow>0:
                p.rect((145,y,145+381*ratio*grow,y+16),color,radius=3)
    elif kind == 'axes':
        p.line([(120,83),(120,274),(535,274)], IVORY, 2)
        p.line([(114,94),(120,83),(126,94)],IVORY,2)
        p.line([(524,268),(535,274),(524,280)],IVORY,2)
        p.text(101,78,'y',16,CYAN,'rt');p.text(548,275,'x',16,CYAN,'lm')
        for y in [130,178,226]:p.line([(117,y),(125,y)],MUTED,1)
        for x in [200,280,360,440,520]:p.line([(x,271),(x,277)],MUTED,1)
        points=[(x,250-135*((x-143)/360)**1.7) for x in range(143,round(143+360*intro)+1,3)]
        if len(points)>1:p.line(points,CYAN,3)
        x=170+300*ease((t-.2)/1.3);y=250-135*((x-143)/360)**1.7
        for dx in np.arange(125,x,9):p.line([(dx,y),(min(dx+4,x),y)],MUTED,1)
        for dy in np.arange(y+7,274,9):p.line([(x,dy),(x,min(dy+4,274))],MUTED,1)
        p.ellipse((x-5,y-5,x+5,y+5),AMBER,AMBER,1)
        p.text(329,307,'趋势示意 · 非实测数据',12,MUTED,'mt')
    elif kind == 'dimension':
        top,bottom=82,278
        p.line([(278,top),(278,top+196*intro)],IVORY,2)
        p.line([(258,top),(381,top)],MUTED,1)
        p.line([(258,bottom),(381,bottom)],MUTED,1)
        p.line([(270,top+12),(278,top),(286,top+12)],CYAN,2)
        p.line([(270,bottom-12),(278,bottom),(286,bottom-12)],CYAN,2)
        p.text(242,180,'h',30,IVORY,'mm',family='serif')
        y=top+25+146*ease((t-.2)/1.2)
        p.line([(303,y),(377,y)],AMBER,2)
        p.line([(377,top+15),(377,bottom-15)],'#496475',1)
        for yi in range(103,261,20):p.line([(372,yi),(382,yi)],MUTED,1)
        p.text(320,305,'纵 向 测 量',13,IVORY,'mt')
    elif kind == 'scale':
        p.text(98,113,'尺 度 参 照',18,IVORY)
        for index in range(4):
            x=98+111*index
            shown=ease((t-.1-index*.1)/.45)
            p.rect((x,183,x+111*shown,204),IVORY if index%2==0 else INK,IVORY,1)
        for index,label in enumerate(['0','¼','½','¾','1']):
            x=98+111*index
            p.line([(x,180),(x,212)],CYAN if index in [0,4] else IVORY,1)
            p.text(x,224,label,16,IVORY,'mt')
        p.text(98,265,'相对比例 · 请结合真实画面标定',12,MUTED)
    elif kind == 'process':
        points=[(105,180),(264,180),(397,109),(535,109)]
        p.polyline_reveal(points,intro,IVORY,2)
        p.polyline_reveal([(264,180),(397,251),(535,251)],ease((t-.25)/.65),MUTED,2)
        p.rect((75,150,135,210),INK,IVORY,2,10)
        p.text(105,180,'01',17,IVORY,'mm')
        p.polygon([(264,151),(293,180),(264,209),(235,180)],INK,CYAN,2)
        for y,n,color in [(109,'02',CYAN),(251,'03',AMBER)]:
            p.rect((484,y-25,544,y+25),INK,color,2,8);p.text(514,y,n,16,color,'mm')
            p.line([(459,y-5),(468,y),(459,y+5)],color,2)
        progress=ease((t-.2)/1.4)
        route=points
        lengths=[math.dist(a,b) for a,b in zip(route,route[1:])];distance=sum(lengths)*progress
        for a,b,length in zip(route,route[1:],lengths):
            if distance<=length:
                f=distance/length;x=a[0]+(b[0]-a[0])*f;y=a[1]+(b[1]-a[1])*f
                p.ellipse((x-3,y-3,x+3,y+3),CYAN,CYAN,1);break
            distance-=length
    elif kind == 'path':
        def curve(u):return (99+440*u,228-125*math.sin(math.pi*u)+18*math.sin(math.tau*u))
        p.line([curve(u) for u in np.linspace(0,1,120)],'#496475',2)
        p.line([curve(u) for u in np.linspace(0,intro*.8,100)],IVORY,2)
        u=.12+.76*ease((t-.2)/1.4);x,y=curve(u);before=curve(max(0,u-.01));a=math.atan2(y-before[1],x-before[0])
        p.polygon([(x+13*math.cos(a),y+13*math.sin(a)),(x+11*math.cos(a+2.5),y+11*math.sin(a+2.5)),(x+6*math.cos(a+math.pi),y+6*math.sin(a+math.pi)),(x+11*math.cos(a-2.5),y+11*math.sin(a-2.5))],CYAN,None)
        for u,label in [(0,'起点'),(1,'终点')]:
            x,y=curve(u);p.ellipse((x-5,y-5,x+5,y+5),INK,IVORY,2);p.text(x,y+20,label,13,IVORY,'mt')
        p.text(320,286,'运 动 轨 迹',14,IVORY,'mt')
    elif kind == 'angle':
        cx,cy,r=224,254,224
        theta=math.radians(35+22*ease((t-.2)/1.2))
        end=(cx+r*math.cos(theta),cy-r*math.sin(theta))
        p.line([(cx,cy),(cx+r,cy)],IVORY,2)
        p.line([(cx,cy),end],CYAN,2.5)
        wedge=[(cx,cy)]+[(cx+86*math.cos(a),cy-86*math.sin(a)) for a in np.linspace(0,theta,50)]
        p.polygon(wedge,'#263d4b',None)
        p.line([(cx+86*math.cos(a),cy-86*math.sin(a)) for a in np.linspace(0,theta,50)],AMBER,2)
        p.ellipse((cx-4,cy-4,cx+4,cy+4),IVORY,IVORY,1)
        p.text(cx+111*math.cos(theta/2),cy-111*math.sin(theta/2),'θ',26,AMBER,'mm',family='serif')
        p.text(125,93,'角 度 与 方 向',15,IVORY)
        p.text(320,296,'几何示意',12,MUTED,'mt')
    elif kind == 'section':
        spread=12+12*ease(t/1.1)
        for index,color in [(2,AMBER),(1,IVORY),(0,CYAN)]:
            y=145+index*spread
            pts=[(130,y+30),(390,y-24),(510,y+34),(250,y+88)]
            p.polygon(pts,INK,color,1.5)
            for k in range(7):
                xx=164+k*37;p.line([(xx,y+24-k*7.7),(xx+73,y+60-k*7.7)],'#344c5a',1)
            p.line([(512,y+34),(550,y+34)],color,1)
            p.text(557,y+34,str(index+1).zfill(2),12,color,'lm')
        p.text(320,65,'分 层 结 构',15,IVORY,'mt')
    elif kind == 'pin':
        x,y=230,232
        p.polyline_reveal([(x,y),(x,123),(452,123)],intro,IVORY,2)
        p.ellipse((x-8,y-8,x+8,y+8),INK,CYAN,2)
        p.ellipse((x-2,y-2,x+2,y+2),CYAN,CYAN,1)
        p.rect((202,87,258,143),INK,IVORY,2,14)
        p.text(230,115,'01',18,CYAN,'mm')
        p.text(286,92,'定位点',20,IVORY)
        p.text(286,139,'保留观察参照',13,MUTED)
        p.line([(214,257),(246,257)],'#496475',1)
    image=p.image.resize((W,H),Image.Resampling.LANCZOS)
    # A short fade in/out prevents popping when an annotation starts or ends.
    opacity=min(ease(t/.16),max(0,min(1,(DURATION-t)/.22))**3)
    if opacity<1:image.putalpha(image.getchannel('A').point(lambda alpha: round(alpha*opacity)))
    return image


def run(args, **kwargs):
    return subprocess.run(args, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, **kwargs)


def key_frame(data):
    image=Image.open(io.BytesIO(data)).convert('RGBA')
    rgba=np.array(image).astype(float)
    distance=np.sqrt(np.sum((rgba[:,:,:3]/255-np.array([0,1,0]))**2,axis=2)/3)
    rgba[:,:,3]=255*np.clip((distance-.18)/.08,0,1)
    rgba[:,:,1]=np.minimum(rgba[:,:,1],np.maximum(rgba[:,:,0],rgba[:,:,2]))
    return Image.fromarray(np.round(rgba).astype('uint8'),'RGBA')


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--review-dir',default='/tmp/open-media-science-watermarks')
    parser.add_argument('--reuse-existing',action='store_true',help='Reuse previously encoded motion files; rebuild posters and inventory.')
    args=parser.parse_args()
    review=Path(args.review_dir); review.mkdir(parents=True,exist_ok=True);OUT.mkdir(parents=True,exist_ok=True)
    records=[]; tiles=[]
    for kind,title in zip(MOTION,TITLES):
        identifier='science-'+kind
        if not args.reuse_existing or not all((OUT/(identifier+ext)).is_file() for ext in ['.mp4','.webm']):
            raw=review/(identifier+'.rgb')
            with raw.open('wb') as stream:
                for frame in range(FPS*DURATION):
                    image=render(kind,frame/FPS)
                    background=Image.new('RGBA',(W,H),(0,255,0,255));background.alpha_composite(image)
                    stream.write(background.convert('RGB').tobytes())
            base=['ffmpeg','-hide_banner','-loglevel','error','-y','-f','rawvideo','-pixel_format','rgb24','-video_size',f'{W}x{H}','-framerate',str(FPS),'-i',str(raw),'-an']
            run(base+['-c:v','libx264','-preset','slow','-crf','17','-profile:v','main','-pix_fmt','yuv420p','-movflags','+faststart',str(OUT/(identifier+'.mp4'))])
            run(base+['-c:v','libvpx-vp9','-deadline','good','-cpu-used','2','-b:v','0','-crf','24','-pix_fmt','yuv420p',str(OUT/(identifier+'.webm'))])
            raw.unlink()
        actual=run(['ffmpeg','-hide_banner','-loglevel','error','-ss','2','-i',str(OUT/(identifier+'.mp4')),'-frames:v','1','-f','image2pipe','-vcodec','png','pipe:1']).stdout
        poster=key_frame(actual);poster.save(OUT/(identifier+'.png'))
        tile=Image.new('RGBA',(W,H+44),'#0f1823');tile.alpha_composite(poster)
        ImageDraw.Draw(tile).text((20,H+8),title,font=font(10),fill=IVORY)
        tiles.append(tile)
        records.append({'id':identifier,'kind':'video','duration':DURATION,'width':W,'height':H,'fps':FPS,'frames':FPS*DURATION,'files':[inventory(OUT/(identifier+ext)) for ext in ['.mp4','.webm','.png']]})
        print('Generated',identifier,flush=True)
    # Read the exact native text templates so poster and inserted text stay in sync.
    catalog=json.loads(run(['node','--experimental-strip-types','--input-type=module','-e',"import {SCIENCE_WATERMARK_MATERIALS as m} from './src/core/science-watermark-catalog.ts'; console.log(JSON.stringify(m.filter(x=>x.kind==='text')))"],cwd=ROOT).stdout)
    for item in catalog:
        template=item['textTemplate'];p=Painter()
        lines=template['text'].split('\n');lineheight=template['fontSize']*1.35
        x=(W-template['width'])/2;y=(H-template['height'])/2
        if template['background']!='transparent':
            p.rect((x,y,x+template['width'],y+template['height']),template['background'])
        for index,line in enumerate(lines):
            tx=W/2 if template['textAlign']=='center' else x+template['width']-12 if template['textAlign']=='right' else x+12
            ty=H/2-(len(lines)-1)*lineheight/2+index*lineheight
            p.text(tx,ty,line,template['fontSize'],template['color'],{'center':'mm','right':'rm','left':'lm'}[template['textAlign']],template['fontFamily'],template['fontWeight']>=600)
        poster=p.image.resize((W,H),Image.Resampling.LANCZOS);poster.save(OUT/(item['id']+'.png'))
        tile=Image.new('RGBA',(W,H+44),'#0f1823');tile.alpha_composite(poster)
        ImageDraw.Draw(tile).text((20,H+8),item['name'],font=font(10),fill=IVORY);tiles.append(tile)
        records.append({'id':item['id'],'kind':'text','files':[inventory(OUT/(item['id']+'.png'))]})
    montage=Image.new('RGB',(W*3,(H+44)*math.ceil(len(tiles)/3)),'#0f1823')
    for index,tile in enumerate(tiles):montage.paste(tile,(index%3*W,index//3*(H+44)))
    montage.save(review/'science-watermarks-montage.jpg',quality=94)
    (OUT/'science-manifest.json').write_text(json.dumps({'version':1,'origin':'Original Open Media procedural graphics. No external footage or artwork.','generator':'scripts/generate-science-watermarks.py','illustrative':True,'materials':records},ensure_ascii=False,indent=2)+'\n')
    print('Review:',review/'science-watermarks-montage.jpg',flush=True)


def inventory(path):
    data=path.read_bytes()
    return {'file':path.name,'bytes':len(data),'sha256':hashlib.sha256(data).hexdigest()}


if __name__=='__main__':main()
