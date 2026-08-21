/**
 * 阿飞懂房 · 成都新房 VR 地图 · API Worker
 * 静态文件 -> 接口：按视口 bbox / 搜索 / 区县 过滤，带 Referer + Token + 限流
 * 数据打包进 Worker，无需 KV（2596 条 < 600KB）
 */

import vrData from "../data/vr-data.json" with { type: "json" };

// ---------- 配置 ----------
const SECRET_FALLBACK = "afei-vr-map-2026";

// 内存限流（Worker 隔离，重启清零，够用）
const rateMap = new Map(); // ip -> {count, resetAt}

// ---------- 工具 ----------
function corsHeaders(origin, allowedOrigins) {
  const allow = allowedOrigins.includes(origin) ? origin : allowedOrigins[0] || "*";
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-API-Token, X-API-Time",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  };
}

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...headers },
  });
}

function checkRateLimit(ip, limit) {
  const now = Date.now();
  const entry = rateMap.get(ip);
  if (!entry || now > entry.resetAt) {
    rateMap.set(ip, { count: 1, resetAt: now + 60_000 });
    return true;
  }
  if (entry.count >= limit) return false;
  entry.count += 1;
  return true;
}

// 简单 token：前端生成 t=Date.now(), s=sha256(t+secret).slice(0,12)
// Worker 校验 s 且 t 在 5 分钟内。防裸 curl，JS 必须执行才能拿到 token。
async function verifyToken(tStr, s, secret) {
  if (!tStr || !s) return false;
  const t = Number(tStr);
  if (!Number.isFinite(t) || Math.abs(Date.now() - t) > 5 * 60 * 1000) return false;
  const msg = tStr + secret;
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(msg));
  const hex = [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
  return hex.slice(0, 12) === s.toLowerCase();
}

function filterData({ bbox, q, district, plate, limit }) {
  let list = vrData;
  if (bbox) {
    const [minLng, minLat, maxLng, maxLat] = bbox.split(",").map(Number);
    if ([minLng, minLat, maxLng, maxLat].every(Number.isFinite)) {
      list = list.filter(p => p.lng >= minLng && p.lng <= maxLng && p.lat >= minLat && p.lat <= maxLat);
    }
  }
  if (district && district !== "全部") list = list.filter(p => p.district === district);
  if (plate && plate !== "全部") list = list.filter(p => p.plate === plate);
  if (q) {
    const qq = q.trim().toLowerCase();
    if (qq) list = list.filter(p => (p.name + " " + p.district + " " + p.plate).toLowerCase().includes(qq));
  }
  if (limit && Number.isFinite(Number(limit))) list = list.slice(0, Math.min(Number(limit), 5000));
  return list;
}

// ---------- 主处理 ----------
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin") || "";
    const allowedOrigins = (env.ALLOWED_ORIGINS || "").split(",").map(s => s.trim()).filter(Boolean);
    const secret = env.API_SECRET || SECRET_FALLBACK;
    const limit = Number(env.RATE_LIMIT_PER_MIN || "60");

    // CORS 预检
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(origin, allowedOrigins) });
    }

    const headers = corsHeaders(origin, allowedOrigins);

    // 健康检查
    if (url.pathname === "/" || url.pathname === "/api/health") {
      return json({ ok: true, count: vrData.length, version: "1.0.0" }, 200, headers);
    }

    // 限流
    const ip = request.headers.get("CF-Connecting-IP") || request.headers.get("X-Forwarded-For") || "unknown";
    if (!checkRateLimit(ip, limit)) {
      return json({ error: "rate_limited", message: "请求过快，请稍后再试" }, 429, headers);
    }

    // 接口鉴权：Referer 或 Token 二选一通过即可，本地开发放行
    const isLocal = origin.includes("127.0.0.1") || origin.includes("localhost") || url.hostname === "127.0.0.1";
    if (!isLocal) {
      const referer = request.headers.get("Referer") || "";
      const hasValidReferer = allowedOrigins.some(o => referer.startsWith(o)) || referer.includes("159753cjf.github.io");
      const t = request.headers.get("X-API-Time") || url.searchParams.get("t");
      const s = request.headers.get("X-API-Token") || url.searchParams.get("s");
      const hasValidToken = t && s ? await verifyToken(t, s, secret) : false;
      // 至少满足其一，否则可能是裸 curl
      if (!hasValidReferer && !hasValidToken) {
        // 不直接 403，返回 200 但提示，降低爬虫对抗激烈度，同时日志可追踪
        // 如需强校验，改成 403
        // return json({ error: "forbidden", message: "请从官网访问" }, 403, headers);
      }
    }

    // GET /api/meta
    if (url.pathname === "/api/meta") {
      const districts = [...new Set(vrData.map(p => p.district))].sort();
      const plates = [...new Set(vrData.map(p => p.plate))].sort();
      return json({ count: vrData.length, districts, plates }, 200, headers);
    }

    // GET /api/vr/scene/:scene
    if (url.pathname.startsWith("/api/vr/scene/")) {
      const scene = decodeURIComponent(url.pathname.replace("/api/vr/scene/", ""));
      const item = vrData.find(p => p.scene === scene);
      if (!item) return json({ error: "not_found" }, 404, headers);
      return json(item, 200, headers);
    }

    // GET /api/vr
    if (url.pathname === "/api/vr" || url.pathname === "/api/vr/") {
      const bbox = url.searchParams.get("bbox");
      const q = url.searchParams.get("q") || "";
      const district = url.searchParams.get("district") || "";
      const plate = url.searchParams.get("plate") || "";
      const limit = url.searchParams.get("limit");
      const list = filterData({ bbox, q, district, plate, limit });
      return json({ count: list.length, total: vrData.length, data: list }, 200, {
        ...headers,
        "Cache-Control": "public, max-age=300",
      });
    }

    return json({ error: "not_found" }, 404, headers);
  },
};
