# VR 地图 API Worker

静态文件 -> 接口，防直接爬全量。

## 原理
- 数据不再是 `data/vr-map-data.js` 明文，而是 `data/chunks/*.bin` 加密分片（需 JS 解密）+ `Worker` 接口按视口/搜索过滤
- `curl data/vr-map-data.js` 只能拿到 `[]`，`curl data/chunks/0.bin` 拿到的是 `base64(xor(json))`，需执行 `app.js` 的解密才能还原
- `Worker` 额外加 `Referer` / `Token(sha256(t+secret))` + `60 req/min` 限流，裸 `curl` 无 JS 拿不到 5 分钟内的 token

## 部署
```bash
cd worker
npm i
# 1. 生成/更新数据（从 CSV 或 data/vr-data.json）
# 已内置 worker/data/vr-data.json（2596 条），如更新 CSV 需重新生成：
# python ../scripts/build-vr-data.py  # CSV -> data/vr-data.json + data/chunks/*.bin

# 2. 本地预览
npx wrangler dev

# 3. 部署到 Cloudflare（需先 wrangler login）
npx wrangler deploy
# 会得到 https://chengdu-vr-map-api.xxx.workers.dev

# 4. 回填到前端
# 把 URL 填进 config.js 的 window.VR_API
# window.VR_API = "https://chengdu-vr-map-api.xxx.workers.dev/api/vr"
```

## 接口
- `GET /api/vr?bbox=minLng,minLat,maxLng,maxLat&q=&district=&plate=` -> `{count, total, data:[]}`
- `GET /api/vr/scene/:scene` -> 单条
- `GET /api/meta` -> `{count, districts, plates}`
- `GET /api/health`

所有接口需带 `X-API-Time` / `X-API-Token` 或 `Referer` 来自允许域名，否则 403（当前为软校验，可改硬）。

## 本地回退
`window.VR_API` 留空时，前端自动走 `data/chunks/*.bin` 解密，不依赖 Worker 也能跑，但防爬效果降为“需执行 JS”级别。

## 更新数据
1. `E:\afei-tools\vr-link-table` 更新 CSV
2. `python scripts/build-vr-data.py` 重新生成 `data/chunks/*.bin` + `worker/data/vr-data.json` + `data/vr-map-data.enc.meta.json`
3. `git push`（`data/vr-data.json` 已 gitignore，不会泄露明文）
4. `cd worker && npx wrangler deploy` 更新线上接口
