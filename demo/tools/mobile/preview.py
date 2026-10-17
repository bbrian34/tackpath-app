import json, subprocess
from PIL import Image
spec = json.load(open('spec.json')); outs = []
for s in spec:
    ov = Image.open('ov/%02d.png' % s['i']).convert('RGBA')
    if s['kind'] != 'shot': outs.append(ov.convert('RGB')); continue
    t = s['t'] + s['dur'] * 0.6
    subprocess.run(['ffmpeg', '-v', 'error', '-y', '-ss', '%.2f' % t, '-i', '../v2/TackPath-Demo-4k-v5.mp4', '-frames:v', '1', 'pv.png'], check=True)
    src = Image.open('pv.png'); f = Image.new('RGBA', (1080, 1920), (5, 11, 22, 255))
    for p in s['panels']:
        x, y, w, h = p['src']; X, Y, W, H = p['out']
        f.paste(src.crop((x, y, x + w, y + h)).resize((W, H), Image.LANCZOS), (X, Y))
    f.alpha_composite(ov); outs.append(f.convert('RGB'))
for i in range(0, len(outs), 7):
    g = outs[i:i + 7]; S = Image.new('RGB', (540 * len(g), 960))
    for k, im in enumerate(g): S.paste(im.resize((540, 960), Image.LANCZOS), (540 * k, 0))
    S.save('pv-%d.png' % (i // 7))
outs[2].save('pv-full-assign.png'); outs[7].save('pv-full-ready.png')
print(len(outs))
