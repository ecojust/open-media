#!/usr/bin/env python3
"""Generate original, reusable opening and closing motion compositions.

The media contains only geometry, lighting and texture. Titles are separate,
editable timeline clips. No downloaded footage or baked-in lettering is used.
"""
from __future__ import annotations
import argparse
import hashlib
import json
import math
from functools import lru_cache
from pathlib import Path
import subprocess
import numpy as np
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / 'src/assets/general-segments'
W, H, FPS, DURATION, S = 1280, 720, 24, 5, 1.5
DESIGNS = [
 ('general-paper-rise', '纸层展开', '#f2eee6', '#fffaf1', '#bd775e', '#38494a', '从这里开始', '01 / 开场'),
 ('general-gallery-reveal', '画廊开场', '#172026', '#23313a', '#c9bea4', '#698d95', '新的篇章', '用清晰的表达，分享你的想法'),
 ('general-geometric-curtain', '几何启幕', '#e5e9e5', '#f2f5ed', '#376f70', '#be896e', '即刻开始', '让每一帧都有自己的节奏'),
 ('general-soft-halo', '柔光序幕', '#192136', '#38435d', '#8eacc0', '#cbb1a8', '精彩即将展开', '记录此刻，分享所见'),
 ('general-offset-blocks', '错位构成', '#ede6dc', '#f6eee4', '#a94f48', '#2e424b', '换个角度', '发现值得分享的片刻'),
 ('general-line-assembly', '细线成章', '#e9eded', '#fafbf8', '#4a737b', '#bb966c', '关于这一刻', '01 / 本期内容'),
 ('general-film-window', '影窗初启', '#202322', '#333834', '#e2ddcd', '#909a83', '画面从此开始', '你的故事，现在开场'),
 ('general-grain-gradient', '微光渐层', '#decac4', '#f4e7de', '#8c7492', '#c8937b', '分享新的灵感', '让平常的瞬间，留下不同的印象'),
 ('general-paper-fold', '纸页收束', '#e8e1d5', '#fbf5ea', '#8a9c8d', '#b18968', '感谢观看', '署名 / 你的名字'),
 ('general-gallery-close', '画廊留白', '#1b252b', '#283a41', '#b7c6be', '#cfad7e', '故事未完', '期待下一次相遇'),
 ('general-curtain-settle', '幕布余韵', '#dbe5e6', '#f0f4ed', '#6c8e96', '#c5aa88', '下次再见', '让美好继续发生'),
 ('general-soft-afterglow', '柔光回响', '#242833', '#47434b', '#d8b58a', '#7f9aa9', '感谢相伴', '愿这一刻，留下温柔的余韵'),
 ('general-blocks-balance', '色块归位', '#dfe7df', '#f0f5eb', '#658278', '#c58d71', '保持关注', '更多内容，即将分享'),
 ('general-line-signature', '细线落款', '#e9e6df', '#fbf8ef', '#5d7976', '#ae7d5c', '让故事继续', '创作 / 你的名字'),
 ('general-film-resolve', '影窗定格', '#dddcd5', '#f8f6ed', '#34413e', '#a39576', '到这里，刚刚好', '谢谢你，把时间留给这段画面'),
 ('general-grain-dusk', '微光渐隐', '#22252e', '#374449', '#92aaa2', '#c3a17b', '我们再会', '留下回声，也留下期待'),
]

def rgb(value): return tuple(int(value[i:i+2],16) for i in (1,3,5))
def rgba(value, alpha=255): return (*rgb(value), max(0,min(255,round(alpha))))
def ease(value):
    v=max(0,min(1,value)); return v*v*(3-2*v)
def intro(t, delay=0): return ease((t-delay)/1.05)
def settle(t): return ease((t-4.15)/.85)

class Pen:
    def __init__(self, image): self.d=ImageDraw.Draw(image)
    def points(self, points): return [(round(x*S),round(y*S)) for x,y in points]
    def line(self, points, color, width=1):
        if len(points)>1: self.d.line(self.points(points),fill=color,width=max(1,round(width*S)),joint='curve')
    def rect(self, bounds, color, radius=0, outline=None, width=1):
        self.d.rounded_rectangle(tuple(round(x*S) for x in bounds),radius=round(radius*S),fill=color,outline=outline,width=max(1,round(width*S)))
    def ellipse(self, bounds, color=None, outline=None, width=1):
        self.d.ellipse(tuple(round(x*S) for x in bounds),fill=color,outline=outline,width=max(1,round(width*S)))
    def polygon(self, points, color): self.d.polygon(self.points(points),fill=color)
    def arc(self, bounds, start, end, color, width=1):
        self.d.arc(tuple(round(x*S) for x in bounds),start,end,fill=color,width=max(1,round(width*S)))

@lru_cache(maxsize=16)
def background(index):
    entry=DESIGNS[index]; yy,xx=np.mgrid[0:H,0:W].astype(np.float32); xx/=W; yy/=H
    field=.24+.66*np.exp(-((xx-.53)**2/.7+(yy-.43)**2/.55))
    if index in(3,7,11,15): field=.25+.58*yy+.12*np.sin(xx*3+yy*2)
    pixels=np.array(rgb(entry[2]))+field[...,None]*(np.array(rgb(entry[3]))-np.array(rgb(entry[2])))
    noise=np.random.default_rng(6300+index).normal(0,.46 if index in(7,15) else .18,(H,W,1))
    return Image.fromarray(np.clip(pixels+noise,0,255).astype(np.uint8),'RGB').resize((round(W*S),round(H*S)))

def border_path(p, bounds, progress, color, width=1):
    x0,y0,x1,y1=bounds; corners=[(x0,y0),(x1,y0),(x1,y1),(x0,y1),(x0,y0)]
    remaining=(2*(x1-x0+y1-y0))*max(0,min(1,progress))
    for a,b in zip(corners,corners[1:]):
        length=math.dist(a,b)
        if remaining<=0: break
        fraction=min(1,remaining/length)
        p.line([a,(a[0]+(b[0]-a[0])*fraction,a[1]+(b[1]-a[1])*fraction)],color,width)
        remaining-=length

def draw(index,t):
    _,_,base,light,c,alt,*_=DESIGNS[index]
    image=background(index).convert('RGBA'); layer=Image.new('RGBA',image.size); p=Pen(layer)
    e=intro(t); end=settle(t); drift=math.sin(t*.36)*3
    # Motion is concentrated outside the title-safe center (x=260..1020,
    # y=250..490). A long reading interval remains after the entrance.
    if index==0:
        for k,col in enumerate([alt,c,'#ded4c1','#fffaf2']):
            y=605+k*31+220*(1-intro(t,k*.09))+end*18
            p.polygon([(-100,y+65),(W+80,y-58),(W+80,H+100),(-100,H+100)],rgba(col,255))
            p.line([(-30,y+53),(W,y-53)],rgba('#ffffff',125),1)
        p.polygon([(-60,-20),(265*e,-20),(190*e,120),(-60,180)],rgba(c,45))
        p.line([(92,180),(92+118*e,180)],rgba(alt,150),2)
        p.ellipse((1050,65,1165,180),outline=rgba(c,105),width=1.2)
    elif index==1:
        for k in range(3):
            inset=70+k*14; shift=14*(1-intro(t,k*.12))+end*(k-1)*4
            border_path(p,(inset+shift,70+k*14,W-inset+shift,H-70-k*14),intro(t,k*.13),rgba(c,135-k*36),1.2)
        p.rect((60,130,98,205+50*e),rgba(alt,110));p.rect((W-98,515-50*e,W-60,590),rgba(c,85))
        for x,y in [(160,148),(1115,570)]:
            p.line([(x,y),(x+e*65,y)],rgba(c,180),2);p.line([(x,y),(x,y+22*e)],rgba(c,180),2)
        p.line([(550,610),(550+180*e,610)],rgba(c,75),1)
    elif index==2:
        for k in range(3):
            a=intro(t,k*.11); x=-310*(1-a)-k*53
            p.polygon([(x-140,-30),(x+240,-30),(x+102,260),(x-120,350)],rgba(c,210-k*44))
            x=W+310*(1-a)+k*53
            p.polygon([(x+140,H+30),(x-240,H+30),(x-102,460),(x+120,370)],rgba(alt,210-k*42))
        p.polygon([(W-190,0),(W,0),(W,160)],rgba(c,45+end*20))
        p.line([(100,610),(380+drift,610)],rgba(c,70),1.2)
    elif index==3:
        # Nested, feathered ellipses form a soft light field without raster art.
        for j in range(38,0,-1):
            r=70+j*8+28*e+drift; opacity=(39-j)*1.6
            p.ellipse((85-r,55-r,85+r,55+r),color=rgba(alt,opacity))
            p.ellipse((W-65-r,H-40-r,W-65+r,H-40+r),color=rgba(c,opacity*.8))
        p.arc((900,-230,1400,270),70,310,rgba(alt,32+e*28),1.4)
        p.arc((-300,470,240,1010),-80,140,rgba(c,36+e*24),1.4)
        p.line([(570,172),(570+140*e,172)],rgba(alt,125),1.5)
        p.line([(600,568),(680,568)],rgba(c,90+20*math.sin(t*.5)),1)
    elif index==4:
        blocks=[(0,105,210,100,c,-1),(1070,65,210,165,alt,1),(0,585,285,135,alt,-1),(1020,555,260,165,c,1)]
        for k,(x,y,w,h,col,side) in enumerate(blocks):
            offset=side*340*(1-intro(t,k*.12))+side*end*14
            p.rect((x+offset+9,y+9,x+w+offset+9,y+h+9),rgba('#3b3131',24))
            p.rect((x+offset,y,x+w+offset,y+h),rgba(col,240))
            p.line([(x+offset+18,y+18),(x+offset+w-18,y+18)],rgba(light,55),1)
        p.rect((275,110,275+86*e,116),rgba(c,145));p.rect((923,590,1009,594),rgba(alt,125))
    elif index==5:
        for k in range(5):
            pos=82+k*13; a=intro(t,k*.09)
            p.line([(pos,80),(pos,80+560*a)],rgba(c,110-k*12),1.1)
            p.line([(W-pos,H-80),(W-pos,H-80-560*a)],rgba(c,110-k*12),1.1)
        for y,left in [(133,150),(585,845)]:
            p.line([(left,y),(left+285*e,y)],rgba(alt,160),1.4)
            x=left+285*e;p.ellipse((x-3,y-3,x+3,y+3),color=rgba(alt,200))
        border_path(p,(208,179,1072,541),e,rgba(c,22),.8)
        for k in range(7):p.line([(1060+k*8,95),(1060+k*8,102+(k%3)*7)],rgba(c,80),1)
        for x,sign in [(82,1),(1198,-1)]:
            y=100+(t*24+100*(sign+1))%490;p.ellipse((x-2,y-2,x+2,y+2),color=rgba(alt,190*e))
    elif index==6:
        # A broad moving aperture opens once, then its border breathes at edges.
        opening=(.76-.003*math.sin(t*.8))*e; left=W*(.5-opening/2);right=W*(.5+opening/2)
        p.rect((left,58,right,H-58),rgba('#3b443e',180),radius=3)
        for k in range(3):border_path(p,(left-k*11,58-k*11,right+k*11,H-58+k*11),e,rgba(c,130-k*35),1)
        for y in [88,130,172,548,590,632]:
            p.rect((27,y,42,y+14),rgba(c,100));p.rect((W-42,y,W-27,y+14),rgba(c,100))
        p.line([(160,184),(160+98*e,184)],rgba(c,160),1.4)
        p.line([(1022,555),(1120,555)],rgba(c,90+end*35),1.4)
    elif index==7:
        for k in range(28):
            x=-260+k*23+180*e+drift
            p.polygon([(x,-20),(x+20,-20),(x+400,H+20),(x+380,H+20)],rgba(c,6+k*.65))
        for k in range(20):
            r=50+k*12;p.ellipse((1090-r,95-r,1090+r,95+r),outline=rgba(alt,20-k*.6),width=5)
        p.line([(94,160),(94+142*e,160)],rgba(c,130),1.3)
        p.line([(1040,581),(1170,581)],rgba(c,70+end*20),1)
    elif index==8:
        for k,col in enumerate([alt,c,'#d9d0bb']):
            a=intro(t,k*.12);x=-320*(1-a)-k*24-end*22
            p.polygon([(x-50,160),(x+185,240),(x+280,H+30),(x-50,H+30)],rgba(col,220-k*30))
        for k,col in enumerate([c,alt]):
            y=-150*(1-intro(t,k*.12))-k*19
            p.polygon([(945,y-70),(W+30,y-70),(W+30,y+205),(1030,y+120)],rgba(col,130-k*20))
        p.line([(565,564),(565+150*e,564)],rgba(alt,135),1.5)
    elif index==9:
        for k in range(2):
            dx=(1-intro(t,k*.16))*(160 if k==0 else -160)+drift*(1 if k==0 else -1)
            border_path(p,(155+dx+k*12,130+k*12,1125+dx-k*12,590-k*12),e,rgba(c,130-k*65),1)
        for k in range(9):
            x=137+k*12;p.line([(x,91),(x+5,91)],rgba(alt,140*intro(t,k*.035)),1.5)
        p.line([(1064,627),(1064+78*e,627)],rgba(alt,130),1.4)
        p.rect((80,242,86,242+236*e),rgba(alt,110));p.rect((1194,242,1200,242+236*e),rgba(c,90))
    elif index==10:
        for side in [-1,1]:
            for k in range(4):
                width=42+k*19;offset=220*(1-intro(t,k*.1))+end*14
                x=(k*23-offset) if side<0 else (W-k*23-width+offset)
                p.rect((x,-20,x+width,H+20),rgba(c,80-k*13))
        for k in range(4):
            y=620+k*24+12*(1-e);points=[(-20,H+20)]
            for x in range(-20,W+21,20):points.append((x,y+12*math.sin(x/320+k*.15+t*.1)))
            points.append((W+20,H+20));p.polygon(points,rgba(alt,65-k*10))
        p.line([(565,160),(715,160)],rgba(c,90*e),1)
    elif index==11:
        for k in range(34):
            y=610+k*5+18*(1-e)+end*5
            p.ellipse((-140,y,W+140,y+400),outline=rgba(c,32-k*.7),width=5)
        for k in range(25,0,-1):
            r=50+k*10;p.ellipse((1020-r,50-r,1020+r,50+r),color=rgba(alt,(26-k)*1.1))
        p.line([(95,115),(95+110*e,115)],rgba(c,140),1.2)
        p.line([(1160,145),(1160,145+45*e)],rgba(c,80),1)
    elif index==12:
        for k in range(4):
            x=56+k*27; y=84+160*(1-intro(t,k*.11))+drift*k*.4
            p.rect((x,y,x+20,y+70+k*20),rgba(c,155-k*22))
        for k in range(3):
            x=1060+k*50+180*(1-intro(t,.1+k*.11));y=545+k*15
            p.rect((x,y,x+42,y+150),rgba(alt,190-k*30))
        p.rect((250,108,250+134*e,112),rgba(c,110))
        p.rect((903,604,1020,608),rgba(alt,120+end*12))
        p.polygon([(0,659),(330,659),(400,720),(0,720)],rgba(c,35))
    elif index==13:
        pts=[]
        for k in range(150):
            u=k/149;pts.append((70+u*1140,608-72*math.sin(u*math.pi)+9*math.sin(u*math.tau+t*.12)))
        p.line(pts[:max(2,round(150*e))],rgba(c,145),1.4)
        p.line([(565,160),(565+150*e,160)],rgba(alt,130),1.1)
        for k in range(3):p.arc((980-k*12,80-k*12,1130+k*12,230+k*12),-110,155*e,rgba(c,80-k*20),.9)
        p.line([(106,120),(106,155),(141,155)],rgba(alt,110),1)
    elif index==14:
        for k in range(3):
            off=34*(1-intro(t,k*.14))
            border_path(p,(92+k*12+off,65+k*12,1188-k*12+off,655-k*12),e,rgba(c,110-k*28),1.2)
        p.rect((0,0,W,30+8*end),rgba(c,225));p.rect((0,H-30-8*end,W,H),rgba(c,225))
        p.rect((72,155,100,155+82*e),rgba(alt,90));p.rect((1180,485-42*e,1208,565),rgba(c,90))
        for k in range(3):p.line([(150+k*11,597),(150+k*11,607)],rgba(c,90),1)
    elif index==15:
        for k in range(32):
            x=22+k*5+45*e+drift
            p.polygon([(x,0),(x+4,0),(x+190,H),(x+186,H)],rgba(c,3+k*.18))
        for k in range(24):
            x=1010+k*4;p.line([(x,720),(x+110,560-30*e)],rgba(alt,5+k*.18),4)
        for k in range(35):
            x=80+(k*147)%1120;y=65+(k*61)%590
            if y<205 or y>525:p.ellipse((x,y,x+1.2,y+1.2),color=rgba(c,35+20*math.sin(t*.35+k)**2))
        p.line([(565,565),(715,565)],rgba(alt,110*e),1.2)
    image=Image.alpha_composite(image,layer)
    return image.convert('RGB').resize((W,H),Image.Resampling.LANCZOS)

def contact(indices,path):
    times=[.3,1.1,2.5,4.8]; canvas=Image.new('RGB',(1280,218*len(indices)),'#15191d')
    fontpath=Path('/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc')
    font=lambda size:ImageFont.truetype(str(fontpath),size) if fontpath.exists() else ImageFont.load_default()
    for row,index in enumerate(indices):
        for col,t in enumerate(times):
            image=draw(index,t);entry=DESIGNS[index];ink='#edf1ea' if index in(1,3,6,9,11,15) else '#354746'
            if t>=1:
                pen=ImageDraw.Draw(image)
                if index in (0,5):
                    pen.text((154,342),entry[6],font=font(72),fill=ink,anchor='lm');pen.text((154,202),entry[7],font=font(27),fill=ink,anchor='lm')
                elif index in (8,13):
                    pen.text((154,504),entry[6],font=font(59),fill=ink,anchor='lm');pen.text((1126,619),entry[7],font=font(24),fill=ink,anchor='rm')
                else:
                    pen.text((640,340),entry[6],font=font(66),fill=ink,anchor='mm');pen.text((640,443),entry[7],font=font(27),fill=ink,anchor='mm')
            canvas.paste(image.resize((320,180)),(col*320,row*218+32));ImageDraw.Draw(canvas).text((col*320+8,row*218+7),f'{entry[1]} · {t:.1f}s',font=font(15),fill='white')
    canvas.save(path);print(path,flush=True)

def main():
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--ids',nargs='*');parser.add_argument('--contact',type=Path);parser.add_argument('--contact-only',action='store_true');args=parser.parse_args()
    if args.ids and set(args.ids)-{d[0] for d in DESIGNS}:parser.error('Unknown design id')
    indices=[i for i,d in enumerate(DESIGNS) if not args.ids or d[0] in args.ids]
    if args.contact:contact(indices,args.contact)
    if args.contact_only:return
    OUTPUT.mkdir(parents=True,exist_ok=True)
    for index in indices:
        name=DESIGNS[index][0];dest=OUTPUT/f'{name}.webm'
        command=['ffmpeg','-hide_banner','-loglevel','error','-y','-f','rawvideo','-pix_fmt','rgb24','-s',f'{W}x{H}','-r',str(FPS),'-i','pipe:0','-an','-c:v','libvpx-vp9','-b:v','0','-crf','29','-deadline','good','-cpu-used','4','-row-mt','1','-threads','2','-pix_fmt','yuv420p','-metadata','comment=Original Open Media general motion composition',str(dest)]
        with subprocess.Popen(command,stdin=subprocess.PIPE) as encoder:
            try:
                for frame in range(FPS*DURATION):encoder.stdin.write(draw(index,frame/FPS).tobytes())
            finally:encoder.stdin.close()
            if encoder.wait()!=0:raise RuntimeError(f'Encoding failed: {name}')
        subprocess.run(['ffmpeg','-hide_banner','-loglevel','error','-y','-ss','2.5','-i',str(dest),'-frames:v','1','-vf','scale=640:360','-q:v','3',str(OUTPUT/f'{name}.jpg')],check=True)
        print(f'{name}: {dest.stat().st_size:,} bytes',flush=True)
    records=[]
    for entry in DESIGNS:
        path=OUTPUT/f'{entry[0]}.webm'
        if path.exists():records.append(dict(id=entry[0],filename=path.name,poster=f'{entry[0]}.jpg',width=W,height=H,fps=FPS,duration=DURATION,size=path.stat().st_size,sha256=hashlib.sha256(path.read_bytes()).hexdigest()))
    (OUTPUT/'manifest.json').write_text(json.dumps(dict(author='Open Media',license='MIT',generator='scripts/generate-general-segments.py',items=records),ensure_ascii=False,indent=2)+'\n')

if __name__=='__main__':main()
