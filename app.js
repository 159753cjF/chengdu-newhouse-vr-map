/* 阿飞懂房 · 成都新房 VR 地图
 * 数据：window.VR_MAP_DATA（2596 个 VR 场景，含经纬度与 720zf 深链）
 * 底图：天地图（config.js 的 window.TDT_TK），失败回退 OSM
 */
(function () {
  "use strict";

  var VR = window.VR_MAP_DATA || [];

  var state = {
    q: "",
    district: "全部",
    plate: "全部",
    sort: "district",
    heat: false,
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
  var DISTRICTS = buildOptions("district");
  var PLATES = buildOptions("plate");

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
            '<a class="vr-link" href="' + escAttr(item.url) + '" target="_blank" rel="noopener">打开 VR ↗</a>' +
          "</div>" +
          '<div class="card-meta">' + escHtml(item.district) + (item.plate && item.plate !== "其它" ? " · " + escHtml(item.plate) : "") + "</div>" +
        "</article>"
      );
    }).join("");
    box.onclick = function (e) {
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
        '<a class="pop-open" href="' + escAttr(item.url) + '" target="_blank" rel="noopener">打开 VR 全景 ↗</a>' +
      "</div>"
    );
  }

  function renderMarkers() {
    if (!state.map || !state.clusters) return;
    state.clusters.clearLayers();
    var list = filtered();
    var byScene = {};
    list.forEach(function (item) {
      var m = L.marker([item.lat, item.lng], { icon: dotIcon(), riseOnHover: true });
      m.bindTooltip(item.name + (item.district !== "其它" ? " · " + item.district : ""), { direction: "top", offset: [0, -10], opacity: 0.92 });
      m.on("click", function () {
        // 聚合组内的标记用自带 openPopup 可能不显示，统一走独立弹窗
        state.selectedId = item.scene;
        renderList();
        openPopupAt(item);
      });
      state.clusters.addLayer(m);
      byScene[item.scene] = m;
    });
    state.byScene = byScene;
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

  /* ---------- 热力图 ---------- */
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

  /* ---------- 底图（天地图 / OSM，含高清屏优化与失败回退） ---------- */
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

  /* ---------- 工具 ---------- */
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

  document.addEventListener("DOMContentLoaded", function () {
    if (location.protocol === "file:") {
      setStatus("请用本地服务打开（python -m http.server）", true);
    }
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
    initMap();
  });
})();
