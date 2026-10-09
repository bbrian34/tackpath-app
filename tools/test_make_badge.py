"""Checks for make_badge.py with made-up values (no real company code).

    python -m unittest tools/test_make_badge.py

Decoding the PNG needs zxing-cpp (pip install zxing-cpp); without it those
checks are skipped and only the Code 128 encoding is checked.
"""
import os
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import make_badge  # noqa: E402

FAKE = "Fake-Code-0000"
SCRIPT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "make_badge.py")

try:
    import zxingcpp
except ImportError:
    zxingcpp = None


class MakeBadgeTest(unittest.TestCase):
    def test_code128_shape(self):
        mods = make_badge.code128_modules("TP|demo|" + FAKE)
        n = len("TP|demo|" + FAKE)
        self.assertEqual(len(mods), 11 * (n + 3) + 2)          # start + data + check + stop
        self.assertEqual(mods[:11], [1, 1, 0, 1, 0, 0, 1, 0, 0, 0, 0])   # START B

    @unittest.skipIf(zxingcpp is None, "zxing-cpp not installed")
    def test_png_decodes_to_the_badge_value(self):
        for kind, fmt in (("code128", "Code128"), ("qr", "QRCode")):
            with tempfile.TemporaryDirectory() as d:
                out = os.path.join(d, "b.png")
                r = subprocess.run([sys.executable, SCRIPT, "demo", "-", "-o", out, "--kind", kind],
                                   input=FAKE + "\n", capture_output=True, text=True, check=True)
                self.assertNotIn(FAKE, r.stdout + r.stderr, "the code is never printed")
                from PIL import Image
                found = zxingcpp.read_barcodes(Image.open(out))
                self.assertEqual([x.text for x in found], ["TP|demo|" + FAKE])
                self.assertEqual(found[0].format.name, fmt)

    def test_rejects_bad_input(self):
        for args in (["Bad Slug", FAKE], ["demo", "short"], ["demo", "has|pipe-code"]):
            r = subprocess.run([sys.executable, SCRIPT] + args + ["-o", os.devnull], capture_output=True, text=True)
            self.assertNotEqual(r.returncode, 0, args)


if __name__ == "__main__":
    unittest.main()
