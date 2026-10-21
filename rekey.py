"""Swap this machine's own keys into the bundle's account snapshots.

The snapshots in accounts/ name placeholder admin and operator keys whose
private keys were discarded when the bundle was built. This writes copies with
your keys (keys/admin.json, keys/operator.json) in their place to
.local/accounts/, which start.sh loads.
"""

import base64
import json
import pathlib

ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
ROOT = pathlib.Path(__file__).resolve().parent


def b58_pubkey(text):
    n = 0
    for char in text:
        n = n * 58 + ALPHABET.index(char)
    return n.to_bytes(32, "big")


def keypair_pubkey(path):
    return bytes(json.loads(path.read_text())[32:64])


placeholders = json.loads((ROOT / "placeholders.json").read_text())
swaps = [
    (b58_pubkey(placeholders[role]), keypair_pubkey(ROOT / "keys" / f"{role}.json"))
    for role in ("admin", "operator")
]

out = ROOT / ".local" / "accounts"
out.mkdir(parents=True, exist_ok=True)
for stale in out.glob("*.json"):
    stale.unlink()
for src in sorted((ROOT / "accounts").glob("*.json")):
    doc = json.loads(src.read_text())
    data = base64.b64decode(doc["account"]["data"][0])
    for placeholder, mine in swaps:
        data = data.replace(placeholder, mine)
    doc["account"]["data"][0] = base64.b64encode(data).decode()
    (out / src.name).write_text(json.dumps(doc, indent=2))
