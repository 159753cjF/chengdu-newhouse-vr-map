// 天地图 Key（前端页面所需，已在天地图控制台配置域名白名单；个人免费 Key，商用需授权）
window.TDT_TK = "f7110c2bace12843468eeab7b4816306";

// VR 数据接口（静态改接口后）
// 部署 Worker 后填入你的 workers.dev 域名，例如 https://chengdu-vr-map-api.xxx.workers.dev
// 为空则自动回退到本地加密文件（data/chunks/0.bin + 1.bin）
window.VR_API = ""; // 例: "https://chengdu-vr-map-api.yourname.workers.dev/api/vr"
window.API_SECRET = "afei-vr-map-2026"; // 需与 worker/wrangler.toml 的 API_SECRET 一致
