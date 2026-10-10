#!/usr/bin/env python3
"""Make a printable PathIQ sign-in badge.

The badge holds  TP|<company-slug>|<company-code>  as a Code 128 barcode
(default) or a QR code. PathIQ on the TC56 signs the worker in when it is
scanned. Under the barcode the badge shows the company slug and the words
"PathIQ badge". The company code is never printed as text, written to the
terminal or saved anywhere except inside the barcode.

Usage:
    python tools/make_badge.py <slug> <code> [-o badge.png] [--kind code128|qr|both]
    python tools/make_badge.py <slug> - [...]     # read the code from stdin

Passing the code as "-" (or leaving it out) reads it from stdin or a hidden
prompt, so it is not kept in your shell history.

Needs Pillow (pip install pillow). --kind qr / both also needs qrcode
(pip install qrcode). Output is 300 dpi; Code 128 modules are 3 px (10 mil).

Treat a badge like a key: anyone holding it can sign a device in to the
company. To retire badges, change the company code (the old badges stop
working).
"""
import argparse
import getpass
import re
import sys

from PIL import Image, ImageDraw, ImageFont

DPI = 300
SLUG_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,62}$")

# Code 128 bar/space widths for symbol values 0..106 (106 = STOP, 7 elements).
_C128 = (
    "212222 222122 222221 121223 121322 131222 122213 122312 132212 221213 "
    "221312 231212 112232 122132 122231 113222 123122 123221 223211 221132 "
    "221231 213212 223112 312131 311222 321122 321221 312212 322112 322211 "
    "212123 212321 232121 111323 131123 131321 112313 132113 132311 211313 "
    "231113 231311 112133 112331 132131 113123 113321 133121 313121 211331 "
    "231131 213113 213311 213131 311123 311321 331121 312113 312311 332111 "
    "314111 221411 431111 111224 111422 121124 121421 141122 141221 112214 "
    "112412 122114 122411 142112 142211 241211 221114 413111 241112 134111 "
    "111242 121142 121241 114212 124112 124211 411212 421112 421211 212141 "
    "214121 412121 111143 111341 131141 114113 114311 411113 411311 113141 "
    "114131 311141 411131 211412 211214 211232 2331112"
).split()
_START_B = 104
_STOP = 106


def code128_modules(text):
    """Code 128 set B: returns the bar pattern as a list of 1/0 modules."""
    values = [_START_B] + [ord(ch) - 32 for ch in text]
    check = (_START_B + sum(i * v for i, v in enumerate(values[1:], start=1))) % 103
    values += [check, _STOP]
    modules = []
    for v in values:
        bar = True
        for w in _C128[v]:
            modules += [1 if bar else 0] * int(w)
            bar = not bar
    return modules


def code128_image(text, module_px=3, height_px=210, quiet_modules=12):
    mods = code128_modules(text)
    width = (len(mods) + 2 * quiet_modules) * module_px
    img = Image.new("1", (width, height_px), 1)
    d = ImageDraw.Draw(img)
    for i, m in enumerate(mods):
        if m:
            x = (quiet_modules + i) * module_px
            d.rectangle([x, 0, x + module_px - 1, height_px - 1], fill=0)
    return img.convert("L")


def qr_image(text, box_px=8):
    try:
        import qrcode
    except ImportError:
        sys.exit("QR badges need the qrcode package: pip install qrcode")
    qr = qrcode.QRCode(error_correction=qrcode.constants.ERROR_CORRECT_M, box_size=box_px, border=4)
    qr.add_data(text)
    qr.make(fit=True)
    return qr.make_image(fill_color="black", back_color="white").get_image().convert("L")


def font(size, bold=True):
    for name in (("DejaVuSans-Bold.ttf" if bold else "DejaVuSans.ttf"), ("arialbd.ttf" if bold else "arial.ttf")):
        try:
            return ImageFont.truetype(name, size)
        except OSError:
            pass
    return ImageFont.load_default(size=size)


def make_badge(slug, code, kind="code128"):
    value = "TP|%s|%s" % (slug, code)
    codes = []
    if kind in ("code128", "both"):
        codes.append(code128_image(value))
    if kind in ("qr", "both"):
        codes.append(qr_image(value))
    pad, gap = 60, 40
    title_f, slug_f, small_f = font(64), font(54), font(30, bold=False)
    width = max(max(c.width for c in codes) + 2 * pad, 1012)     # at least 3.375 in (badge width)
    height = pad + 80 + gap + sum(c.height + gap for c in codes) + 70 + 50 + pad
    img = Image.new("L", (width, height), 255)
    d = ImageDraw.Draw(img)
    d.rectangle([4, 4, width - 5, height - 5], outline=0, width=4)
    y = pad
    d.text((width // 2, y), "PathIQ badge", font=title_f, fill=0, anchor="mt")
    y += 80 + gap
    for c in codes:
        img.paste(c, ((width - c.width) // 2, y))
        y += c.height + gap
    d.text((width // 2, y), slug, font=slug_f, fill=0, anchor="mt")
    y += 70
    d.text((width // 2, y), "Scan to sign in to PathIQ", font=small_f, fill=80, anchor="mt")
    return img


def main(argv=None):
    ap = argparse.ArgumentParser(description="Make a printable PathIQ sign-in badge (PNG).")
    ap.add_argument("slug", help="company slug, e.g. bb")
    ap.add_argument("code", nargs="?", default="-", help='company code, or "-" to read it from stdin / a hidden prompt')
    ap.add_argument("-o", "--out", help="output PNG (default: badge-<slug>.png)")
    ap.add_argument("--kind", choices=("code128", "qr", "both"), default="code128", help="barcode type (default code128)")
    a = ap.parse_args(argv)

    slug = a.slug.strip().lower()
    if not SLUG_RE.match(slug):
        sys.exit("Company slug must be lowercase letters, digits, - or _ (max 63).")
    code = a.code
    if code == "-":
        code = getpass.getpass("Company code: ") if sys.stdin.isatty() else sys.stdin.readline()
    code = code.strip()
    if not 8 <= len(code) <= 200:
        sys.exit("Company code must be 8 to 200 characters.")
    if "|" in code or any(not (32 <= ord(ch) <= 126) for ch in code):
        sys.exit("Company code must be printable ASCII without '|'.")
    if a.kind != "qr" and len(code) > 60:
        sys.exit("Code too long for a Code 128 badge; use --kind qr.")

    out = a.out or "badge-%s.png" % slug
    make_badge(slug, code, a.kind).save(out, dpi=(DPI, DPI))
    print("Wrote %s (company %s, %s). The code is in the barcode only." % (out, slug, a.kind))


if __name__ == "__main__":
    main()
