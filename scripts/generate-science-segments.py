#!/usr/bin/env python3
"""Generate original science motion compositions. Media generation only, no app build.

All geometry is authored here. Titles are separate editable timeline clips; no
external illustrations, footage or typefaces are embedded in the video assets.
The independent manifest prevents regeneration of the original collection from
removing or relabeling this collection.
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
OUTPUT = ROOT / 'src/assets/science-segments'
W, H, FPS, DURATION, S = 1280, 720, 24, 5, 2
DESIGNS = [
 ('science-orbital-atlas', '星轨观测', '#080f24', '#152d48', '#65d8ed', '#f3c992', '从一颗星，认识宇宙', '观测 · 假设 · 验证'),
 ('science-spectrum-lab', '光谱实验室', '#eee9df', '#faf8f2', '#b26b3c', '#193b54', '一束光里的答案', '把看不见的规律，变成看得见的实验'),
 ('science-molecular-chain', '生命的编码', '#081b24', '#16323b', '#63d6c2', '#d7be87', '生命，写在微观世界', '从结构出发，寻找生命的规律'),
 ('science-blueprint-launch', '工程解构', '#0b1729', '#193146', '#8fc9ed', '#dcaf70', '拆开原理，读懂世界', '结构 · 尺度 · 精度'),
 ('science-data-field', '数据有迹', '#e8ece8', '#f7f7ef', '#26786d', '#b66f43', '让数据，讲清楚真相', '每一个结论，都从证据开始'),
 ('science-terrain-observer', '地球剖面', '#171d23', '#26372e', '#cfb876', '#91bb9e', '把视线，放大到地球', '穿过表象，看见深处的联系'),
 ('science-orbit-return', '宇宙余响', '#080f24', '#142b42', '#83badf', '#e4c697', '保持好奇，继续仰望', '今天的答案，是下一次探索的起点'),
 ('science-spectrum-resolve', '光的回声', '#eee8de', '#faf7ee', '#2a6177', '#bd7755', '实验结束，思考继续', '用新的视角，再看一次熟悉的世界'),
 ('science-molecular-summary', '生命共鸣', '#0a1c22', '#193633', '#8dd0ac', '#d8bd83', '微小之处，自有辽阔', '感谢陪伴这一次微观旅程'),
 ('science-blueprint-complete', '原理归档', '#0c1728', '#1a2c40', '#a2cbe3', '#d8ad70', '把原理，带回生活', '保留问题，让下一次发现发生'),
 ('science-data-archive', '证据留存', '#eaeee8', '#f8f7ef', '#28786c', '#ac684c', '结论有据，探索无止', '记录证据，也保留对未知的好奇'),
 ('science-terrain-horizon', '山海未尽', '#131e20', '#263c37', '#bdccaa', '#d1af72', '世界很大，下一站见', '让好奇心，带我们走得更远'),
]

def rgb(c): return tuple(int(c[i:i+2],16) for i in (1,3,5))
def ease(v): v=max(0,min(1,v)); return 1-(1-v)**3

def entrance(t, delay=0): return ease((t-delay)/1.15)

class Pen:
 def __init__(self, image): self.image=image; self.d=ImageDraw.Draw(image)
 def pts(self,points): return [(round(x*S),round(y*S)) for x,y in points]
 def line(self,points,color,width=1):
  if len(points)>1:self.d.line(self.pts(points),fill=color,width=max(1,round(width*S)),joint='curve')
 def ellipse(self,bounds,color=None,outline=None,width=1):
  self.d.ellipse(tuple(round(x*S) for x in bounds),fill=color,outline=outline,width=max(1,round(width*S)))
 def arc(self,bounds,a,b,color,width=1): self.d.arc(tuple(round(x*S) for x in bounds),a,b,fill=color,width=max(1,round(width*S)))
 def polygon(self,points,color): self.d.polygon(self.pts(points),fill=color)
 def rectangle(self,bounds,color=None,outline=None,width=1): self.d.rectangle(tuple(round(x*S) for x in bounds),fill=color,outline=outline,width=max(1,round(width*S)))

def rgba(c,a=255):return (*rgb(c),max(0,min(255,int(a))))
def circle(p,x,y,r,c,a=255,width=1):p.ellipse((x-r,y-r,x+r,y+r),outline=rgba(c,a),width=width)
def tickring(p,x,y,r,color,a=120,count=80,phase=0):
 for k in range(count):
  angle=k/count*math.tau+phase; length=9 if k%5==0 else 3
  p.line([(x+math.cos(angle)*r,y+math.sin(angle)*r),(x+math.cos(angle)*(r-length),y+math.sin(angle)*(r-length))],rgba(color,a),1)
def orbit(p,x,y,rx,ry,rotation,c,a=80,phase=0,progress=1,width=1.3):
 points=[]
 for k in range(int(160*progress)+1):
  ang=phase+k/160*math.tau;u=rx*math.cos(ang);v=ry*math.sin(ang)
  points.append((x+u*math.cos(rotation)-v*math.sin(rotation),y+u*math.sin(rotation)+v*math.cos(rotation)))
 p.line(points,rgba(c,a),width)

def node(p,x,y,r,c,alpha=255):
 p.ellipse((x-r*3,y-r*3,x+r*3,y+r*3),color=rgba(c,alpha*.10))
 p.ellipse((x-r,y-r,x+r,y+r),color=rgba(c,alpha))

def grid(p,c,t,dark=True):
 a=11 if dark else 15
 for x in range(40,W,40):p.line([(x,0),(x,H)],rgba(c,a))
 for y in range(40,H,40):p.line([(0,y),(W,y)],rgba(c,a))
 for x,y in [(62,58),(W-62,58),(62,H-58),(W-62,H-58)]:
  p.line([(x-6,y),(x+6,y)],rgba(c,65));p.line([(x,y-6),(x,y+6)],rgba(c,65))

@lru_cache(maxsize=12)
def background(index):
 _,_,low,high,accent,other,*_=DESIGNS[index]
 yy,xx=np.mgrid[0:H,0:W].astype(np.float32)
 xx/=W;yy/=H
 field=.20+.7*np.exp(-((xx-.84)**2/.6+(yy-.18)**2/.8))
 pixels=np.array(rgb(low))+field[...,None]*(np.array(rgb(high))-np.array(rgb(low)))
 noise=np.random.default_rng(4510+index).normal(0,.3,(H,W,1))
 return Image.fromarray(np.clip(pixels+noise,0,255).astype(np.uint8),'RGB').resize((W*S,H*S))

def draw(index,t):
 item=DESIGNS[index]; c,alt=item[4],item[5]; e=entrance(t); t=min(t,4.0)+.15*ease((t-4.0)/.8); phase=t*.17
 image=background(index).convert('RGBA');lay=Image.new('RGBA',image.size);p=Pen(lay)
 grid(p,c,t,index not in (1,4,7,10))
 # A quiet editorial perimeter gives the collection a consistent visual identity.
 p.line([(80,85),(80+e*158,85)],rgba(c,135),1.4)
 p.line([(W-238,H-77),(W-238+e*158,H-77)],rgba(c,110),1.4)
 if index==0:
  x,y=1040,220; r=190+10*(1-e)
  p.ellipse((x-r,y-r,x+r,y+r),color=rgba(c,26),outline=rgba(c,185),width=2.0)
  for k in range(1,8):orbit(p,x,y,r*k/8,r,.0,c,72 if k==4 else 38,progress=e)
  for k in range(1,8):orbit(p,x,y,r,r*k/8,0,c,120 if k==4 else 45,progress=e)
  tickring(p,x,y,r+32,c,100*e,96,phase*.12)
  for k in range(3):orbit(p,x,y,260+k*25,90+k*24,-.38+k*.1,alt,220-k*36,phase,e,2 if k==0 else 1.4)
  node(p,x+math.cos(t*.55)*260,y+math.sin(t*.55)*95,5.5,alt,255)
  for k in range(45):
   px=(k*113.71)%W;py=(k*37.4)%H
   if py<220 or py>510:node(p,px,py,.8+(k%3)*.3,c,50+90*(.5+.5*math.sin(t+k)))
  p.line([(90,572),(250,572),(310,530),(410,530)],rgba(alt,140*e),1.2)
  node(p,310,530,2.8,alt)
 elif index==1:
  # Refraction is a composition, not a literal scientific simulation.
  x,y=240,215;sh=22*(1-e);tri=[(x,y-150+sh),(x-140,y+110+sh),(x+145,y+110+sh)]
  p.polygon(tri,rgba('#ffffff',145));p.polygon([(x,y-150+sh),(x+145,y+110+sh),(x+36,y+49+sh)],rgba(alt,32));p.line(tri+[tri[0]],rgba(alt,185),2.2)
  p.line([(x+12,y-125),(x-116,y+96),(x+120,y+96),(x+12,y-125)],rgba(alt,45),1)
  p.line([(60,y-10),(x+10,y+34)],rgba(alt,135*e),3)
  bands=['#ba715a','#c89957','#b9af65','#74a69c','#648ba6','#8b82a9']
  for k,col in enumerate(bands):
   p.polygon([(x+8,y+35),(x+14,y+48),(W+100,558+k*21),(W+100,538+k*21)],rgba(col,100*entrance(t,k*.04)))
  for k in range(17):
   x0=865+k*12;p.line([(x0,110),(x0,110+(15 if k%4==0 else 6))],rgba(alt,95))
  for k in range(5):orbit(p,1060,580,100+k*18,38+k*8,-.55,c,24+k*9,phase,e)
 elif index==2:
  # Two separate helical columns frame the editable titles.
  for cx,sign in [(178,1),(1100,-1)]:
   cx-=sign*230*(1-e)
   for strand in [0,1]:
    points=[]
    for k in range(115):
     y=145+k*4;theta=k*.105+phase+strand*math.pi;points.append((cx+math.sin(theta)*62,y+18*(1-e)))
    p.line(points,rgba(c if strand==0 else alt,235),2.8)
   for k in range(20):
    y=155+k*23;theta=(y-145)/4*.105+phase
    x1=cx+math.sin(theta)*62;x2=cx-math.sin(theta)*62
    a=145+70*math.cos(theta);p.line([(x1,y),(x2,y)],rgba(c,a),1.2)
    node(p,x1,y,4.3+math.cos(theta),c,a);node(p,x2,y,4.3-math.cos(theta),alt,a)
  for k in range(28):
   x=330+(k*113)%640;y=100+(k*61)%530
   if y<210 or y>530:circle(p,x+5*math.sin(t+k),y,2+k%4,c,55)
  p.line([(412,616),(868,616)],rgba(c,60));node(p,640,616,3,alt)
 elif index==3:
  x,y=1052,202
  for r in [42,55,91,117,146]:circle(p,x,y,r,c,95*e)
  tickring(p,x,y,133,alt,140,72,phase*.12)
  for a in range(0,360,45):
   theta=math.radians(a);p.line([(x+math.cos(theta)*35,y+math.sin(theta)*35),(x+math.cos(theta)*145,y+math.sin(theta)*145)],rgba(c,38))
  for off in [-125,-75,75,125]:p.line([(x-170,y+off),(x+170,y+off)],rgba(c,25))
  p.line([(x-175,y-163),(x+175,y-163)],rgba(alt,80));p.line([(x-175,y-168),(x-175,y-158)],rgba(alt,130));p.line([(x+175,y-168),(x+175,y-158)],rgba(alt,130))
  for j in range(4):
   bx=95+j*43;by=557-j*13-20*(1-entrance(t,j*.12));poly=[(bx,by),(bx+90,by-38),(bx+160,by+5),(bx+70,by+43)]
   p.polygon(poly,rgba(c,12));p.line(poly+[poly[0]],rgba(c,105),1.2)
   for v in poly:p.line([v,(v[0],v[1]+19)],rgba(c,28))
  p.line([(450,584),(580,584),(611,615),(804,615)],rgba(alt,100*e));node(p,450,584,3,alt)
 elif index==4:
  pts=[]
  for k in range(33):
   x=70+(k*157)%1140;y=125+(k*83)%510
   if 240<y<500 and 275<x<1010:continue
   pts.append((x+4*math.sin(phase+k),y+5*math.cos(phase+k)))
  for j,a in enumerate(pts):
   for b in pts[j+1:]:
    d=math.dist(a,b)
    if 65<d<225:p.line([a,b],rgba(c,(1-d/240)*145*e),1.2)
   node(p,*a,3+(j%3)*.6,c,205*entrance(t,j*.025))
  for k in range(28):
   x=345+k*23;top=606-(18+40*(.5+.5*math.sin(k*.43)))*entrance(t,k*.017)
   p.rectangle((x,top,x+7,607),color=rgba(c,105+(k%4)*20))
  p.line([(330,612),(1010,612)],rgba(alt,80))
  for k in range(6):p.line([(78,174+k*10),(78+120-(k%3)*28,174+k*10)],rgba(c,55),1.5)
 elif index==5:
  cx,cy=1035,240
  for ring in range(22):
   pts=[]
   for k in range(180):
    a=k/179*math.tau;rad=25+ring*9+(8+ring*.24)*math.sin(a*3+phase)+6*math.cos(a*5-phase*.4)
    pts.append((cx+math.cos(a)*rad,cy+math.sin(a)*rad*.88))
   p.line(pts,rgba(alt if ring==14 else c,(235 if ring==14 else 130 if ring%4==0 else 55)*e),2.5 if ring==14 else 1.15 if ring%4==0 else .7)
  tickring(p,cx,cy,239,alt,95,100)
  for row in range(9):
   pts=[]
   for k in range(85):
    x=58+k*7;y=625-row*10-32*math.exp(-((x-280)/135)**2)-9*math.sin(x/70+phase+row*.11);pts.append((x,y))
   p.line(pts,rgba(alt,225 if row==8 else 48+row*5),1.8 if row==8 else 1)
  p.line([(87,168),(87,245)],rgba(c,100));p.line([(80,175),(87,163),(94,175)],rgba(c,120))
 elif index==6:
  # Planetary horizon and a quiet return trajectory, distinct from the opener's globe.
  cx,cy=640,1285
  for radius in [655,668,681,700]:p.arc((cx-radius,cy-radius,cx+radius,cy+radius),207,333,rgba(c,65 if radius!=668 else 150),1.4)
  for k in range(17):
   x=85+k*70;y=619-105*math.sin((x/W)*math.pi);p.line([(x,y),(x+(640-x)*.17,720)],rgba(c,22))
  for k in range(31):
   x=(k*149.7)%W;y=72+(k*57)%150;node(p,x,y,.7+k%3*.2,c,55+60*math.sin(t*.5+k)**2)
  pts=[]
  for k in range(120):
   u=k/119;x=150+u*980;y=222-120*math.sin(u*math.pi)+12*math.sin(u*math.tau+phase);pts.append((x,y))
  p.line(pts[:max(2,int(120*e))],rgba(alt,70),1)
  a=.12+(t*.035)%1;node(p,150+a*980,222-120*math.sin(a*math.pi)+12*math.sin(a*math.tau+phase),3,alt,230)
 elif index==7:
  colors=['#c17b60','#bda66b','#7eaa9e','#6f9eb4','#9b8cac']
  for j,col in enumerate(colors):
   pts=[]
   for k in range(160):
    x=k/159*W;y=575+j*13+27*math.sin(x/215+phase+j*.13);pts.append((x,y))
   p.line(pts,rgba(col,135*entrance(t,j*.12)),4)
  # A disassembled prism at the upper left; no baked-in title.
  for offset in range(4):
   x=117+offset*32;y=142+offset*7;pts=[(x,y),(x+52,y-28),(x+106,y),(x+54,y+28),(x,y)]
   p.line(pts,rgba(c,70+offset*15),1);p.line([(x+54,y+28),(x+54,y+83),(x+106,y+55),(x+106,y)],rgba(c,80))
  for k in range(15):p.line([(1101,112+k*7),(1101+(16 if k%3==0 else 7),112+k*7)],rgba(c,70))
  circle(p,1020,190,42,alt,70);p.arc((961,131,1079,249),t*15,t*15+238,rgba(alt,140),1.4)
 elif index==8:
  # Molecule bonds grow from the corners and leave a calm conclusion stage.
  for base_x,base_y,sign in [(190,150,1),(1080,570,-1)]:
   centers=[(base_x,base_y),(base_x+sign*85,base_y+49),(base_x+sign*85,base_y-49),(base_x+sign*170,base_y)]
   for j,(cx,cy) in enumerate(centers):
    off=8*(1-entrance(t,j*.13))*sign
    pts=[(cx+math.cos(k/6*math.tau)*49+off,cy+math.sin(k/6*math.tau)*49) for k in range(7)]
    p.line(pts,rgba(c,105*entrance(t,j*.13)),1.4)
    for k,(px,py) in enumerate(pts[:-1]):node(p,px,py,2.2,alt if k%3==0 else c,170)
  for k in range(11):
   x=340+k*60;y=594+10*math.sin(k*.6+phase);node(p,x,y,1.4,c,75);p.line([(x,y),(x+40,y-10)],rgba(c,35))
  for k in range(3):p.arc((875-k*24,58-k*24,1100+k*24,283+k*24),200+phase*12,345+phase*12,rgba(alt,50-k*10))
 elif index==9:
  # Projection views and a four-stage path settle into an engineering archive.
  for j in range(3):
   x=105+j*97;y=151
   p.rectangle((x,y,x+63,y+63),outline=rgba(c,55),width=1)
   if j==0:circle(p,x+31,y+31,24,alt,110)
   elif j==1:
    p.line([(x+10,y+50),(x+30,y+10),(x+53,y+50),(x+10,y+50)],rgba(alt,110),1.4)
   else:
    p.line([(x+10,y+50),(x+10,y+15),(x+50,y+15),(x+50,y+50),(x+10,y+50)],rgba(alt,110))
  points=[(300,585),(520,585),(740,585),(960,585)]
  p.line(points,rgba(c,60),1)
  for j,(x,y) in enumerate(points):
   circle(p,x,y,11,c,150*entrance(t,j*.2));node(p,x,y,3,alt,200*entrance(t,j*.2));p.line([(x-33,y+29),(x+33,y+29)],rgba(c,70))
  for j in range(3):
   rad=60+j*22;p.arc((1080-rad,185-rad,1080+rad,185+rad),-75+t*5,210+t*5,rgba(c,80-j*18),1)
  tickring(p,1080,185,116,alt,90,48)
 elif index==10:
  # Three actual chart motifs form a visual conclusion without fake numeric claims.
  for card in range(3):
   x=200+card*310;y=547;cw=260;ch=90
   p.rectangle((x,y,x+cw,y+ch),color=rgba('#ffffff',37),outline=rgba(c,42))
   p.line([(x+17,y+ch-18),(x+cw-17,y+ch-18)],rgba(c,50))
   if card==0:
    pts=[(x+20+k*18,y+65-(15+20*math.sin(k*.3))*entrance(t,k*.025)) for k in range(13)];p.line(pts,rgba(c,165),2)
   elif card==1:
    for k in range(12):p.rectangle((x+20+k*18,y+70-(12+(k*11)%43)*entrance(t,k*.025),x+28+k*18,y+70),color=rgba(c,130+k%3*30))
   else:
    for k in range(18):node(p,x+22+(k*31)%214,y+20+(k*17)%48,1.7,alt,150)
  for j in range(5):
   p.line([(85,144+j*12),(85+142-(j%3)*28,144+j*12)],rgba(c,65))
  for k in range(13):
   angle=k*2.4;rr=15+k*5;node(p,1090+math.cos(angle+phase)*rr,165+math.sin(angle+phase)*rr*.7,2,c,105)
 elif index==11:
  # Terrain becomes a measured horizon rather than repeating the opener's contour disc.
  for row in range(18):
   pts=[]
   for k in range(140):
    x=k/139*W;y=596+row*7-58*math.exp(-((x-340)/165)**2)-90*math.exp(-((x-945)/205)**2)+6*math.sin(x/80+row*.2+phase)
    pts.append((x,y+20*(1-e)))
   p.line(pts,rgba(c,40+(row%4)*12),1)
  for col in range(22):
   x=col/21*W;p.line([(x,603-65*math.sin(x/180)**2),(x,720)],rgba(c,20))
  for k in range(9):p.arc((950-k*8,68-k*6,1140+k*8,248+k*6),155,355,rgba(alt,35+k*6))
  circle(p,190,168,47,c,90);p.line([(132,168),(248,168)],rgba(c,60));p.line([(190,110),(190,226)],rgba(c,60))
  node(p,190+math.cos(phase)*47,168+math.sin(phase)*47,3,alt,200)
 lay.putalpha(lay.getchannel('A').point(lambda a:round(a*e)))
 image=Image.alpha_composite(image,lay)
 # Slight settle-out provides motion at both ends without black video frames.
 return image.convert('RGB').resize((W,H),Image.Resampling.LANCZOS)


def contact(indices,output):
 times=[0.35,1.1,2.4,4.8]
 out=Image.new('RGB',(1280,218*len(indices)), '#10131a')
 fontpath='/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc'
 font=ImageFont.truetype(fontpath,16) if Path(fontpath).exists() else ImageFont.load_default()
 titlefont=ImageFont.truetype(fontpath,66) if Path(fontpath).exists() else ImageFont.load_default()
 small=ImageFont.truetype(fontpath,27) if Path(fontpath).exists() else ImageFont.load_default()
 for row,index in enumerate(indices):
  for col,t in enumerate(times):
   frame=draw(index,t);d=ImageDraw.Draw(frame);entry=DESIGNS[index];color='#203c42' if index in(1,4,7,10) else '#eff4f1'
   if t>=1.1:
    d.text((640,338),entry[6],font=titlefont,fill=color,anchor='mm')
    d.text((640,443),entry[7],font=small,fill=color,anchor='mm')
   frame=frame.resize((320,180));out.paste(frame,(col*320,row*218+32))
   d=ImageDraw.Draw(out);d.text((col*320+8,row*218+7),f'{entry[1]}  {t:.2f} s',font=font,fill='white')
 out.save(output)
 print(str(output),flush=True)


def main():
 parser=argparse.ArgumentParser(description=__doc__)
 parser.add_argument('--ids',nargs='*')
 parser.add_argument('--contact',type=Path)
 parser.add_argument('--contact-only',action='store_true')
 args=parser.parse_args()
 if args.ids and set(args.ids)-{design[0] for design in DESIGNS}:parser.error('Unknown design id')
 indices=[i for i,e in enumerate(DESIGNS) if not args.ids or e[0] in args.ids]
 if args.contact:contact(indices,args.contact)
 if args.contact_only:return
 OUTPUT.mkdir(parents=True,exist_ok=True)
 for index in indices:
  name=DESIGNS[index][0];dest=OUTPUT/f'{name}.webm'
  command=['ffmpeg','-hide_banner','-loglevel','error','-y','-f','rawvideo','-pix_fmt','rgb24','-s',f'{W}x{H}','-r',str(FPS),'-i','pipe:0','-an','-c:v','libvpx-vp9','-b:v','0','-crf','29','-deadline','good','-cpu-used','4','-row-mt','1','-threads','2','-pix_fmt','yuv420p','-metadata','comment=Original Open Media science motion composition',str(dest)]
  with subprocess.Popen(command,stdin=subprocess.PIPE) as encoder:
   try:
    for frame in range(FPS*DURATION):encoder.stdin.write(draw(index,frame/FPS).tobytes())
   finally:encoder.stdin.close()
   if encoder.wait()!=0:raise RuntimeError(f'Encoding failed: {name}')
  subprocess.run(['ffmpeg','-hide_banner','-loglevel','error','-y','-ss','2.4','-i',str(dest),'-frames:v','1','-vf','scale=640:360','-q:v','3',str(OUTPUT/f'{name}.jpg')],check=True)
  print(f'{name}: {dest.stat().st_size:,} bytes',flush=True)
 records=[]
 for design in DESIGNS:
  path=OUTPUT/f'{design[0]}.webm'
  if path.exists():records.append(dict(id=design[0],filename=path.name,poster=f'{design[0]}.jpg',width=W,height=H,fps=FPS,duration=DURATION,size=path.stat().st_size,sha256=hashlib.sha256(path.read_bytes()).hexdigest()))
 (OUTPUT/'manifest.json').write_text(json.dumps(dict(author='Open Media',license='MIT',generator='scripts/generate-science-segments.py',items=records),ensure_ascii=False,indent=2)+'\n')

if __name__=='__main__':main()
