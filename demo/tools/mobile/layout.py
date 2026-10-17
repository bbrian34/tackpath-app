import sys; sys.path.insert(0, '.')
from geo import src
W, H = 1080, 1920
TOP, BOT, LBL, GAP, MAXW = 260, 1530, 54, 86, 1000
def place(panels):
    """panels -> [(source rect, output rect, label)] stacked and centred in the content area"""
    rects = [src(l, d, x, y, w, h) for (l, d, x, y, w, h, _) in panels]
    n = len(rects)
    avail = (BOT - TOP) - n * LBL - (n - 1) * GAP
    hs = [r[3] * MAXW / r[2] for r in rects]
    k = min(1.0, avail / sum(hs))
    ws = [MAXW * k for _ in rects]; hs = [h * k for h in hs]
    total = sum(hs) + n * LBL + (n - 1) * GAP
    y = TOP + ((BOT - TOP) - total) / 2
    out = []
    for r, w, h, p in zip(rects, ws, hs, panels):
        y += LBL
        out.append((r, [round((W - w) / 2), round(y), round(w), round(h)], p[6]))
        y += h + GAP
    return out
