"""Receiving TackPath webhooks in Python 3 (standard library only).

Verify the signature on the RAW request body, reject old timestamps (replay),
and ignore event ids you have already processed.
"""
import hashlib
import hmac
import time


def verify_tackpath_signature(secret: str, raw_body: bytes, header: str, tolerance_seconds: int = 300, now: float = None) -> bool:
    try:
        parts = dict(p.strip().split("=", 1) for p in (header or "").split(","))
        t = int(parts["t"])
        v1 = parts["v1"]
    except (ValueError, KeyError):
        return False
    if abs((now if now is not None else time.time()) - t) > tolerance_seconds:
        return False  # too old: possible replay
    expected = hmac.new(secret.encode(), f"{t}.".encode() + raw_body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, v1)


# Flask example:
#   @app.post("/tackpath/webhooks")
#   def hook():
#       if not verify_tackpath_signature(SECRET, request.get_data(), request.headers.get("TackPath-Signature")):
#           return "bad signature", 400
#       event = request.get_json()
#       if already_processed(event["id"]): return "", 200
#       queue_for_processing(event)
#       return "", 200
