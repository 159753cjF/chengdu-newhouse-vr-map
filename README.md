# 阿飞懂房 · 成都新房 VR 地图

把「小区 VR 链接表」变成一张**成都地图**：2596 个楼盘/场景按经纬度落位，聚合显示，点击项目即跳转对应 VR 全景页面。

## 在线访问

<https://159753cjf.github.io/chengdu-newhouse-vr-map/>

## 功能

- **聚合地图**：2600+ 点用 MarkerCluster 聚合，缩放自动拆分
- **点击即看**：点标记 → 弹窗「查看详情 / 打开 VR 全景」，跳转 720zf 原页面
- **独立详情页**：`detail.html?scene=xxx`，展示小区介绍 + 迷你地图 + VR 按钮
- **搜索/筛选**：楼盘名、区县、板块
- **底图切换**：天地图矢量 / 卫星 / OSM（失败自动回退）
- **热力图**：楼盘分布密度

## 小区介绍

- 介绍存 `data/intros.js`（`window.VR_INTROS`，按楼盘名索引，同一楼盘多场景共用一篇）
- 已试点 20 个小区（草稿骨架），未收录的楼盘详情页显示「暂未收录介绍，待补充」
- 新增/修改介绍：编辑 `data/intros.js` → push → Pages 自动更新，无需动地图数据

## 数据

- 来源：`E:\afei-tools\vr-link-table\data\chengdu-100yi-scenes.csv`
- 作品：720zf「成都百亿像素（楼盘版）」（公共深链目录，点击跳转原页面，本站不做任何二次加工/去水印）
- 坐标：场景已含经纬度，无需再地理编码

## 本地运行

```
python -m http.server 18770 --bind 127.0.0.1
# 浏览器打开 http://127.0.0.1:18770/index.html
```

## 数据与防爬

- 明文 `data/vr-map-data.js` 已废弃，现为占位空数组；真实数据为 `data/chunks/*.bin`（`base64(xor(json))`，需执行 `app.js` 解密）+ 可选 `Worker` 接口
- 裸 `curl` 旧路径只能拿到 `[]`，`curl chunks` 拿到的是加密串，需逆向 JS 才能还原
- `Worker` 进一步按视口 `bbox` 过滤 + `Referer/Token` 校验 + `60 req/min` 限流，`robots.txt` 已屏蔽 `/data/`

## 更新数据

1. `E:\afei-tools\vr-link-table` 更新 CSV 后
2. `python scripts/build-vr-data.py --csv E:/afei-tools/vr-link-table/data/chengdu-100yi-scenes.csv` 重新生成 `data/chunks/*.bin` + `worker/data/vr-data.json`（`data/vr-data.json` 已 gitignore，不会明文上库）
3. 推送到 GitHub，Pages 自动更新；如已部署 Worker，再 `cd worker && npx wrangler deploy` 更新接口

## Worker 接口（可选）

见 `worker/README.md`。`config.js` 留空 `window.VR_API` 则自动走本地解密；填入 `https://xxx.workers.dev/api/vr` 则走接口。
