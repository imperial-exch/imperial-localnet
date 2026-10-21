"""Swap this machine's own keys into the bundle's account snapshots.

The snapshots in accounts/ name placeholder admin, operator and oracle keys
whose private keys were discarded when the bundle was built. This writes
copies with your keys (keys/admin.json, keys/operator.json, keys/oracle.json)
in their place to .local/accounts/, which start.sh loads.
"""

import base64
import json
import pathlib
import shutil

ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
ROOT = pathlib.Path(__file__).resolve().parent
ROLES = ("admin", "operator", "oracle")


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
    for role in ROLES
]

src_root = ROOT / "accounts"
out_root = ROOT / ".local" / "accounts"
shutil.rmtree(out_root, ignore_errors=True)
for src in sorted(src_root.rglob("*.json")):
    doc = json.loads(src.read_text())
    data = base64.b64decode(doc["account"]["data"][0])
    for placeholder, mine in swaps:
        data = data.replace(placeholder, mine)
    doc["account"]["data"][0] = base64.b64encode(data).decode()
    out = out_root / src.relative_to(src_root)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(doc, indent=2))
