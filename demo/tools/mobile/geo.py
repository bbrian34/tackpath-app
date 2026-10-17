# Stage geometry -> 4K source pixels (source = stage x 2).
L = {
 'build':  {'desk': (240, 92, 0.99)}, 'board': {'desk': (240, 92, 0.99)},
 'signin': {'phone': (747, 92, 0.98)},
 'assign': {'desk': (40, 112, 0.93), 'phone': (1446, 104, 0.92)},
 'sort':   {'tc56': (120, 96, 1.06), 'phone': (1452, 124, 0.86)},
 'sortzoom': {'tc56': (712, 66, 1.15)},
 'ready':  {'tc56': (300, 104, 1.04), 'phone': (1120, 96, 0.96)},
 'pickup': {'phone': (1060, 96, 0.96)},
 'drive':  {'phone': (96, 96, 0.96), 'desk': (600, 150, 0.875)},
}
ORIGIN = {'phone': (16, 16), 'tc56': (35, 70), 'desk': (0, 36)}   # screen offset inside the device
def src(layout, dev, x, y, w, h):
    """a rectangle in the device screen's own CSS pixels -> 4K source rect (x, y, w, h)"""
    X, Y, s = L[layout][dev]; ox, oy = ORIGIN[dev]
    return [round(2 * (X + (ox + x) * s)), round(2 * (Y + (oy + y) * s)), round(2 * w * s), round(2 * h * s)]
