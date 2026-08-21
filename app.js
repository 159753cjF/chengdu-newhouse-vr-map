/* 阿飞懂房 · 成都新房 VR 地图
 * 数据：优先走 window.VR_API 接口（Cloudflare Worker），失败回退到本地加密分片 data/chunks/*.bin
 * 底图：天地图（config.js 的 window.TDT_TK），失败回退 OSM
 */
(function () {
  "use strict";

  // ---------- 数据加载（接口优先，本地解密回退） ----------
  var VR = [];
  var DISTRICTS = [];
  var PLATES = [];

  async function sha256Hex(str) {
    var buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(str));
    return [...new Uint8Array(buf)].map(function (b) { return b.toString(16).padStart(2, "0"); }).join("");
  }

  async function makeToken() {
    var secret = window.API_SECRET || "afei-vr-map-2026";
    var t = String(Date.now());
    var hex = await sha256Hex(t + secret);
    return { t: t, s: hex.slice(0, 12) };
  }

  async function fetchViaApi() {
    var api = (window.VR_API || "").replace(/\/$/, "");
    if (!api) return null;
    try {
      var tok = await makeToken();
      var url = api + "?t=" + tok.t + "&s=" + tok.s;
      // 首次拉全量，视口过滤仍在前端做，保持列表筛选一致
      var res = await fetch(url, {
        headers: { "X-API-Time": tok.t, "X-API-Token": tok.s },
      });
      if (!res.ok) throw new Error("api " + res.status);
      var j = await res.json();
      var arr = j.data || j;
      if (!Array.isArray(arr) || !arr.length) throw new Error("empty api");
      return arr;
    } catch (e) {
      console.warn("[vr] api failed, fallback to local", e);
      return null;
    }
  }

  async function fetchLocalEncrypted() {
    // 兼容旧 window.VR_MAP_DATA（如果 index.html 仍引用了旧文件）
    if (window.VR_MAP_DATA && window.VR_MAP_DATA.length) {
      return window.VR_MAP_DATA;
    }
    try {
      var base = document.baseURI || location.href;
      // 两个分片
      var r0 = await fetch(new URL("data/chunks/0.bin", base));
      var r1 = await fetch(new URL("data/chunks/1.bin", base));
      if (!r0.ok || !r1.ok) throw new Error("chunks 404");
      var b64 = (await r0.text()) + (await r1.text());
      // base64 -> bytes
      var bin = atob(b64);
      var bytes = new Uint8Array(bin.length);
      for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      // xor 解密
      var key = window.API_SECRET || "afei-vr-map-2026";
      var kb = new TextEncoder().encode(key);
      for (var j = 0; j < bytes.length; j++) bytes[j] ^= kb[j % kb.length];
      var jsonStr = new TextDecoder().decode(bytes);
      var compact = JSON.parse(jsonStr);
      // 紧凑还原为原字段
      var arr = compact.map(function (c) {
        return { name: c.n, district: c.d, plate: c.p, url: c.u, scene: c.s, lat: c.la, lng: c.lo };
      });
      return arr;
    } catch (e) {
      console.error("[vr] local decrypt failed", e);
      // 最后回退：尝试旧明文文件
      try {
        var r = await fetch(new URL("data/vr-map-data.js", base));
        var txt = await r.text();
        var m = txt.match(/window\.VR_MAP_DATA\s*=\s*(\[.*\])/s);
        if (m) return JSON.parse(m[1]);
      } catch (_) {}
      return [];
    }
  }

  async function loadVR() {
    setStatus("正在加载楼盘数据…", false);
    var data = await fetchViaApi();
    if (!data) data = await fetchLocalEncrypted();
    VR = data || [];
    // 同步给 detail.html 兼容
    window.VR_MAP_DATA = VR;
    // 构建筛选
    DISTRICTS = buildOptions("district");
    PLATES = buildOptions("plate");
    setStatus("已加载 " + VR.length + " 个场景", false);
    return VR;
  }

  /* ---------- 位置修正（拖动标记） ---------- */
  function normalizeOv(v) {
    if (Array.isArray(v)) return { lat: v[0], lng: v[1] };
    return v;
  }
  function loadOverrides() {
    var o = {};
    try {
      var raw = localStorage.getItem("vr-pos-overrides");
      if (raw) { var p = JSON.parse(raw); Object.keys(p).forEach(function (k) { o[k] = normalizeOv(p[k]); }); }
    } catch (e) {}
    var shipped = window.VR_POS_OVERRIDES;
    if (shipped) Object.keys(shipped).forEach(function (k) { o[k] = normalizeOv(shipped[k]); });
    return o;
  }
  function saveOverrides() {
    try { localStorage.setItem("vr-pos-overrides", JSON.stringify(state.overrides)); } catch (e) {}
  }
  function posOf(item) {
    var o = state.overrides[item.scene];
    if (o && o.lat != null) return [o.lat, o.lng];
    return [item.lat, item.lng];
  }
  function correctionCount() {
    return Object.keys(state.overrides).length;
  }

  var state = {
    q: "",
    district: "全部",
    plate: "全部",
    sort: "district",
    heat: false,
    editMode: false,
    overrides: loadOverrides(),
    basemap: "tdt",
    map: null,
    clusters: null,
    heatLayer: null,
    baseLayer: null,
    basemapWatch: null,
  };
  function $(sel) { return document.querySelector(sel); }
  function setStatus(text, isErr) {
    var el = $("#map-status");
    if (!el) return;
    el.textContent = text;
    el.classList.toggle("err", !!isErr);
  }

  /* ---------- 区县 / 板块 ---------- */
  function buildOptions(field) {
    var set = {};
    VR.forEach(function (r) { set[r[field]] = (set[r[field]] || 0) + 1; });
    var arr = Object.keys(set).map(function (k) { return { name: k, count: set[k] }; });
    arr.sort(function (a, b) { return b.count - a.count; });
    return arr;
  }

  function filtered() {
    var list = VR.slice();
    var q = state.q.trim().toLowerCase();
    if (q) {
      list = list.filter(function (r) {
        return (r.name + " " + r.district + " " + r.plate).toLowerCase().indexOf(q) >= 0;
      });
    }
    if (state.district !== "全部") list = list.filter(function (r) { return r.district === state.district; });
    if (state.plate !== "全部") list = list.filter(function (r) { return r.plate === state.plate; });
    if (state.sort === "district") {
      list.sort(function (a, b) { return a.district.localeCompare(b.district, "zh") || a.name.localeCompare(b.name, "zh"); });
    } else {
      list.sort(function (a, b) { return a.name.localeCompare(b.name, "zh"); });
    }
    return list;
  }

  /* ---------- 渲染筛选器 ---------- */
  function renderFilters() {
    var el = $("#filter-district");
    var all = DISTRICTS.slice();
    el.innerHTML = ['<button type="button" class="chip' + (state.district === "全部" ? " on" : "") + '" data-d="全部">全部区县</button>']
      .concat(all.map(function (d) {
        return '<button type="button" class="chip' + (state.district === d.name ? " on" : "") + '" data-d="' + escAttr(d.name) + '">' + escHtml(d.name) + " ·" + d.count + "</button>";
      })).join("");
    el.onclick = function (e) {
      var b = e.target.closest("[data-d]");
      if (!b) return;
      state.district = b.dataset.d;
      refresh();
    };

    var ps = $("#filter-plate");
    ps.innerHTML = ['<option value="全部">全部板块</option>']
      .concat(PLATES.map(function (p) {
        return '<option value="' + escAttr(p.name) + '">' + escHtml(p.name) + "（" + p.count + "）</option>";
      })).join("");
    ps.value = state.plate;
    ps.onchange = function () {
      state.plate = ps.value;
      refresh();
    };

    var ss = $("#sort-select");
    ss.value = state.sort;
    ss.onchange = function () { state.sort = ss.value; refresh(); };
  }

  function renderList() {
    var list = filtered();
    $("#list-count").textContent = list.length;
    var box = $("#list-body");
    if (!list.length) {
      box.innerHTML = '<div class="empty">当前筛选无结果</div>';
      return;
    }
    box.innerHTML = list.map(function (item, i) {
      var on = state.selectedId === item.scene ? "on" : "";
      return (
        '<article class="card ' + on + '" data-scene="' + escAttr(item.scene) + '">' +
          '<div class="card-row1">' +
            '<div class="card-title">' + escHtml(item.name) + "</div>" +
            '<div class="card-actions">' +
              '<a class="vr-link detail" href="detail.html?scene=' + encodeURIComponent(item.scene) + '">详情</a>' +
              '<a class="vr-link" href="' + escAttr(item.url) + '" target="_blank" rel="noopener">打开 VR ↗</a>' +
            "</div>" +
          "</div>" +
          '<div class="card-meta">' + escHtml(item.district) + (item.plate && item.plate !== "其它" ? " · " + escHtml(item.plate) : "") + "</div>" +
        "</article>"
      );
    }).join("");
    box.onclick = function (e) {
      if (e.target.closest("a")) return;
      var card = e.target.closest("[data-scene]");
      if (!card) return;
      state.selectedId = card.dataset.scene;
      refresh();
      openPopupById(state.selectedId);
    };
  }

  /* ---------- 地图标记（聚合） ---------- */
  function dotIcon() {
    return L.divIcon({
      className: "dot-wrap",
      html: '<div class="vr-dot"></div>',
      iconSize: [12, 12],
      iconAnchor: [6, 6],
    });
  }

  function popupHtml(item) {
    return (
      '<div class="vr-pop">' +
        "<h3>" + escHtml(item.name) + "</h3>" +
        '<div class="pop-meta">' + escHtml(item.district) +
          (item.plate && item.plate !== "其它" ? " · " + escHtml(item.plate) : "") +
          '<br>VR 场景：' + escHtml(item.scene) + "</div>" +
        '<div class="pop-actions">' +
          '<a class="pop-detail" href="detail.html?scene=' + encodeURIComponent(item.scene) + '">查看详情</a>' +
          '<a class="pop-open" href="' + escAttr(item.url) + '" target="_blank" rel="noopener">打开 VR 全景 ↗</a>' +
        "</div>" +
      "</div>"
    );
  }

  function updateEditCount() {
    var el = $("#edit-count");
    if (el) el.textContent = "已修正 " + correctionCount() + " 处";
  }

  function renderMarkers() {
    if (!state.map || !state.clusters) return;
    state.clusters.clearLayers();
    var list = filtered();
    var byScene = {};
    list.forEach(function (item) {
      var p = posOf(item);
      var m = L.marker(p, { icon: dotIcon(), riseOnHover: true, draggable: state.editMode });
      m.bindTooltip(item.name + (item.district !== "其它" ? " · " + item.district : ""), { direction: "top", offset: [0, -10], opacity: 0.92 });
      m.on("click", function () {
        state.selectedId = item.scene;
        renderList();
        openPopupAt(item);
      });
      if (state.editMode) {
        m.on("dragend", function (ev) {
          var ll = ev.target.getLatLng();
          state.overrides[item.scene] = { lat: ll.lat, lng: ll.lng };
          saveOverrides();
          item.lat = ll.lat; item.lng = ll.lng;
          updateEditCount();
          state.clusters.removeLayer(ev.target);
          state.clusters.addLayer(ev.target);
        });
      }
      state.clusters.addLayer(m);
      byScene[item.scene] = m;
    });
    state.byScene = byScene;
    window.__markers = byScene;
  }

  function buildPosFileContent() {
    var keys = Object.keys(state.overrides);
    var lines = keys.map(function (k) {
      var o = state.overrides[k];
      return "  " + JSON.stringify(k) + ": [" + o.lat + ", " + o.lng + "],";
    });
    return "/* 位置修正（拖动标记导出）——保存为 data/pos-overrides.js 并 push，全站生效 */\n" +
      "window.VR_POS_OVERRIDES = {\n" + lines.join("\n") + "\n};\n";
  }

  function openExportModal() {
    var keys = Object.keys(state.overrides);
    if (!keys.length) { setStatus("还没有修正记录，请先拖动标记", true); return; }
    $("#export-text").value = buildPosFileContent();
    $("#export-modal").classList.remove("hidden");
    setStatus("已生成修正内容（" + keys.length + " 处），复制发给我即可写进源代码", false);
  }
  function closeExportModal() { $("#export-modal").classList.add("hidden"); }
  function downloadPosFile() {
    var content = $("#export-text").value || buildPosFileContent();
    var blob = new Blob([content], { type: "text/javascript;charset=utf-8" });
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "pos-overrides.js";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
  }
  function copyPosContent() {
    var text = $("#export-text").value;
    var done = function () { setStatus("已复制，直接粘贴发给我即可写进源代码", false); };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, function () { fallbackCopy(text, done); });
    } else { fallbackCopy(text, done); }
  }
  function fallbackCopy(text, done) {
    try {
      $("#export-text").select();
      document.execCommand("copy");
      done();
    } catch (e) { setStatus("复制失败，请手动全选复制", true); }
  }

  function updateEditBar() {
    var bar = $("#edit-bar");
    if (!bar) return;
    var editing = state.editMode;
    var has = correctionCount() > 0;
    bar.classList.toggle("hidden", !editing && !has);
    bar.classList.toggle("compact", !editing);
    var t = $("#edit-title"); if (t) t.style.display = editing ? "" : "none";
    var d = $("#btn-edit-done"); if (d) d.style.display = editing ? "" : "none";
    updateEditCount();
  }

  function openPopupAt(item) {
    if (!item || !state.map) return;
    L.popup({ autoPanPadding: [12, 12] })
      .setLatLng([item.lat, item.lng])
      .setContent(popupHtml(item))
      .openOn(state.map);
  }

  function openPopupById(scene) {
    var item = VR.find(function (x) { return x.scene === scene; });
    if (!item || !state.map) return;
    state.map.setView([item.lat, item.lng], Math.max(state.map.getZoom(), 14), { animate: true });
    setTimeout(function () { openPopupAt(item); }, 320);
  }

  function renderHeat() {
    if (!state.map) return;
    if (state.heatLayer) { state.map.removeLayer(state.heatLayer); state.heatLayer = null; }
    if (!state.heat) return;
    var pts = filtered().filter(function (x) { return x.lat && x.lng; })
      .map(function (x) { return [x.lat, x.lng, 1]; });
    if (window.L.heatLayer) {
      state.heatLayer = L.heatLayer(pts, {
        radius: 28,
        blur: 20,
        maxZoom: 16,
        gradient: { 0.15: "#2C5F2D", 0.45: "#B08900", 0.75: "#C9701F", 0.95: "#B8422E" },
      }).addTo(state.map);
    } else {
      setStatus("热力插件未加载（leaflet.heat 未引入）", true);
      state.heat = false;
      $("#btn-heat").textContent = "热力图";
    }
  }

  function refresh() {
    renderFilters();
    renderList();
    renderMarkers();
    renderHeat();
  }

  function fitAll() {
    if (!state.map) return;
    var pts = filtered().filter(function (x) { return x.lat && x.lng; }).map(function (x) { return [x.lat, x.lng]; });
    if (pts.length === 1) { state.map.setView(pts[0], 15); return; }
    if (pts.length) state.map.fitBounds(L.latLngBounds(pts).pad(0.1));
  }

  function tdtLayer(T, tk, highDpi) {
    var subdomains = ["0", "1", "2", "3", "4", "5", "6", "7"];
    var common = {
      subdomains: subdomains,
      maxZoom: 18,
      minZoom: 3,
      attribution: "&copy; 国家基础地理信息中心 · 天地图",
    };
    var url = "https://t{s}.tianditu.gov.cn/DataServer?T=" + T + "&x={x}&y={y}&l={z}&tk=" + tk;
    if (highDpi) {
      return L.tileLayer(url, Object.assign({}, common, {
        tileSize: 512, zoomOffset: -1, minZoom: 0,
      }));
    }
    return L.tileLayer(url, common);
  }
  function makeTdtLayers(tk, kind) {
    var highDpi = window.devicePixelRatio > 1;
    if (kind === "satellite") {
      var img = tdtLayer("img_w", tk, highDpi);
      var cia = tdtLayer("cia_w", tk, highDpi);
      return { group: L.layerGroup([img, cia]), watchLayer: img };
    }
    var vec = tdtLayer("vec_w", tk, highDpi);
    var cva = tdtLayer("cva_w", tk, highDpi);
    return { group: L.layerGroup([vec, cva]), watchLayer: vec };
  }
  function makeOsmLayer() {
    return L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: "&copy; OpenStreetMap" });
  }
  function clearBasemapWatch() {
    if (state.basemapWatch && state.basemapWatch.cancel) state.basemapWatch.cancel();
    state.basemapWatch = null;
  }
  function watchTileLayer(layer, opts) {
    var errors = 0, loads = 0, done = false;
    var finish = function (fn, arg) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      layer.off("tileerror", onErr);
      layer.off("tileload", onLoad);
      fn(arg);
    };
    var onErr = function () {
      errors += 1;
      if (errors >= 5) finish(opts.onFail, "瓦片加载失败（网络/屏蔽/Key）");
    };
    var onLoad = function () {
      loads += 1;
      if (loads >= 2) finish(opts.onOk, opts.okText);
    };
    var timer = setTimeout(function () {
      if (loads === 0) finish(opts.onFail, "瓦片超时未加载");
      else if (!done) finish(opts.onOk, opts.okText);
    }, 8000);
    layer.on("tileerror", onErr);
    layer.on("tileload", onLoad);
    return {
      cancel: function () {
        done = true;
        clearTimeout(timer);
        layer.off("tileerror", onErr);
        layer.off("tileload", onLoad);
      },
    };
  }
  function removeBaseLayer() {
    clearBasemapWatch();
    if (state.baseLayer && state.map) { try { state.map.removeLayer(state.baseLayer); } catch (_) {} }
    state.baseLayer = null;
  }
  function renderBasemapChips() {
    var el = document.querySelector("#basemap-chips");
    if (!el) return;
    el.querySelectorAll(".chip[data-bm]").forEach(function (c) {
      c.classList.toggle("on", c.dataset.bm === state.basemap);
    });
  }
  function setBasemap(kind, userClick) {
    if (!state.map) return;
    if (kind && ["tdt", "satellite", "osm"].indexOf(kind) >= 0) state.basemap = kind;
    renderBasemapChips();
    removeBaseLayer();
    var tk = window.TDT_TK;
    var labels = { tdt: "矢量底图", satellite: "卫星影像", osm: "OSM" };
    if (state.basemap === "osm" || !tk) {
      setStatus("正在加载 OSM…", false);
      state.baseLayer = makeOsmLayer();
      state.baseLayer.addTo(state.map);
      state.basemapWatch = watchTileLayer(state.baseLayer, {
        okText: "OSM 已就绪 · " + VR.length + " 个场景",
        onOk: function (msg) { setStatus(msg, false); },
        onFail: function (r) { setStatus(r, true); },
      });
      return;
    }
    setStatus("正在加载天地图" + labels[state.basemap] + "…", false);
    var layers = makeTdtLayers(tk, state.basemap);
    layers.group.addTo(state.map);
    state.baseLayer = layers.group;
    state.basemapWatch = watchTileLayer(layers.watchLayer, {
      okText: "天地图" + labels[state.basemap] + "已就绪 · " + VR.length + " 个场景",
      onOk: function (msg) { setStatus(msg, false); },
      onFail: function (reason) {
        setStatus(reason + " → 改用 OSM", true);
        removeBaseLayer();
        state.baseLayer = makeOsmLayer();
        state.baseLayer.addTo(state.map);
      },
    });
  }

  function escHtml(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }
  function escAttr(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  function initMap() {
    if (!window.L) {
      setStatus("Leaflet 未加载，请检查网络后刷新", true);
      return;
    }
    if (!window.L.markerClusterGroup) {
      setStatus("聚合插件未加载（leaflet.markercluster 未引入）", true);
    }
    var map = L.map("map", { center: [30.57, 104.06], zoom: 10, zoomControl: true, maxZoom: 18 });
    state.map = map;
    window.__map = map;
    state.clusters = L.markerClusterGroup({
      maxClusterRadius: 48,
      spiderfyOnMaxZoom: true,
      showCoverageOnHover: false,
      chunkedLoading: true,
    }).addTo(map);
    setBasemap(state.basemap);
    setTimeout(function () { map.invalidateSize(); }, 100);
    window.addEventListener("resize", function () { map.invalidateSize(); });
    refresh();
    fitAll();
  }

  document.addEventListener("DOMContentLoaded", async function () {
    if (location.protocol === "file:") {
      setStatus("请用本地服务打开（python -m http.server）", true);
    }
    // 绑定静态交互
    $("#q").addEventListener("input", function () {
      state.q = this.value;
      refresh();
    });
    $("#btn-fit").onclick = fitAll;
    $("#btn-heat").onclick = function () {
      state.heat = !state.heat;
      this.textContent = state.heat ? "关闭热力" : "热力图";
      renderHeat();
    };
    var bmBox = document.querySelector("#basemap-chips");
    if (bmBox) {
      bmBox.onclick = function (e) {
        var b = e.target.closest("[data-bm]");
        if (!b) return;
        setBasemap(b.dataset.bm, true);
      };
    }
    $("#btn-edit").onclick = function () {
      state.editMode = !state.editMode;
      document.body.classList.toggle("edit-mode", state.editMode);
      this.textContent = state.editMode ? "退出编辑" : "编辑位置";
      refresh();
      updateEditBar();
    };
    $("#btn-export-pos").onclick = openExportModal;
    $("#btn-clear-pos").onclick = function () {
      if (!correctionCount()) return;
      state.overrides = {};
      saveOverrides();
      refresh();
      updateEditBar();
      setStatus("已清空全部位置修正", false);
    };
    $("#btn-edit-done").onclick = function () { $("#btn-edit").click(); };
    $("#btn-copy-pos").onclick = copyPosContent;
    $("#btn-download-pos").onclick = downloadPosFile;
    $("#btn-close-modal").onclick = closeExportModal;
    $("#export-modal").addEventListener("click", function (e) {
      if (e.target === this) closeExportModal();
    });
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape") closeExportModal();
    });
    // 异步加载数据后再初始化地图
    await loadVR();
    initMap();
    updateEditBar();
  });
})();
