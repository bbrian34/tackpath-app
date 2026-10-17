import json, subprocess, os
spec = json.load(open('spec.json')); os.makedirs('seg', exist_ok=True)
SRC = '../v2/TackPath-Demo-4k-v5.mp4'; FADE = 0.35; segs = []
for s in spec:
    out = 'seg/%02d.mp4' % s['i']; ov = 'ov/%02d.png' % s['i']; d = s['dur']
    enc = ['-c:v', 'libx264', '-preset', 'fast', '-crf', '18', '-pix_fmt', 'yuv420p', '-r', '30', out]
    if s['kind'] != 'shot':
        subprocess.run(['ffmpeg', '-v', 'error', '-y', '-loop', '1', '-t', '%.2f' % d, '-i', ov, '-vf', 'fps=30,format=yuv420p'] + enc, check=True)
    else:
        n = len(s['panels']); f = ['color=c=0x050b16:s=1080x1920:r=30:d=%.2f[bg]' % d, '[0:v]split=%d%s' % (n, ''.join('[s%d]' % k for k in range(n)))]
        last = '[bg]'
        for k, p in enumerate(s['panels']):
            x, y, w, h = p['src']; X, Y, W, H = p['out']
            f.append('[s%d]crop=%d:%d:%d:%d,scale=%d:%d:flags=lanczos[p%d]' % (k, w, h, x, y, W, H, k))
            f.append('%s[p%d]overlay=%d:%d[b%d]' % (last, k, X, Y, k)); last = '[b%d]' % k
        f.append('%s[1:v]overlay=0:0,format=yuv420p[out]' % last)
        subprocess.run(['ffmpeg', '-v', 'error', '-y', '-ss', '%.3f' % s['t'], '-t', '%.2f' % d, '-i', SRC, '-i', ov,
                        '-filter_complex', ';'.join(f), '-map', '[out]', '-t', '%.2f' % d] + enc, check=True)
    segs.append((out, d)); print('seg', s['i'], d, flush=True)
inputs = sum([['-i', o] for o, _ in segs], []); chain = []; last = '[0:v]'; acc = segs[0][1]
for k in range(1, len(segs)):
    chain.append('%s[%d:v]xfade=transition=fade:duration=%.2f:offset=%.3f[x%d]' % (last, k, FADE, acc - FADE, k)); acc += segs[k][1] - FADE; last = '[x%d]' % k
chain.append('%sfade=t=in:st=0:d=0.5,fade=t=out:st=%.3f:d=0.8[out]' % (last, acc - 0.8))
subprocess.run(['ffmpeg', '-v', 'error', '-y'] + inputs + ['-filter_complex', ';'.join(chain), '-map', '[out]', '-c:v', 'libx264', '-preset', 'medium',
                '-crf', '19', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', 'TackPath-Demo-mobile-1080x1920.mp4'], check=True)
print('total %.1f' % acc)
