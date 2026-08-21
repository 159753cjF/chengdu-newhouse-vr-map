#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
从 CSV 或 data/vr-map-data.js.bak 生成加密分片 + Worker 数据
用法:
  python scripts/build-vr-data.py
  python scripts/build-vr-data.py --csv E:/afei-tools/vr-link-table/data/chengdu-100yi-scenes.csv
"""
import pathlib, json, base64, re, argparse, sys

ROOT = pathlib.Path(__file__).resolve().parents[1]
DATA_JS = ROOT / "data" / "vr-map-data.js.bak"
DATA_JSON = ROOT / "data" / "vr-data.json"
WORKER_JSON = ROOT / "worker" / "data" / "vr-data.json"
CHUNK_DIR = ROOT / "data" / "chunks"
META = ROOT / "data" / "vr-map-data.enc.meta.json"
KEY = "afei-vr-map-2026"

def load_from_js():
    src = DATA_JS.read_text(encoding="utf-8")
    m = re.search(r"window\.VR_MAP_DATA\s*=\s*(\[.*\])", src, re.S)
    if not m:
        raise RuntimeError("无法从 vr-map-data.js.bak 解析")
    return json.loads(m.group(1))

def load_from_csv(csv_path):
    import csv
    arr = []
    with open(csv_path, encoding="utf-8-sig") as f:
        reader = csv.DictReader(f)
        for row in reader:
            # 兼容不同列名
            arr.append({
                "name": row.get("name") or row.get("楼盘") or "",
                "district": row.get("district") or row.get("区县") or "其它",
                "plate": row.get("plate") or row.get("板块") or "其它",
                "url": row.get("url") or row.get("链接") or "",
                "scene": row.get("scene") or row.get("场景") or "",
                "lat": float(row.get("lat") or row.get("纬度") or 0),
                "lng": float(row.get("lng") or row.get("经度") or 0),
            })
    return arr

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--csv", type=str, default="")
    args = ap.parse_args()

    if args.csv and pathlib.Path(args.csv).exists():
        arr = load_from_csv(args.csv)
        print(f"from CSV: {len(arr)}")
    elif DATA_JS.exists():
        arr = load_from_js()
        print(f"from js.bak: {len(arr)}")
    elif DATA_JSON.exists():
        arr = json.loads(DATA_JSON.read_text(encoding="utf-8"))
        print(f"from vr-data.json: {len(arr)}")
    else:
        print("未找到数据源", file=sys.stderr)
        sys.exit(1)

    # 1. 写明文 JSON（仅本地，gitignore）
    DATA_JSON.write_text(json.dumps(arr, ensure_ascii=False, separators=(",",":")), encoding="utf-8")
    WORKER_JSON.parent.mkdir(parents=True, exist_ok=True)
    WORKER_JSON.write_text(json.dumps(arr, ensure_ascii=False, separators=(",",":")), encoding="utf-8")
    print(f"written {DATA_JSON} {DATA_JSON.stat().st_size//1024}KB")
    print(f"written {WORKER_JSON}")

    # 2. 加密分片
    compact = [{"n": x["name"], "d": x["district"], "p": x["plate"], "u": x["url"], "s": x["scene"], "la": round(x["lat"],6), "lo": round(x["lng"],6)} for x in arr]
    jstr = json.dumps(compact, ensure_ascii=False, separators=(",",":"))
    kb = KEY.encode()
    data = jstr.encode("utf-8")
    xored = bytes(b ^ kb[i % len(kb)] for i, b in enumerate(data))
    b64 = base64.b64encode(xored).decode()
    mid = len(b64)//2
    CHUNK_DIR.mkdir(parents=True, exist_ok=True)
    (CHUNK_DIR / "0.bin").write_text(b64[:mid], encoding="utf-8")
    (CHUNK_DIR / "1.bin").write_text(b64[mid:], encoding="utf-8")
    import hashlib
    META.write_text(json.dumps({"k": hashlib.sha256(KEY.encode()).hexdigest()[:8], "chunks":2, "count": len(compact)}, ensure_ascii=False), encoding="utf-8")
    print(f"written chunks {len(b64[:mid])} + {len(b64[mid:])} -> {CHUNK_DIR}")

if __name__ == "__main__":
    main()
