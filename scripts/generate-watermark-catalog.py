#!/usr/bin/env python3
"""Generate the original, offline themed watermark catalog (media only, no application build).

The original 18 animations remain untouched. Each category adds enough distinct
subjects to reach 100, and text entries keep their editable source separate from
preview PNGs. Requires Pillow, ffmpeg, CJK sans-serif/serif fonts and a monospace
font. Explicit font paths can be supplied for every family and weight.
"""
import argparse
import concurrent.futures
import hashlib
import importlib.util
import json
import math
import random
from functools import lru_cache
import pathlib
import subprocess
import sys
from PIL import Image, ImageDraw, ImageFont, ImageFilter, ImageChops, ImageColor

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location('overlay_painter', ROOT / 'scripts/generate-watermarks.py')
base = importlib.util.module_from_spec(spec)
spec.loader.exec_module(base)
SIZE = (640, 360)
FPS = 24
DURATION = 4

# Every row is a distinct subject. Texts are original, editable starting points.
SUBJECTS = '''sunrise|清晨|sun|早起打卡|美好从早晨开始|晨光序章|把今天过成喜欢的样子
coffee|咖啡|cup|咖啡续航|休息一下喝杯咖啡|咖啡时光|给生活一点醇香
reading|阅读|book|一起读书|这段值得记下来|阅读笔记|在文字里遇见远方
plants|绿植|plant|养绿计划|记得给绿植浇水|植物日记|和一片新叶一起生长
pets|宠物|paw|可爱警报|请注意小可爱出没|萌宠日常|今天也被可爱治愈
breakfast|早餐|egg|早餐打卡|早餐别忘了蛋白质|早餐研究所|认真吃早餐认真过生活
commute|通勤|bus|出发上班|出行请注意安全|通勤路上|每一次出发都有期待
cooking|烹饪|chef|今天我掌勺|小火慢煮更入味|家常味道|把日子煮成热气腾腾
baking|烘焙|cake|甜蜜出炉|烤箱温度提前设好|烘焙手记|幸福有刚出炉的香气
tea|茶饮|cup|慢慢喝茶|给自己片刻放松|茶间小憩|慢下来喝一杯好茶
fruit|水果|apple|水果自由|新鲜水果及时享用|鲜果时刻|给日常加一点清甜
noodles|面食|bowl|嗦面快乐|汤汁趁热更香|一碗烟火|生活的滋味藏在碗里
barbecue|烧烤|flame|烧烤集合|炭火附近注意安全|烟火夜食|和朋友分享热气腾腾
dessert|甜品|ice|甜一下吧|今日甜度刚刚好|甜品地图|平凡的日子也值得加糖
picnic|野餐|basket|野餐走起|离开前带走垃圾|草地午后|把餐桌搬进春风里
travel|旅行|plane|旅行出发|证件行李记得检查|旅行手帐|出发寻找新的风景
mountain|登山|mountain|山顶见|山路湿滑留意脚下|山野纪行|一步一步走向山顶
camping|露营|tent|露营集合|野外用火注意安全|星空营地|把晚安说给星空听
beach|海边|wave|海边度假|游泳请在安全区域|听海日记|让海风吹散所有烦恼
citywalk|城市漫游|building|一起走走|下一站路口左转|城市切片|走慢一点发现城市
roadtrip|自驾|car|自驾出发|请系好安全带|公路故事|一路向前风景正好
railtrip|铁路旅行|train|坐上列车|提前到站从容出行|窗外世界|窗外的风景正在更新
cycling|骑行|bike|骑行打卡|头盔护具不能少|骑行轨迹|风从耳边经过
running|跑步|shoe|今日开跑|热身之后再出发|跑步记录|每一步都在超越昨天
yoga|瑜伽|leaf|伸展一下|缓慢呼吸感受身体|柔韧时刻|让身体和心一起放松
fitness|健身|weight|力量打卡|动作标准更重要|力量训练|把坚持练成自己的力量
basketball|篮球|ball|球场见|队友的位置在这里|球场瞬间|热爱就要全力以赴
football|足球|ball|进球欢呼|看准时机传球|绿茵时刻|每一次奔跑都算数
swimming|游泳|wave|畅游一下|下水前做好热身|水中律动|找到属于自己的节奏
badminton|羽毛球|feather|挥拍出击|关注落点及时回位|羽你同行|让热爱轻盈起飞
skiing|滑雪|snow|雪场集合|控制速度注意防护|雪线之上|在雪地写下自由
skating|滑板|board|滑起来吧|先练习稳定站姿|街头节奏|找回身体里的轻盈
study|学习|book|学习打卡|重要知识记笔记|学习日志|今天多懂一点点
exam|考试|pencil|考试加油|答题前先看清题目|备考时刻|所有努力都会有回响
language|语言|chat|开口练习|听清发音再跟读|语言小课堂|用新的语言认识世界
graduation|毕业|cap|毕业快乐|记住这一天的笑脸|毕业纪念|奔赴下一场山海
school|校园|building|校园见|课堂重点在这里|校园日常|青春就在此刻发生
science|科学|flask|实验开始|请按照规范操作|科学观察|每个问题都值得探索
math|数学|ruler|解题成功|关键条件别漏掉|数学解密|换个角度看见答案
history|历史|scroll|时光探索|注意事件时间顺序|历史回声|听见岁月留下的回响
geography|地理|globe|发现世界|地图比例尺要留意|地理漫游|世界比想象更加辽阔
coding|编程|code|代码通过|边界条件不要遗漏|编程手记|把想法变成可以运行的作品
technology|科技|chip|科技探索|新功能演示开始|科技前沿|让想象走进现实
robot|机器人|robot|机器伙伴|请留意运行状态|智能时刻|一起探索未来的可能
gadgets|数码|phone|开箱看看|参数对比看这里|数码开箱|发现好用的小工具
photography|摄影|camera|定格美好|对焦之后再按快门|光影记录|留住值得珍藏的一瞬
filming|拍摄|clapper|开拍啦|检查收音和构图|镜头之间|把普通日子拍成故事
editing|剪辑|film|剪辑完成|剪切点注意衔接|剪辑手记|让每一帧都有自己的位置
music|音乐|music|跟着节拍|耳机音量不宜过大|音乐现场|让旋律陪伴这一刻
singing|歌唱|mic|一起唱吧|气息平稳再发声|声音日记|把心情唱成一首歌
dance|舞蹈|spark|舞动起来|先熟悉节奏再跟练|舞动时刻|用身体表达快乐
painting|绘画|palette|画画打卡|先观察再下笔|画室日常|给世界添一种颜色
crafts|手工|scissors|亲手制作|裁剪时注意安全|手作温度|用双手留住小小热爱
pottery|陶艺|vase|捏出灵感|保持陶土适当湿润|泥土诗篇|在指尖塑造想象
journaling|手帐|pencil|手帐记录|今日重点写下来|手帐片段|把值得记住的事收藏起来
games|游戏|game|这一局稳了|注意技能冷却时间|游戏时刻|快乐就从这一局开始
puzzles|解谜|puzzle|解谜成功|线索可能就在身边|谜题时刻|答案藏在细节之中
chess|棋艺|crown|落子无悔|先观察再做决定|棋盘故事|每一步都是新的可能
work|办公|laptop|工作推进|任务优先级先明确|工作片刻|专注做好眼前这一件事
meeting|会议|chat|讨论开始|关键结论请记录|会议要点|让每个好想法被听见
planning|计划|calendar|计划完成|截止时间别忘记|计划清单|把目标写进每一天
productivity|效率|clock|专注一下|一次专心做好一件事|高效时段|给专注留一点安静
business|商业|chart|目标达成|数据来源需要核实|商业观察|让每一次决策更有依据
shopping|购物|bag|好物分享|下单前核对规格|好物清单|把钱花在真正喜欢的地方
fashion|穿搭|shirt|今日穿搭|搭配重点看配色|穿搭日记|穿出自己的心情
beauty|美妆|mirror|焕新一下|敏感肤质先做测试|美妆手记|遇见更加自信的自己
wellness|健康|heart|健康打卡|感到不适及时休息|健康日常|好好照顾自己就是重要的事
sleep|睡眠|moon|晚安好梦|睡前减少屏幕时间|晚安时刻|愿你今夜拥有温柔的梦
family|家庭|house|家人团聚|多留一点陪伴时间|家的温度|最好的风景是家人的笑脸
friends|朋友|people|朋友集合|别忘了约定时间|相聚时刻|快乐因为分享而加倍
love|恋爱|heart|心动一下|把喜欢认真表达|心动片段|遇见你是今天的好消息
wedding|婚礼|ring|新婚快乐|留下幸福的纪念|婚礼纪事|愿岁岁年年都有你
birthday|生日|cake|生日快乐|记得许下一个心愿|生日限定|愿所有美好如期而至
anniversary|纪念日|gift|纪念这天|重要日子值得记录|时光纪念|把平凡过成值得纪念
newyear|新年|lantern|新年快乐|新的一年从心出发|新年序章|愿新岁平安喜乐
spring|春日|flower|春日出游|花开正好别错过|春天来信|把春天装进口袋
summer|夏日|sun|夏日限定|高温出行注意补水|盛夏光年|夏天的快乐正在发生
autumn|秋日|leaf|秋日漫步|天凉记得添衣|秋日私语|把温柔留给这个秋天
winter|冬日|snow|冬日暖暖|寒冷天气注意保暖|冬日篇章|温暖会在冬天相遇
midautumn|中秋|moon|中秋团圆|抬头一起看月亮|月圆时分|愿人长久共赏月圆
lanternfestival|元宵|lantern|元宵快乐|甜蜜汤圆趁热吃|灯火元宵|灯火可亲团圆可期
dragonboat|端午|boat|端午安康|夏日饮食注意卫生|粽香时节|愿所有美好接粽而来
halloween|奇趣夜|pumpkin|奇趣派对|惊喜马上揭晓|奇妙夜晚|今夜让想象自由奔跑
holiday|节日|gift|节日快乐|给重要的人送祝福|节日心意|愿今天被快乐填满
rain|雨天|umbrella|雨天也好|雨天路滑慢慢走|雨声日记|听雨也是一种浪漫
snowday|飘雪|snow|下雪啦|雪地行走注意防滑|初雪记忆|和第一场雪打个招呼
rainbow|彩虹|rainbow|好运出现|雨后记得看看天空|彩虹时刻|风雨之后总有新的色彩
stargazing|观星|planet|仰望星空|远离光源更易观测|星空漫游|每颗星都有自己的故事
sunset|日落|sun|日落打卡|美好转瞬记得珍惜|落日余晖|今天也被晚霞温柔以待
flowers|花艺|flower|花开正好|花枝斜剪更易吸水|花间故事|把生活整理成花开的样子
nature|自然|tree|走进自然|请保护身边的生态|自然笔记|在自然里找回呼吸
wildlife|动物|paw|发现新朋友|野生动物请勿投喂|动物观察|尊重每一种生命
marine|海洋|fish|海洋探索|不要触碰陌生生物|海底世界|蓝色世界还有许多秘密
space|航天|rocket|向太空出发|关注发射倒计时|宇宙来信|奔向更遥远的星辰
energy|新能源|battery|绿色充能|节约用电从小事做起|能量新生|给未来多一点绿色
recycling|环保|recycle|环保行动|请把垃圾正确分类|绿色生活|让改变从今天开始
volunteer|志愿|hands|温暖传递|帮助别人量力而行|公益时刻|微小善意也能照亮世界
milestone|成长|flag|又进步了|记住今天的成长|成长纪念|慢慢来你已经走了很远
success|成就|medal|做得漂亮|这份努力值得肯定|高光时刻|请为坚持的自己喝彩
farewell|告别|plane|下次再见|离开前检查随身物品|再见时刻|此刻告别是为了更好的重逢'''

PALETTES = [
    ('#f08e75', '#fff0e6', '#42394a'), ('#a486ed', '#f0e9ff', '#38324f'),
    ('#48aabb', '#e0f6fa', '#183f50'), ('#edba4b', '#fff7d5', '#584323'),
    ('#dd729c', '#ffe7f0', '#532c49'), ('#5c9acc', '#e5f0ff', '#223f63'),
    ('#7aa881', '#eaf4e8', '#2d4c3a'), ('#bc8b67', '#fff0df', '#543b32'),
    ('#bd77c2', '#f9e8ff', '#4b2f55'), ('#de8057', '#ffeddc', '#5e362c'),
]
CATEGORIES = [('sticker', '互动贴纸', 5), ('motion', '装饰动效', 5), ('callout', '提示标注', 5), ('label', '字幕标签', 3), ('text', '可编辑文字', 0)]


def subjects():
    rows = [line.split('|') for line in SUBJECTS.splitlines() if line]
    assert len(rows) == 100, len(rows)
    assert len({row[0] for row in rows}) == 100
    return rows


def polygon(p, points, accent, ink):
    p.polygon(points, accent, ink, 3)


def draw_icon(p, icon, x, y, size, accent, paper, ink):
    """Small original pictograms assembled from lines and geometric primitives."""
    r = size / 2
    def line(points, width=4, color=ink): p.line([(x + a*r, y + b*r) for a,b in points], color, width)
    def box(bounds, color=accent, radius=8, width=3): p.rounded(tuple((x if i % 2 == 0 else y) + v*r for i,v in enumerate(bounds)), radius, color, ink, width)
    def ellipse(bounds, color=accent, width=3): p.ellipse(tuple((x if i % 2 == 0 else y) + v*r for i,v in enumerate(bounds)), color, ink, width)
    def poly(points, color=accent): p.polygon([(x+a*r,y+b*r) for a,b in points], color, ink,3)
    if icon == 'sun':
        ellipse((-.5,-.5,.5,.5))
        for n in range(8):
            a=math.tau*n/8; line([(math.cos(a)*.7,math.sin(a)*.7),(math.cos(a)*.98,math.sin(a)*.98)],4,accent)
    elif icon == 'cup':
        box((-.65,-.35,.45,.7),paper,12); p.arc((x+.2*r,y-.24*r,x+.98*r,y+.4*r),-90,90,ink,4)
        line([(-.8,.82),(.8,.82)],3); line([(-.3,-.6),(-.15,-.8),(-.3,-1)],3,accent);line([(.1,-.6),(.25,-.8)],3,accent)
    elif icon in ('book','scroll'):
        poly([(-.9,-.6),(-.2,-.65),(0,-.45),(.2,-.65),(.9,-.6),(.9,.65),(.2,.55),(0,.75),(-.2,.55),(-.9,.65)],paper)
        line([(0,-.4),(0,.7)],3,accent)
        for q in [-.25,.05,.35]:line([(-.7,q),(-.2,q-.04)],2);line([(.2,q-.04),(.7,q)],2)
    elif icon in ('plant','tree','leaf','feather'):
        line([(0,.9),(0,-.8)],4);poly([(0,-.4),(-.6,-.9),(-.85,-.35),(-.65,0),(0,.2)]);poly([(0,.1),(.65,-.55),(.9,-.1),(.7,.3),(0,.5)],paper)
        if icon == 'plant':poly([(-.5,.45),(.5,.45),(.35,.95),(-.35,.95)],accent)
    elif icon == 'paw':
        ellipse((-.5,-.1,.5,.75));
        for a,b in [(-.75,-.4),(-.3,-.75),(.3,-.75),(.75,-.4)]:ellipse((a-.17,b-.22,a+.17,b+.22),paper)
    elif icon == 'egg':
        poly([(-.7,-.5),(-.2,-.85),(.3,-.75),(.75,-.3),(.9,.3),(.35,.75),(-.4,.8),(-.85,.3)],paper);ellipse((-.35,-.25,.35,.45), '#edba4b')
    elif icon in ('bus','train','car'):
        box((-.9,-.65,.9,.55),paper,13);box((-.6,-.4,.6,.05),accent,5)
        if icon == 'car':line([(-.7,-.65),(-.45,-.95),(.45,-.95),(.75,-.65)])
        ellipse((-.65,.4,-.3,.8),ink);ellipse((.3,.4,.65,.8),ink);line([(-.6,.22),(-.4,.22)],3);line([(.4,.22),(.6,.22)],3)
    elif icon == 'chef':
        ellipse((-.85,-.65,-.1,.15),paper);ellipse((-.4,-.9,.4,.1),paper);ellipse((.1,-.65,.85,.15),paper);box((-.5,-.1,.5,.85),paper,5);line([(-.5,.55),(.5,.55)],4,accent)
    elif icon == 'cake':
        box((-.8,-.15,.8,.8),paper);line([(-.75,.2),(-.4,.35),(0,.2),(.4,.35),(.75,.2)],5,accent)
        for q in [-.45,0,.45]:line([(q,-.15),(q,-.65)],4,accent);p.ellipse((x+(q-.07)*r,y-.95*r,x+(q+.07)*r,y-.72*r), '#edba4b')
    elif icon in ('apple','pumpkin'):
        ellipse((-.8,-.5,.2,.8),accent);ellipse((-.2,-.5,.8,.8),accent);line([(0,-.45),(.1,-.9)],4);poly([(.1,-.65),(.35,-1),(.7,-.8)],paper)
        if icon=='pumpkin':poly([(-.4,-.1),(-.2,-.3),(-.05,0)],ink);poly([(.15,-.1),(.35,-.3),(.5,0)],ink);line([(-.35,.45),(.4,.45)],4)
    elif icon in ('bowl','basket'):
        poly([(-.9,-.1),(.9,-.1),(.6,.65),(-.6,.65)],paper);line([(-.5,.8),(.5,.8)],4)
        if icon=='bowl':line([(-.5,-.35),(-.65,-.55),(-.5,-.8)],3,accent);line([(.2,-.35),(.35,-.6),(.2,-.9)],3,accent)
        else:p.arc((x-.55*r,y-.85*r,x+.55*r,y+.35*r),180,360,accent,6)
    elif icon in ('flame','ice'):
        if icon=='flame':poly([(0,-1),(.25,-.35),(.6,-.55),(.9,.1),(.6,.65),(0,.9),(-.6,.65),(-.9,0),(-.4,-.5),(-.3,.1)],accent);poly([(0,-.2),(.35,.3),(0,.7),(-.35,.3)],paper)
        else:poly([(-.65,-.1),(.65,-.1),(0,.95)],accent);ellipse((-.75,-.9,.15,0),paper);ellipse((-.15,-.9,.75,0),paper)
    elif icon == 'plane':poly([(-1,.1),(.95,-.7),(.5,.85),(.05,.3),(-.25,.65),(-.3,.05)],paper);line([(-.3,.05),(.8,-.6),(.05,.3)],3,accent)
    elif icon in ('mountain','tent'):
        poly([(-1,.8),(-.2,-.9),(.35,.8)],accent);poly([(-.1,.8),(.55,-.55),(1,.8)],paper)
        if icon=='mountain':poly([(-.48,-.3),(-.2,-.9),(.05,-.3),(-.17,-.4)],paper)
        else:poly([(-.6,.8),(-.2,-.1),(.15,.8)],paper)
    elif icon in ('wave','boat','fish'):
        for q in [.4,.7]:line([(-.9,q),(-.6,q-.15),(-.3,q),(.05,q-.15),(.35,q),(.65,q-.15),(.9,q)],3,accent)
        if icon=='boat':poly([(-.85,-.2),(.9,-.2),(.6,.25),(-.55,.25)],paper);line([(0,-.25),(0,-1)],3);poly([(0,-1),(.7,-.35),(0,-.35)],accent)
        elif icon=='fish':ellipse((-.85,-.7,.45,.3),paper);poly([(.4,-.2),(.95,-.65),(.95,.2)],accent);ellipse((-.58,-.42,-.45,-.29),ink,1)
        else:p.arc((x-.8*r,y-.9*r,x+.5*r,y+.45*r),190,355,ink,5);p.arc((x-.65*r,y-.75*r,x+.5*r,y+.25*r),205,355,accent,6)
    elif icon in ('building','house'):
        if icon=='house':poly([(-1,-.1),(0,-.95),(1,-.1)],accent);box((-.7,-.1,.7,.85),paper,0);box((-.15,.3,.25,.85),accent,0)
        else:
            box((-.85,-.55,-.05,.85),paper,4);box((.05,-.95,.85,.85),accent,4)
            for q in [-.65,-.35,.25,.55]:line([(q,-.2),(q,.4)],3,paper if q>0 else accent)
    elif icon in ('bike','board'):
        ellipse((-.95,.2,-.25,.9),paper);ellipse((.25,.2,.95,.9),paper)
        if icon=='bike':line([(-.6,.55),(-.2,-.2),(.3,.55),(-.6,.55),(.2,-.2),(.6,.55)],4,accent);line([(-.35,-.25),(-.05,-.25)],4);line([(.15,-.55),(.35,-.55),(.2,-.2)],4)
        else:box((-.95,-.2,.95,.25),accent,15)
    elif icon=='shoe':poly([(-.9,.2),(-.7,-.65),(-.1,-.5),(.15,0),(.85,.3),(.95,.75),(-.95,.75)],paper);line([(-.95,.55),(.9,.55)],4,accent);line([(-.05,-.05),(-.35,.2)],3);line([(.2,.1),(-.1,.35)],3)
    elif icon=='weight':line([(-.75,0),(.75,0)],10);box((-.85,-.65,-.5,.65),accent);box((.5,-.65,.85,.65),accent);box((-.99,-.4,-.85,.4),paper);box((.85,-.4,.99,.4),paper)
    elif icon=='ball':ellipse((-.9,-.9,.9,.9),paper);line([(-.9,0),(.9,0)],3,accent);line([(0,-.9),(0,.9)],3,accent);p.arc((x-.4*r,y-.9*r,x+.4*r,y+.9*r),-90,90,ink,3);p.arc((x-.4*r,y-.9*r,x+.4*r,y+.9*r),90,270,ink,3)
    elif icon=='snow':
        for n in range(6):
            a=math.tau*n/6;dx,dy=math.cos(a),math.sin(a);line([(0,0),(dx*.95,dy*.95)],4,accent)
            for side in [-1,1]:line([(dx*.55,dy*.55),(dx*.75-dy*.2*side,dy*.75+dx*.2*side)],3,accent)
    elif icon in ('pencil','ruler'):
        poly([(-.75,.7),(-.55,.05),(.5,-.95),(.95,-.5),(-.05,.55)],paper);line([(-.4,.2),(.65,-.8)],3,accent)
        if icon=='ruler':
            for q in [-.25,0,.25,.5]:line([(q,-q-.1),(q+.15,-q+.05)],3)
    elif icon=='chat':box((-.95,-.75,.95,.45),paper,15);poly([(-.45,.45),(-.5,.9),(.1,.45)],paper);line([(-.55,-.3),(.55,-.3)],4,accent);line([(-.55,.05),(.2,.05)],3)
    elif icon=='cap':poly([(-1,-.35),(0,-.85),(1,-.35),(0,.2)],accent);poly([(-.6,-.1),(0,.3),(.6,-.1),(.6,.5),(0,.8),(-.6,.5)],paper);line([(.95,-.35),(.95,.65)],3)
    elif icon=='flask':poly([(-.25,-1),(.25,-1),(.25,-.2),(.85,.7),(.7,.9),(-.7,.9),(-.85,.7),(-.25,-.2)],paper);poly([(-.55,.35),(.55,.35),(.7,.7),(-.7,.7)],accent);ellipse((-.2,.03,0,.23),accent,1)
    elif icon=='globe':ellipse((-.9,-.9,.9,.9),paper);ellipse((-.4,-.9,.4,.9),None);line([(-.85,-.3),(.85,-.3)],3,accent);line([(-.85,.3),(.85,.3)],3,accent)
    elif icon in ('code','laptop'):
        box((-.95,-.8,.95,.55),paper);line([(-1,.75),(1,.75)],5)
        if icon=='code':line([(-.35,-.35),(-.65,-.1),(-.35,.15)],4,accent);line([(.35,-.35),(.65,-.1),(.35,.15)],4,accent);line([(.1,-.45),(-.1,.3)],3)
        else:line([(-.55,-.35),(.55,-.35)],4,accent);line([(-.55,-.05),(.25,-.05)],3)
    elif icon in ('chip','robot'):
        box((-.65,-.65,.65,.65),paper)
        if icon=='chip':
            box((-.3,-.3,.3,.3),accent,2)
            for q in [-.45,0,.45]:line([(q,-.65),(q,-.95)],3);line([(q,.65),(q,.95)],3);line([(-.65,q),(-.95,q)],3);line([(.65,q),(.95,q)],3)
        else:ellipse((-.4,-.25,-.12,.05),accent);ellipse((.12,-.25,.4,.05),accent);line([(-.3,.35),(.3,.35)],3);line([(0,-.65),(0,-.95)],3);ellipse((-.1,-1,.1,-.8),accent,1)
    elif icon=='phone':box((-.55,-1,.55,1),paper,12);box((-.35,-.65,.35,.55),accent,3);ellipse((-.1,.72,.1,.9),ink,1)
    elif icon in ('camera','film','clapper'):
        box((-.95,-.55,.95,.7),paper)
        if icon=='camera':ellipse((-.45,-.4,.45,.5),accent);ellipse((-.2,-.15,.2,.25),paper);box((-.55,-.85,.25,-.55),accent,2)
        else:
            box((-.95,-.85,.95,-.45),accent,2)
            for q in [-.7,-.2,.3,.8]:line([(q,-.8),(q-.2,-.5)],3,paper)
            poly([(-.15,-.2),(.4,.15),(-.15,.5)],accent)
    elif icon=='music':line([(-.4,.5),(-.4,-.65),(.6,-.9),(.6,.2)],5);line([(-.4,-.4),(.6,-.65)],5,accent);ellipse((-.9,.25,-.3,.8),accent);ellipse((.1,0,.7,.55),accent)
    elif icon=='mic':box((-.35,-1,.35,.3),accent,18);p.arc((x-.65*r,y-.45*r,x+.65*r,y+.65*r),0,180,ink,5);line([(0,.65),(0,.95)],4);line([(-.4,.95),(.4,.95)],4)
    elif icon in ('spark','medal','flag'):
        if icon=='medal':poly([(-.6,-.9),(-.05,-.9),(.15,0),(-.4,.2)],accent);poly([(.05,-.9),(.6,-.9),(.4,.2),(-.15,0)],paper);ellipse((-.65,-.15,.65,1),accent);p.star(x,y+.42*r,r*.4,paper)
        elif icon=='flag':line([(-.65,-1),(-.65,1)],5);poly([(-.65,-.9),(.85,-.9),(.4,-.3),(.85,.2),(-.65,.2)],accent)
        else:p.star(x,y,r*.9,accent,points=4,inner=.22,outline=ink);p.star(x+.7*r,y-.7*r,r*.25,paper)
    elif icon=='palette':ellipse((-.95,-.85,.95,.85),paper);ellipse((.2,.05,.8,.65),'#ffffff00');
    elif icon=='scissors':ellipse((-.85,.15,-.1,.9),paper);ellipse((.1,.15,.85,.9),paper);line([(-.45,.3),(.65,-.95)],5,accent);line([(.45,.3),(-.65,-.95)],5,accent)
    elif icon=='vase':poly([(-.4,-.8),(.4,-.8),(.2,-.2),(.65,.45),(.5,.85),(-.5,.85),(-.65,.45),(-.2,-.2)],paper);line([(-.55,.35),(.55,.35)],6,accent)
    elif icon=='game':poly([(-.6,-.5),(.6,-.5),(.95,.65),(.65,.85),(.25,.35),(-.25,.35),(-.65,.85),(-.95,.65)],paper);line([(-.6,-.2),(-.6,.25)],4,accent);line([(-.8,.03),(-.4,.03)],4,accent);ellipse((.3,-.15,.48,.03),accent,1);ellipse((.55,.08,.73,.26),accent,1)
    elif icon=='puzzle':poly([(-.8,-.8),(-.1,-.8),(-.1,-.4),(.25,-.4),(.25,-.8),(.8,-.8),(.8,-.1),(.4,-.1),(.4,.25),(.8,.25),(.8,.8),(-.8,.8)],accent)
    elif icon=='crown':poly([(-.9,-.6),(-.45,-.05),(0,-.95),(.45,-.05),(.9,-.6),(.7,.7),(-.7,.7)],accent);line([(-.65,.4),(.65,.4)],3,paper)
    elif icon=='calendar':box((-.85,-.65,.85,.85),paper);line([(-.85,-.25),(.85,-.25)],5,accent);line([(-.45,-1),(-.45,-.4)],5);line([(.45,-1),(.45,-.4)],5);line([(-.35,.25),(-.05,.55),(.45,.05)],5,accent)
    elif icon=='clock':ellipse((-.9,-.9,.9,.9),paper);line([(0,-.65),(0,0),(.45,.25)],5,accent);ellipse((-.08,-.08,.08,.08),ink,1)
    elif icon=='chart':line([(-.85,-.8),(-.85,.85),(.95,.85)],4);box((-.55,.05,-.2,.6),accent,2);box((0,-.3,.35,.6),paper,2);box((.55,-.75,.9,.6),accent,2)
    elif icon in ('bag','gift'):
        box((-.8,-.45,.8,.85),paper);line([(-.4,-.45),(-.4,-.8),(.4,-.8),(.4,-.45)],4,accent)
        if icon=='gift':line([(0,-.45),(0,.85)],9,accent);line([(-.8,0),(.8,0)],7,accent)
    elif icon=='shirt':poly([(-.4,-.9),(-.1,-.65),(.1,-.65),(.4,-.9),(.95,-.45),(.65,0),(.45,-.15),(.45,.9),(-.45,.9),(-.45,-.15),(-.65,0),(-.95,-.45)],accent)
    elif icon=='mirror':ellipse((-.65,-.95,.65,.45),paper);line([(0,.45),(0,.95)],9,accent);line([(-.15,-.55),(.35,-.1)],3,accent)
    elif icon in ('heart','hands'):
        base.heart(p,x,y,size*.95,accent,ink)
        if icon=='hands':line([(-1,.3),(-.65,.8),(0,1),(.65,.8),(1,.3)],5,paper)
    elif icon=='moon':ellipse((-.85,-.9,.85,.8),accent);ellipse((-.2,-1.1,1,.3),paper,0);p.star(x+.6*r,y+.65*r,r*.25,paper)
    elif icon=='people':ellipse((-.8,-.9,-.1,-.2),accent);ellipse((.1,-.9,.8,-.2),paper);box((-.95,0,-.02,.85),accent,15);box((.02,0,.95,.85),paper,15)
    elif icon=='ring':ellipse((-.75,-.5,.75,1),None,6);poly([(-.45,-.75),(0,-1),(.45,-.75),(.3,-.3),(-.3,-.3)],accent)
    elif icon=='lantern':ellipse((-.75,-.65,.75,.65),accent);box((-.35,-.85,.35,-.65),paper,1);line([(0,.65),(0,1)],5);line([(-.35,1),(.35,1)],4,accent);line([(0,-.55),(0,.5)],4,paper)
    elif icon=='flower':
        for n in range(5):
            a=math.tau*n/5;dx,dy=math.cos(a)*r*.52,math.sin(a)*r*.52;p.ellipse((x+dx-r*.35,y+dy-r*.35,x+dx+r*.35,y+dy+r*.35),accent,ink,2)
        ellipse((-.28,-.28,.28,.28),paper)
    elif icon=='umbrella':poly([(-1,0),(-.85,-.55),(-.45,-.85),(0,-1),(.45,-.85),(.85,-.55),(1,0),(.5,-.1),(0,0),(-.5,-.1)],accent);line([(0,-.9),(0,.75),(.2,.95),(.45,.75)],4)
    elif icon=='rainbow':
        for i,color in enumerate([accent, '#edba4b', '#e9a0b6', '#8d9bd5']):p.arc((x-(.9-i*.15)*r,y-(.8-i*.15)*r,x+(.9-i*.15)*r,y+(.8-i*.15)*r),180,360,color,7)
        ellipse((-.95,-.1,-.5,.3),paper);ellipse((.5,-.1,.95,.3),paper)
    elif icon=='planet':ellipse((-.65,-.65,.65,.65),accent);p.ellipse((x-r,y-.2*r,x+r,y+.2*r),None,ink,4);ellipse((-.3,-.35,-.05,-.1),paper,0)
    elif icon=='rocket':poly([(0,-1),(.45,-.45),(.4,.4),(0,.7),(-.4,.4),(-.45,-.45)],paper);poly([(-.4,0),(-.8,.7),(-.3,.55)],accent);poly([(.4,0),(.8,.7),(.3,.55)],accent);ellipse((-.22,-.45,.22,0),accent);poly([(-.2,.65),(0,1),(.2,.65)],accent)
    elif icon=='battery':box((-.6,-.8,.6,.9),paper);box((-.25,-1,.25,-.8),accent,2);poly([(.1,-.55),(-.3,.15),(.05,.15),(-.05,.65),(.4,-.1),(.05,-.1)],accent)
    elif icon=='recycle':
        for n in range(3):
            a=math.tau*n/3;pts=[]
            for dx,dy in [(-.4,-.7),(.45,-.7),(.45,-.95),(.8,-.5),(.3,-.25),(.35,-.5),(-.3,-.5)]:pts.append((math.cos(a)*dx-math.sin(a)*dy,math.sin(a)*dx+math.cos(a)*dy))
            poly(pts,accent)
    else:raise ValueError(icon)
    if icon=='palette':
        for dx,dy,color in [(-.5,-.35,accent),(-.15,-.55,'#edba4b'),(.35,-.4,'#dd729c'),(-.5,.15,'#5c9acc')]:p.ellipse((x+(dx-.12)*r,y+(dy-.12)*r,x+(dx+.12)*r,y+(dy+.12)*r),color)


ART_PALETTES = [
    ('#ff694a', '#fff2dc', '#271a21'), ('#9e89ff', '#f4eeff', '#25223b'),
    ('#2ad9d0', '#dffcf3', '#0b3039'), ('#edc57a', '#fff7df', '#32251b'),
    ('#ff79ab', '#ffe6ed', '#351c2b'), ('#4898ff', '#eaf3ff', '#142840'),
    ('#aad888', '#eff9e3', '#24352c'), ('#d99465', '#fbecdc', '#3c2b23'),
    ('#c895f2', '#f7e9ff', '#33243f'), ('#f59b67', '#fff0dd', '#39251f'),
]


ART_FONT_PATHS = {
    'sans-serif': {400: pathlib.Path('/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc'), 700: pathlib.Path('/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc')},
    'serif': {400: pathlib.Path('/usr/share/fonts/opentype/noto/NotoSerifCJK-Regular.ttc'), 700: pathlib.Path('/usr/share/fonts/opentype/noto/NotoSerifCJK-Bold.ttc')},
    'monospace': {400: pathlib.Path('/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf'), 700: pathlib.Path('/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf')},
}


@lru_cache(maxsize=256)
def art_font(size, family='sans-serif', weight=600):
    path=ART_FONT_PATHS[family][700 if weight>=600 else 400]
    # CJK monospace text uses the CJK face, as in browser font fallback.
    return ImageFont.truetype(str(path),round(size*2))


def art_text(p, xy, text, size, color, family='sans-serif', weight=600, anchor='lm', tracking=0):
    font=art_font(size,family,weight)
    if family=='monospace' and any(ord(c)>127 for c in text):font=art_font(size,'sans-serif',weight)
    if tracking:
        lengths=[p.draw.textlength(c,font=font)/2 for c in text]
        width=sum(lengths)+tracking*max(0,len(text)-1)
        x=xy[0]-width/2 if anchor=='mm' else xy[0]
        for c,length in zip(text,lengths):p.draw.text((x*2,xy[1]*2),c,font=font,fill=color,anchor='lm');x+=length+tracking
    else:p.draw.text((xy[0]*2,xy[1]*2),text,font=font,fill=color,anchor=anchor)


def tint_layer(alpha, color):
    result=Image.new('RGBA',alpha.size,color);result.putalpha(alpha);return result


def text_settings(index, row):
    accent,paper,ink=ART_PALETTES[index%10]
    phrase=row[6];variant=index%10;half=(len(phrase)+1)//2
    # Native single-style text clips can reproduce every element shown here.
    options=[
        (phrase[:half]+'\n'+phrase[half:],'#f5f0e6','transparent','serif',400,'center',46,540,158),
        (phrase,'#ffffff','#171b24','sans-serif',700,'left',35,500,105),
        (row[5]+'\n'+phrase,'#d9e9ee','transparent','monospace',400,'left',28,560,116),
        (phrase,ink,'#f4eadd','serif',400,'center',38,560,100),
        (phrase[:half]+'\n'+phrase[half:],accent,'transparent','sans-serif',700,'left',45,520,155),
        ('「'+phrase+'」','#ffffff','transparent','serif',400,'center',38,570,116),
        (row[5]+'\n'+phrase,ink,paper,'sans-serif',600,'left',30,530,130),
        (row[1]+'手记\n'+phrase,'#f0e3ce','transparent','monospace',400,'left',28,560,118),
        (phrase,'#efe5ff','transparent','serif',400,'right',38,570,108),
        (phrase[:half]+'\n'+phrase[half:],'#ffffff','transparent','sans-serif',700,'right',46,540,160),
    ]
    text,color,bg,family,weight,align,size,width,height=options[variant]
    if bg=='transparent':bg='#141922'
    max_length=max(len(line) for line in text.split('\n'))
    if family!='monospace':size=min(size, int((width-30)/max_length))
    return dict(text=text,color=color,background=bg,fontFamily=family,fontWeight=weight,textAlign=align,fontSize=size,width=width,height=height)


def soft_shape(image,alpha,color,offset=(0,0),blur=0):
    if blur:alpha=alpha.filter(ImageFilter.GaussianBlur(blur))
    layer=tint_layer(alpha,color)
    image.alpha_composite(layer,(int(offset[0]),int(offset[1])))


def object_art(icon,index,angle=0):
    """A shaped, softly extruded illustration; no enclosing badge or icon tile."""
    accent,paper,ink=ART_PALETTES[index%10]
    p=base.Painter();draw_icon(p,icon,320,160,186,accent,paper,ink)
    obj=p.image;mask=obj.getchannel('A')
    # Offset repeated silhouettes establish real depth, retaining the subject geometry.
    result=Image.new('RGBA',obj.size)
    outline=mask.filter(ImageFilter.MaxFilter(15))
    shadow=outline.filter(ImageFilter.GaussianBlur(12))
    shadow=shadow.point(lambda v:round(v*.32))
    soft_shape(result,shadow,'#080c16',(12,26))
    soft_shape(result,outline,'#fbf8f0',(0,0))
    for depth in range(16,0,-2):soft_shape(result,mask,ink,(depth,depth))
    result.alpha_composite(obj)
    # Specular soft highlight follows the object mask rather than a generic round badge.
    light=Image.new('L',obj.size);ld=ImageDraw.Draw(light);ld.ellipse((430,95,780,430),fill=72);light=light.filter(ImageFilter.GaussianBlur(58))
    light=ImageChops.multiply(light,mask);result.alpha_composite(tint_layer(light,'#ffffff'))
    if angle:result=result.rotate(angle,Image.Resampling.BICUBIC)
    return result


def bezier(points,steps=100):
    out=[]
    for i in range(steps+1):
        t=i/steps;u=1-t
        out.append(tuple(u*u*u*points[0][axis]+3*u*u*t*points[1][axis]+3*u*t*t*points[2][axis]+t*t*t*points[3][axis] for axis in [0,1]))
    return out


def luminous(p,points,color,width=2,alpha=255):
    p.line(points,(*ImageColor.getrgb(color),alpha),width)


def motion_art(index,row,phase):
    p=base.Painter();accent,paper,ink=ART_PALETTES[index%10];style=index%10
    # Different subjects vary geometry, density, trajectories and motion, not only labels.
    seed=index*13;shift=math.sin(phase)*13;shape=(index//10)%10
    if style in (0,5):
        for j in range(11):
            offset=(j-5)*4.2
            points=bezier([(25,278+offset),(192,28+shift+offset),(367,365-offset),(617,68+offset+shift)])
            p.line(points,(*ImageColor.getrgb(accent if j%3 else paper),155 if j%3 else 255),1.5 if j%3 else 3.6)
        for j in range(22):
            t=(j/22+phase/math.tau*.18)%1;points=bezier([(25,278),(192,28+shift),(367,365),(617,68+shift)],100);x,y=points[int(t*100)];p.ellipse((x-1.4,y-1.4,x+1.4,y+1.4),paper)
    elif style==1:
        for j in range(5):
            points=[]
            for k in range(141):
                t=k/140*math.tau;a=t+phase*.18;r=80+j*9
                points.append((320+math.cos(a)*r*1.95,180+math.sin(a)*r*.51+math.cos(a)*39))
            p.line(points,(*ImageColor.getrgb(paper if j==2 else accent),240 if j==2 else 120),1.8)
        for j in range(12):
            a=phase+math.tau*j/12;x=320+math.cos(a)*245;y=180+math.sin(a)*65+math.cos(a)*39;p.ellipse((x-2,y-2,x+2,y+2),paper)
    elif style in (2,7):
        rng=random.Random(seed)
        for j in range(95):
            u=(rng.random()+phase/math.tau*.32)%1;x=50+rng.random()*540;y=330-u*290;radius=.7+rng.random()*2.2;opacity=int((math.sin(u*math.pi)**.6)*220)
            p.ellipse((x-radius,y-radius,x+radius,y+radius),(*ImageColor.getrgb(paper if j%4 else accent),opacity))
            if j%16==0:p.line([(x-6,y),(x+6,y)],(*ImageColor.getrgb(paper),opacity),1);p.line([(x,y-6),(x,y+6)],(*ImageColor.getrgb(paper),opacity),1)
        if style==7:
            for j in range(5):
                x=90+j*110+math.sin(phase+j)*12;y=210+math.cos(phase*.7+j)*65;p.polygon([(x-14,y),(x,y-22),(x+14,y),(x,y+22)],(*ImageColor.getrgb(accent),110))
    elif style==3:
        for j in range(21):
            y=65+j*11;travel=math.sin(phase+j*.2)*35;x0=60+travel+(j%4)*19;length=260+(j*37+shape*13)%250
            p.line([(x0,y),(x0+length,y-55)],(*ImageColor.getrgb(paper if j%5==0 else accent),180 if j%3 else 100),1.3 if j%4 else 3)
        p.line([(50,280),(590,188)],paper,1)
    elif style==4:
        for j in range(7):
            cx=160+j*48;cy=180+math.sin(phase+j*.3)*18
            p.polygon([(cx-42,cy-72),(cx+54,cy-102),(cx+36,cy+80),(cx-66,cy+110)],(*ImageColor.getrgb(accent if j%2 else paper),35+j*14))
            p.line([(cx-42,cy-72),(cx+54,cy-102),(cx+36,cy+80)],(*ImageColor.getrgb(paper),175),1.2)
    elif style==6:
        for j in range(17):
            x=85+j*29;rise=40*math.sin(phase+j*.32);p.line([(x,278),(x,225+rise),(x+45,190+rise),(x+45,83)],(*ImageColor.getrgb(accent),70+(j%4)*37),1)
            t=(phase/math.tau+j/17)%1;y=83+t*195;p.ellipse((x+43,y-2,x+47,y+2),paper)
        p.line([(64,300),(576,300)],(*ImageColor.getrgb(paper),180),1)
    elif style==8:
        for j in range(18):
            points=[]
            for k in range(110):
                x=50+k*5;wave=math.sin(x/96+phase+j*.12)*26+math.cos(x/57+j*.11)*9;points.append((x,100+j*8+wave))
            p.line(points,(*ImageColor.getrgb(paper if j%5==0 else accent),175 if j%3 else 245),1.5 if j%5 else 3.1)
    else:
        inset=math.sin(phase)*5
        for j in range(3):
            left,right=54+j*9+inset,586-j*9-inset;top,bottom=51+j*7,309-j*7
            for x,y,sx,sy in [(left,top,1,1),(right,top,-1,1),(left,bottom,1,-1),(right,bottom,-1,-1)]:p.line([(x,y+sy*55),(x,y),(x+sx*120,y)],(*ImageColor.getrgb(paper if j==0 else accent),230-j*55),1.5)
        for j in range(14):
            x=97+j*35;y=51+math.sin(phase+j)*4;p.ellipse((x-1,y-1,x+1,y+1),accent)
    # The illustration is a subject-specific focal mark within its light field, never a badge.
    positions=[(398,147),(446,114),(445,240),(148,218),(143,245),(456,120),(485,125),(156,124),(103,175),(320,69)]
    cx,cy=positions[style];cx+=math.sin(phase)*5;cy+=math.cos(phase)*3
    if row[2]=='moon':
        # A cut-out lunar crescent, an understated branch and sparse stars identify the theme.
        p=base.Painter();cx,cy=353,141
        moon=Image.new('RGBA',p.image.size);md=ImageDraw.Draw(moon);md.ellipse((int((cx-57)*2),int((cy-57)*2),int((cx+57)*2),int((cy+57)*2)),fill=paper)
        md.ellipse((int((cx-22)*2),int((cy-72)*2),int((cx+80)*2),int((cy+30)*2)),fill=(0,0,0,0));p.image.alpha_composite(moon)
        p.line(bezier([(146,272),(199,235),(221,200),(229,143)]),accent,2.7)
        for n in range(6):
            x,y=176+n*8,246-n*15;p.polygon([(x,y),(x-22,y-9),(x-26,y-23),(x-9,y-19)],accent);p.polygon([(x,y),(x+20,y-7),(x+27,y-20),(x+8,y-16)],(*ImageColor.getrgb(paper),210))
        rng=random.Random(seed)
        for n in range(25):
            x=160+rng.random()*358;y=56+rng.random()*230;radius=.9+1.6*(.5+.5*math.sin(phase*2+n));p.ellipse((x-radius,y-radius,x+radius,y+radius),paper)
        p.arc((210,58,480,282),35+8*math.sin(phase),150+8*math.sin(phase),accent,2)
    else:
        draw_icon(p,row[2],cx,cy,72+shape*2,accent,paper,accent)
        if row[2]=='plane':
            p.line([(49,266),(595,266)],(*ImageColor.getrgb(paper),160),1.2)
            for x in (89,551):p.ellipse((x-3,263,x+3,269),paper)
        elif row[2] in ('music','mic'):
            for n in range(12):
                x=242+n*10;h=5+16*(.5+.5*math.sin(phase*2+n*.7));p.line([(x,265-h),(x,265+h)],paper,2.5)
        elif row[2]=='rocket':
            for n in range(4):
                x=395+n*34;y=85+((n*19)%63);p.line([(x-5,y),(x+5,y)],paper,1.7);p.line([(x,y-5),(x,y+5)],paper,1.7)
    # Very subtle haze sits beneath the sharp strokes, preserving a clean transparent canvas.
    # Downsample the supersampled geometry once; a 4 px glow here equals 8 px at the drawing scale.
    # This avoids rotating and repeatedly resizing a full RGBA canvas on every animation frame.
    sharp=p.image.resize(SIZE,Image.Resampling.LANCZOS)
    glow=sharp.filter(ImageFilter.GaussianBlur(4))
    return Image.alpha_composite(glow,sharp)


def render(category,index,row,phase=0):
    p=base.Painter();accent,paper,ink=ART_PALETTES[index%10];variant=index%5;slug,topic,icon,sticker,callout,label,editable=row
    if category=='text':
        template=text_settings(index,row);w,h=template['width'],template['height'];left,top=(640-w)/2,(360-h)/2
        if template['background']!='transparent':p.rounded((left,top,left+w,top+h),0,template['background'])
        lines=template['text'].split('\n');size=template['fontSize'];x=left+12 if template['textAlign']=='left' else left+w-12 if template['textAlign']=='right' else 320;anchor='lm' if template['textAlign']=='left' else 'rm' if template['textAlign']=='right' else 'mm'
        for n,line in enumerate(lines):art_text(p,(x,180+(n-(len(lines)-1)/2)*size*1.35),line,size,template['color'],template['fontFamily'],template['fontWeight'],anchor)
        return p.finish()
    if category=='motion':return motion_art(index,row,phase)
    if category=='sticker':
        # Topic object is the silhouette; type is free-standing, with no enclosing tile.
        obj=object_art(icon,index,-5 if variant==0 else 4 if variant==2 else 0)
        if variant in (0,3):
            obj=obj.resize((int(obj.width*.82),int(obj.height*.82)),Image.Resampling.LANCZOS);p.image.alpha_composite(obj,(-100,22))
            p.rounded((298,151,550,209),2,'#151a24');art_text(p,(310,179),sticker,33,'#f8f7f4',weight=700)
            p.line([(314,214),(467,214)],accent,3)
        else:
            p.image.alpha_composite(obj,(0,-16))
            text_width=p.draw.textlength(sticker,font=art_font(33))/2
            p.rounded((320-text_width/2-18,255,320+text_width/2+18,307),3,'#151a24')
            art_text(p,(320,279),sticker,33,'#f6f4ec',weight=700,anchor='mm')
        return p.finish()
    if category=='callout':
        # A small visual anchor and a real leader line point to the subject in the video.
        left=188 if variant%2==0 else 84;top=95 if variant<3 else 133
        anchor=(83,253) if variant%2==0 else (555,78)
        p.ellipse((anchor[0]-6,anchor[1]-6,anchor[0]+6,anchor[1]+6),accent)
        p.ellipse((anchor[0]-12,anchor[1]-12,anchor[0]+12,anchor[1]+12),None,(*ImageColor.getrgb(accent),120),1)
        points=[anchor,(left-34,top+92),(left,top+92)] if variant%2==0 else [anchor,(left+465,top-18),(left+420,top-18),(left+420,top)]
        p.line(points,accent,1.4)
        p.rounded((left,top,left+380,top+139),2,'#111722')
        p.rounded((left,top,left+3,top+139),0,accent)
        art_text(p,(left+22,top+23),topic+' / 提示',12,accent,weight=400,tracking=1)
        art_text(p,(left+22,top+66),callout,25,'#f7f6f2',weight=600)
        art_text(p,(left+22,top+108),topic+' · 注意事项',12,'#9faabd',weight=400)
        return p.finish()
    if category=='label':
        # Editorial lower thirds: asymmetrical type, quiet metadata and deliberate rules.
        if variant==0:
            p.rounded((52,113,586,255),0,'#101722');p.rounded((52,113,58,255),0,accent)
            art_text(p,(81,140),topic+' · 精选片段',12,accent,weight=400,tracking=2)
            art_text(p,(80,193),label,40,'#fff9ee',weight=600);p.line([(82,232),(557,232)],'#526076',1)
        elif variant==1:
            p.rounded((54,105,183,255),0,accent);art_text(p,(118,176),topic[0],55,ink,'serif',400,'mm')
            p.rounded((183,105,584,255),0,'#f3eee5');art_text(p,(207,157),label,38,ink,'serif',600)
            art_text(p,(209,216),topic+' · 创作记录',12,ink,weight=400,tracking=2)
        elif variant==2:
            p.rounded((54,92,586,239),0,'#101722')
            art_text(p,(68,133),label,48,'#fcf9f1','serif',400);p.line([(70,177),(570,177)],accent,1.3)
            art_text(p,(72,210),topic+' / 影像记录',13,accent,weight=400,tracking=2)
        elif variant==3:
            p.rounded((58,126,577,232),0,'#111722');p.polygon([(555,126),(577,126),(577,148)],accent)
            art_text(p,(82,171),label,35,'#f5f7fa',weight=700);art_text(p,(84,207),topic+' · 精选片段',12,accent,weight=400,tracking=2)
        else:
            p.rounded((54,91,586,269),0,'#101722')
            p.line([(68,105),(68,257)],accent,4);art_text(p,(93,137),topic+' / 随拍',12,accent,weight=400,tracking=2)
            art_text(p,(91,192),label,44,'#fff8eb','serif',600);art_text(p,(95,241),topic+'  /  影像手记',12,'#bac1c9',weight=400)
        return p.finish()
    raise ValueError(category)


def domain(index):
    if index in (6,63,66,67):return '日常生活'
    for until, name in [(5,'日常'),(15,'美食'),(22,'旅行'),(32,'运动'),(41,'学习'),(48,'科技'),(58,'创作娱乐'),(64,'办公'),(66,'生活'),(74,'情感家庭'),(87,'节日天气'),(96,'自然探索'),(100,'成长')]:
        if index<until:return name
    return '日常'


def descriptors():
    entries=[]
    for prefix,category,skip in CATEGORIES:
        for index,row in enumerate(subjects()):
            if index<skip:continue
            identifier=f'{prefix}-{row[0]}'
            entry=dict(id=identifier,name=row[1]+{'sticker':'贴纸','motion':'动效','callout':'提示','label':'标签','text':'文字'}[prefix],category=category,tags=[row[1],domain(index),row[3 if prefix=='sticker' else 4 if prefix=='callout' else 5 if prefix=='label' else 6], '原创','离线'],url=f'/watermarks/{identifier}.mp4' if prefix=='motion' else f'/watermarks/{identifier}.png',poster=f'/watermarks/{identifier}.png',kind='video' if prefix=='motion' else 'text' if prefix=='text' else 'image',duration=DURATION if prefix=='motion' else 5,width=640,height=360,placement='center' if prefix=='motion' else 'bottom-center' if prefix in ('text','label') else 'top-right' if prefix=='callout' else 'bottom-right')
            if prefix=='motion':entry.update(fallbackUrl=f'/watermarks/{identifier}.webm',chromaKey=True,spillSuppression=True)
            if prefix=='text':entry['textTemplate']=text_settings(index,row)
            entries.append((entry,prefix,index,row))
    assert len(entries)==482
    return entries


def write_catalog(entries):
    target=ROOT/'src/core/watermark-catalog-data.ts'
    # One material per line keeps the generated source readable without 12,000 lines.
    target.write_text("// Generated by scripts/generate-watermark-catalog.py; original offline subjects.\nimport type { WatermarkMaterial } from './watermark-library.ts'\n\nexport const EXPANDED_WATERMARK_MATERIALS: WatermarkMaterial[] = [\n"+'\n'.join('  '+json.dumps(entry,ensure_ascii=False,separators=(',', ': '))+',' for entry,*_ in entries)+'\n]\n')


def checksum(path):return dict(file=path.name,bytes=path.stat().st_size,sha256=hashlib.sha256(path.read_bytes()).hexdigest())


def verify_video(path,codec):
    data=json.loads(subprocess.run(['ffprobe','-v','error','-show_streams','-show_format','-of','json',str(path)],capture_output=True,text=True,check=True).stdout)
    stream=data['streams'][0];assert len(data['streams'])==1 and stream['codec_name']==codec and (stream['width'],stream['height'])==SIZE
    assert abs(float(data['format']['duration'])-DURATION)<.1
    assert stream['pix_fmt']=='yuv420p' and stream['r_frame_rate']==f'{FPS}/1'
    subprocess.run(['ffmpeg','-v','error','-threads','1','-i',str(path),'-f','null','-'],check=True)
    samples=[]
    for time in [.25,1.5]:samples.append(subprocess.run(['ffmpeg','-v','error','-threads','1','-ss',str(time),'-i',str(path),'-frames:v','1','-f','rawvideo','-pix_fmt','rgb24','-'],capture_output=True,check=True).stdout)
    assert len(samples[0])==640*360*3 and samples[0]!=samples[1],path
    return dict(**checksum(path),codec=codec,duration=DURATION,width=640,height=360,framesPerSecond=FPS,audio=False,chromaColor='#00ff00')


def generate(item, output, verify_only=False):
    entry,prefix,index,row=item;identifier=entry['id'];poster=output/f'{identifier}.png'
    if not verify_only:
        rendered=render(prefix,index,row,math.tau*.25)
        # Alpha-aware palette reduces the bundle while preserving transparent edges.
        quantized=rendered.quantize(colors=256,method=Image.Quantize.FASTOCTREE)
        # Preserve completely transparent pixels if palette averaging would turn a soft glow into a veil.
        (quantized if quantized.convert('RGBA').getextrema()[3][0]==0 else rendered).save(poster,optimize=True)
    image=Image.open(poster);image.load();assert image.size==SIZE and image.convert('RGBA').getextrema()[3][0]==0
    record=dict(id=identifier,category=entry['category'],kind=entry['kind'],poster=checksum(poster))
    if prefix=='motion':
        record['spillSuppression']=entry.get('spillSuppression',False)
        path=output/f'{identifier}.mp4';fallback=output/f'{identifier}.webm'
        if not verify_only:
            encoder=subprocess.Popen(['ffmpeg','-v','error','-y','-f','rawvideo','-pix_fmt','rgb24','-s','640x360','-r',str(FPS),'-i','-','-an','-c:v','libx264','-threads','1','-preset','fast','-crf','21','-pix_fmt','yuv420p','-movflags','+faststart','-map_metadata','-1',str(path)],stdin=subprocess.PIPE)
            try:
                for frame in range(FPS*DURATION):
                    overlay=render(prefix,index,row,math.tau*frame/(FPS*DURATION));background=Image.new('RGB',SIZE,'#00ff00');background.paste(overlay,(0,0),overlay);encoder.stdin.write(background.tobytes())
            finally:encoder.stdin.close()
            assert encoder.wait()==0
            subprocess.run(['ffmpeg','-v','error','-y','-i',str(path),'-map','0:v:0','-an','-c:v','libvpx-vp9','-b:v','0','-crf','32','-deadline','realtime','-cpu-used','5','-row-mt','1','-threads','1','-pix_fmt','yuv420p','-map_metadata','-1',str(fallback)],check=True)
        record['media']=verify_video(path,'h264');record['fallback']=verify_video(fallback,'vp9')
    else:record['media']=checksum(poster)
    if prefix=='text':record['editableText']=entry['textTemplate']
    print(f'{identifier}: verified',flush=True)
    return record


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--catalog-only',action='store_true')
    parser.add_argument('--verify-only',action='store_true')
    parser.add_argument('--workers',type=int,default=3)
    parser.add_argument('--only')
    parser.add_argument('--font','--sans-bold',dest='sans_bold',type=pathlib.Path,default=ART_FONT_PATHS['sans-serif'][700])
    parser.add_argument('--sans-regular',type=pathlib.Path,default=ART_FONT_PATHS['sans-serif'][400])
    parser.add_argument('--serif-bold',type=pathlib.Path,default=ART_FONT_PATHS['serif'][700])
    parser.add_argument('--serif-regular',type=pathlib.Path,default=ART_FONT_PATHS['serif'][400])
    parser.add_argument('--mono-font',type=pathlib.Path,default=ART_FONT_PATHS['monospace'][400])
    args=parser.parse_args()
    ART_FONT_PATHS['sans-serif'].update({400:args.sans_regular,700:args.sans_bold})
    ART_FONT_PATHS['serif'].update({400:args.serif_regular,700:args.serif_bold})
    ART_FONT_PATHS['monospace'].update({400:args.mono_font,700:args.mono_font})
    art_font.cache_clear()
    entries=descriptors();write_catalog(entries)
    if args.catalog_only:return
    base.FONT_PATH=args.sans_bold
    if not args.verify_only:
        for family,weights in ART_FONT_PATHS.items():
            for path in weights.values():
                if not path.is_file():parser.error(f'Provide the installed {family} font path using the font options: {path}')
    output=ROOT/'public/watermarks';output.mkdir(exist_ok=True)
    selected=[item for item in entries if item[0]['id']==args.only] if args.only else entries
    assert selected,'Unknown material ID'
    with concurrent.futures.ThreadPoolExecutor(max_workers=args.workers) as executor:records=list(executor.map(lambda item:generate(item,output,args.verify_only),selected))
    assert len({record['poster']['sha256'] for record in records})==len(records),'Duplicate preview artwork'
    if not args.only:
        total=sum(p.stat().st_size for p in output.iterdir() if p.suffix in ('.mp4','.webm','.png'))
        manifest=dict(schemaVersion=1,license='MIT',source='scripts/generate-watermark-catalog.py',description='Original themed artwork; editable text stays in native text clips. Original 18 animations are documented in manifest.json.',counts={category:100 for _,category,_ in CATEGORIES},materials=records,totalMediaBytesIncludingOriginals=total)
        (output/'catalog-manifest.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2)+'\n')
        if total>45*1024*1024:raise RuntimeError(f'Media budget exceeded: {total:,} bytes')
        print(f'{len(records)} new materials verified; all media total {total:,} bytes',flush=True)


if __name__=='__main__':main()
