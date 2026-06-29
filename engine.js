// trading_vue_vanilla_js
// Zero-dependency vanilla-JS charting engine, Lightweight-Charts-compatible API.
// Rendering is the ORIGINAL author's (trading-vue-js, MIT): Grid / Sidebar / Botbar / Crosshair
// render classes + CursorUpdater, driven on layered canvases. The shell sets up the canvas layers,
// wires native pointer input, and drives the author's update()/sync() (the Vue-reactivity
// replacement). Multi-pane: one grid+sidebar canvas stack PER grid (main + offchart), stacked by
// each grid's offset/height, sharing one botbar (time axis) at the bottom. Layout is CACHED —
// rebuilt on data/range/size change; cursor moves just repaint.
// Internal time = MILLISECONDS (native); public API = SECONDS (LWC).
import Candle from './core/components/primitives/candle.js';   // author's primitive (incl. border patch)
import Volbar from './core/components/primitives/volbar.js';
import Price from './core/components/primitives/price.js';
import { buildLayout } from './core/build_layout.js';
import { calcZoom, calcRange } from './core/yscale.js';   // ported sidebar.js zoom math
import Grid from './core/components/js/grid.js';
import Sidebar from './core/components/js/sidebar.js';
import Botbar from './core/components/js/botbar.js';
import Crosshair from './core/components/js/crosshair.js';
import CursorUpdater from './core/components/js/updater.js';
import Const from './core/stuff/constants.js';
import Utils from './core/stuff/utils.js';

export const CrosshairMode = { Normal: 0, Magnet: 1, Hidden: 2 };
export const LineStyle = { Solid: 0, Dotted: 1, Dashed: 2, LargeDashed: 3, SparseDotted: 4 };
export const CandlestickSeries = { type: 'Candlestick' };
export const LineSeries = { type: 'Line' };
export const AreaSeries = { type: 'Area' };
export const BaselineSeries = { type: 'Baseline' };
export const HistogramSeries = { type: 'Histogram' };

const DEFAULT_FONT = '11px -apple-system, BlinkMacSystemFont, Arial, sans-serif';
const isObj = (x) => x && typeof x === 'object' && !Array.isArray(x);
function deepMerge(a, b) { const o = isObj(a) ? { ...a } : {}; for (const k in b) o[k] = (isObj(a[k]) && isObj(b[k])) ? deepMerge(a[k], b[k]) : b[k]; return o; }

const DEFAULTS = {
  layout: { background: { color: '#ffffff' }, textColor: '#888' },
  grid: { vertLines: { color: '#1a1a20' }, horzLines: { color: '#1a1a20' } },
  crosshair: { mode: CrosshairMode.Normal, color: '#758696', labelBg: '#363a45', labelText: '#e6e6e6' },
  timeScale: { timeVisible: true, secondsVisible: false, rightOffset: 6, borderColor: '#333' },
  rightPriceScale: { borderColor: '#333' },
};

// hex (#rgb / #rrggbb) -> rgba(...) with alpha; passes other formats through untouched
function hexA(c, a) {
  if (typeof c !== 'string' || c[0] !== '#') return c;
  let h = c.slice(1);
  if (h.length === 3) h = h.split('').map((x) => x + x).join('');
  const n = parseInt(h, 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

const TRANSPARENT = 'rgba(0,0,0,0)';
// LWC LineStyle (0 Solid,1 Dotted,2 Dashed,3 LargeDashed,4 SparseDotted) -> canvas dash pattern
function dashFor(style) {
  switch (style) { case 1: return [1, 2]; case 2: return [5, 2]; case 3: return [8, 5]; case 4: return [1, 4]; default: return []; }
}
function candleStyle(o = {}) {
  // borderVisible / wickVisible are LWC booleans the app toggles. Honor them: border -> null
  // (the primitive skips a null border); wick -> transparent (the primitive always strokes the wick).
  const border = o.borderVisible === false;
  const wick = o.wickVisible === false;
  return {
    colorCandleUp: o.upColor || '#26a69a', colorCandleDw: o.downColor || '#ef5350',   // body (transparent when bodyVisible off, set by the app)
    colorCandleBorderUp: border ? null : (o.borderUpColor || o.borderColor || null),
    colorCandleBorderDw: border ? null : (o.borderDownColor || o.borderColor || null),
    colorWickUp: wick ? TRANSPARENT : (o.wickUpColor || o.wickColor || o.upColor || '#26a69a'),
    colorWickDw: wick ? TRANSPARENT : (o.wickDownColor || o.wickColor || o.downColor || '#ef5350'),
    colorVolUp: o.volUpColor || hexA(o.upColor || '#26a69a', 0.45),
    colorVolDw: o.volDownColor || hexA(o.downColor || '#ef5350', 0.45),
  };
}

class Series {
  constructor(chart, type, opts = {}, pane = 0) {
    this._chart = chart; this._type = type; this._opts = opts; this._pane = pane | 0;
    this._style = candleStyle(opts);
    this._rows = [];
    this._primitives = [];   // ISeriesPrimitive hosts (drawings/tools/alerts/study-shapes)
    this._priceLines = [];
  }
  _isCandle() { return this._type.type === 'Candlestick'; }
  // candlestick -> [t,o,h,l,c,v]; value series (line/area/baseline/histogram) -> [t, value]
  _row(b) {
    const t = Math.round(b.time * 1000);
    if (b.open != null || b.high != null || b.close != null) return [t, b.open, b.high, b.low, b.close, b.volume || 0];
    return b.color != null ? [t, b.value, b.color] : [t, b.value];   // per-point color (histogram/line)
  }
  setData(bars) {
    const c = this._chart;
    const oldFirst = this._rows.length ? this._rows[0][0] : null;
    this._rows = (bars || []).map((b) => this._row(b)).sort((a, z) => a[0] - z[0]);
    // ib lazy-history: older bars prepended at the front shift every existing bar's index up by
    // the prepend count. Shift _range by the same amount so the visible window stays on the same
    // bars (no jerk) and the "near left edge" lazy-load check resets. Main candle series only (its
    // rows define the index axis), and only on a true prepend where the old data is retained.
    if (c._ib && c._range && oldFirst != null && c._cs() === this) {
      const d = this._rows; let pre = 0;
      while (pre < d.length && d[pre][0] < oldFirst) pre++;
      if (pre > 0 && d[pre] && d[pre][0] === oldFirst) { c._range = [c._range[0] + pre, c._range[1] + pre]; c._emitRange(); }
    }
    if (this._isCandle() && !c._range) c._fitToData();
    c._invalidate(); return this;
  }
  update(b) {
    const row = this._row(b);
    const d = this._rows, n = d.length;
    if (n && row[0] === d[n - 1][0]) d[n - 1] = row;
    else if (!n || row[0] > d[n - 1][0]) d.push(row);
    else { const i = d.findIndex((x) => x[0] >= row[0]); if (i >= 0 && d[i][0] === row[0]) d[i] = row; else d.splice(i < 0 ? n : i, 0, row); }
    if (this._isCandle() && !this._chart._range) this._chart._fitToData();
    this._chart._invalidate(); return this;
  }
  applyOptions(o = {}) { this._opts = { ...this._opts, ...o }; this._style = candleStyle(this._opts); this._chart._restyle(this); this._chart._invalidate(); return this; }
  options() { return this._opts; }
  priceToCoordinate(p) { return this._chart._priceToCoord(this._pane, p); }
  coordinateToPrice(y) { return this._chart._coordToPrice(this._pane, y); }
  priceFormatter() { return { format: (p) => String(p) }; }
  priceScale() {
    const c = this._chart, k = this._pane;
    return { width: () => c._sbWidth(), applyOptions: (o = {}) => { if (o.mode != null) c._setPaneLog(k, o.mode === 1); if (o.autoScale) c._resetPaneAuto(k); }, options: () => ({ mode: c._paneLogOf(k) ? 1 : 0 }) };
  }
  createPriceLine(opts = {}) {
    const line = { _opts: { ...opts }, applyOptions: (o) => { Object.assign(line._opts, o); this._chart._schedule(); return line; }, options: () => line._opts };
    this._priceLines.push(line); this._chart._schedule(); return line;
  }
  removePriceLine(line) { const i = this._priceLines.indexOf(line); if (i >= 0) this._priceLines.splice(i, 1); this._chart._schedule(); }
  // ISeriesPrimitive host: the Engine runs prim.paneViews().renderer().draw(target) each frame
  attachPrimitive(prim) {
    if (this._primitives.indexOf(prim) >= 0) return;
    this._primitives.push(prim);
    if (prim.attached) prim.attached({ chart: this._chart, series: this, requestUpdate: () => this._chart._schedule() });
    this._chart._invalidate();
  }
  detachPrimitive(prim) {
    const i = this._primitives.indexOf(prim); if (i < 0) return;
    this._primitives.splice(i, 1); if (prim.detached) prim.detached(); this._chart._invalidate();
  }
}

class Chart {
  constructor(el, options = {}) {
    if (!el) throw new Error('createChart: a container element is required');
    this.el = el;
    this._options = deepMerge(DEFAULTS, options);
    this._series = [];
    this._range = null;            // [t0, t1] MS
    this._g = null; this._chartW = 0; this._chartH = 0; this._interval = 60000;
    this._layoutDirty = true;
    this._y = {};              // per-grid Y-scale state: gridIndex -> { auto, range:[hi,lo], zoom }
    this._yDrag = null; this._yStartRange = null;   // transient price-axis drag state (incl. pane k)
    this._panPane = -1;        // grid the current pan started in (for vertical pan)
    this._mouse = null;            // {x, y} CSS px, or null
    this._cbs = { crosshair: new Set(), click: new Set(), range: new Set(), logical: new Set() };
    this._stretch = {};            // pane ID -> relative height weight (setStretchFactor)
    this._preserve = {};           // pane ID -> keep its grid even when all its series are invisible
                                   // (LWC preserveEmptyPane): a COLLAPSED pane stays as an empty bar;
                                   // a HIDDEN pane (not preserved) drops out entirely.
    this._paneIds = [0];           // grid POSITION -> pane ID (top->bottom); rebuilt each layout.
                                   // Decouples series._pane (stable id, keys state) from grid index
                                   // (position), so a hidden/removed middle pane can drop out cleanly.
    this._dirty = false;
    this._style = candleStyle({});
    this._gridShaders = []; this._sbShaders = []; this._noShaders = [];   // targeted shaders (price-tag -> main sidebar)
    this._panes = [];              // per-grid render bundles
    this._ocs = [];               // offchart descriptors [{ paneIndex, series:[...] }] ordered -> grids[1..N]
    this._logScale = false;       // main price scale (mode 1 = log) — set by _readScaleOpts
    this._paneLog = {};           // offchart pane index -> logScale bool
    this._invert = false;         // invertScale (flip Y)
    this._scaleSide = 'right';    // price axis side ('right' | 'left')
    this._showPrice = true; this._showTime = true;   // price-scale / time-scale visibility
    this._lastValueVisible = true;
    this._sbPx = 0; this._chartLeftPx = 0;   // sidebar width + chart left-offset (left-scale) in CSS px
    this._ib = !!(options.ib || (options.timeScale && options.timeScale.indexBased));   // index-based mode (gap-collapsed x-axis); _range is in INDEX units
    this._readScaleOpts(this._options);   // seed log/invert/side/visibility from initial options

    // root container; one botbar canvas now, grid+sidebar canvases per pane (created in _rebuild)
    const root = document.createElement('div');
    root.style.cssText = 'position:relative;width:100%;height:100%;overflow:hidden;cursor:crosshair;';
    root.style.background = (this._options.layout.background && this._options.layout.background.color) || '#fff';
    el.appendChild(root);
    this._root = root;
    this._cv = { bb: this._mkcv() };

    this._buildComp();
    this._wire();
    this._ro = new ResizeObserver(() => this.resize());
    this._ro.observe(el);
    this.resize();
  }

  _mkcv() { const c = document.createElement('canvas'); c.style.cssText = 'position:absolute;display:block;'; this._root.appendChild(c); return c; }

  // The Vue-component surrogate the author's render classes read off (comp + comp.$props).
  _buildComp() {
    const cursor = { x: undefined, y: undefined, t: undefined, y$: undefined, grid_id: 0, locked: false, values: {} };
    const $props = {
      width: 0, height: 0,
      layout: null, sub: [], range: this._range || [0, 0],
      grid_id: 0, interval: 60000,
      cursor,                       // SHARED ref (CursorUpdater writes it, render classes read it)
      colors: this._colors(),
      font: DEFAULT_FONT, config: Const.ChartConfig,
      shaders: [], timezone: 0, meta: {}, y_transform: null,
    };
    this._comp = {
      config: Const.ChartConfig, bot_shaders: [],
      $emit: () => {}, $set: (o, k, v) => { o[k] = v; },
      _layout: null, cursor,
      main_section: { sub: [], data: [] }, sub_section: { data: [] },
      interval: 60000, $props,
    };
  }

  resize() {
    const r = this.el.getBoundingClientRect();
    this._dpr = window.devicePixelRatio || 1;
    this._w = Math.max(1, r.width); this._h = Math.max(1, r.height);
    this._invalidate(); return this;
  }
  _invalidate() { this._layoutDirty = true; this._schedule(); }
  _schedule() { if (this._dirty) return; this._dirty = true; requestAnimationFrame(() => { this._dirty = false; this._redraw(); }); }
  _cs() { return this._series.find((s) => s._isCandle() && s._rows.length); }
  _restyle(s) { if (s === this._cs()) { this._style = s._style; if (this._ov) this._applyOvStyle(); } }

  // robust bar interval (author's detect_interval = min positive gap; survives leading session gaps)
  _iv() { const cs = this._cs(); return (cs && Utils.detect_interval(cs._rows)) || this._interval || 60000; }
  _fitToData() {
    const cs = this._cs(); if (!cs) return;
    const d = cs._rows, n = d.length;
    const off = this._options.timeScale.rightOffset || 6;
    if (this._ib) {   // index units: last index = n-1 (array position)
      const i1 = (n - 1) + off;
      this._range = [Math.max(0, i1 - 150), i1];
      return;
    }
    const last = d[n - 1][0], iv = this._iv();
    const t1 = last + off * iv;
    this._range = [Math.max(d[0][0], t1 - 150 * iv), t1];
  }
  // layout-units <-> real time (ms). Identity in regular mode (t2i needs the ib guard; i2t is already
  // identity when ti_map.ib is false). In ib mode: index <-> time via the author's ti_mapping.
  _i2t(v) { const g = this._g; return (this._ib && g && g.ti_map) ? g.ti_map.i2t(v) : v; }
  _t2i(v) { const g = this._g; return (this._ib && g && g.ti_map) ? g.ti_map.t2i(v) : v; }
  // LWC logical coordinate = fractional bar index into the candlestick data (works in any mode,
  // extrapolating past the ends by one interval per bar — matches LWC's right-offset whitespace).
  _timeToLogical(t) {
    const cs = this._cs(); if (!cs) return 0;
    const d = cs._rows, n = d.length, iv = this._iv(); if (!n) return 0;
    if (t <= d[0][0]) return (t - d[0][0]) / iv;
    if (t >= d[n - 1][0]) return (n - 1) + (t - d[n - 1][0]) / iv;
    let lo = 0, hi = n - 1; while (lo + 1 < hi) { const m = (lo + hi) >> 1; if (d[m][0] <= t) lo = m; else hi = m; }
    return lo + (t - d[lo][0]) / ((d[lo + 1][0] - d[lo][0]) || iv);
  }
  _logicalToTime(i) {
    const cs = this._cs(); if (!cs) return 0;
    const d = cs._rows, n = d.length, iv = this._iv(); if (!n) return 0;
    if (i <= 0) return d[0][0] + i * iv;
    if (i >= n - 1) return d[n - 1][0] + (i - (n - 1)) * iv;
    const k = Math.floor(i); return d[k][0] + (i - k) * ((d[k + 1][0] - d[k][0]) || iv);
  }

  _yOf(k) { return this._y[k] || (this._y[k] = { auto: true, range: null, zoom: 1 }); }
  _resetPaneAuto(k) { const y = this._yOf(k); y.auto = true; y.range = null; y.zoom = 1; this._invalidate(); }   // price scale -> auto-fit (LWC autoScale)
  _paneAt(y) { const L = this._comp.$props.layout; if (!L) return -1; const gs = L.grids; for (let k = 0; k < gs.length; k++) { const g = gs[k]; if (y >= g.offset && y < g.offset + g.height) return k; } return -1; }
  // boundary between two stacked panes: the LOWER grid index k (1..N-1) if y is within the grab
  // zone of grids[k].offset, else -1. Drives separator-drag resizing + the row-resize cursor.
  _separatorAt(y) {
    const L = this._comp.$props.layout; if (!L || !L.grids || L.grids.length < 2) return -1;
    const grids = L.grids;
    for (let k = 1; k < grids.length; k++) if (Math.abs(y - grids[k].offset) <= 4) return k;
    return -1;
  }
  // tvjs-xp grid-resize (Splitter.vue): grow the pane ABOVE the boundary by the drag offset,
  // shrink the one below (guarded by a min height), then renormalize every grid's pixel height
  // into stretch weights (his calc_heights). _stretch feeds the next layout build.
  _resizePanes(clientY) {
    const d = this._sepDrag, L = this._comp.$props.layout; if (!d || !L || !L.grids) return;
    const off = clientY - d.y0, nh1 = d.h1 + off, nh2 = d.h2 - off, MIN = 30;
    if (nh1 < MIN || nh2 < MIN) return;
    const px = L.grids.map((g) => g.height); px[d.k - 1] = nh1; px[d.k] = nh2;
    const sum = px.reduce((a, b) => a + b, 0) || 1;
    for (let i = 0; i < px.length; i++) this._stretch[this._idAt(i)] = px[i] / sum;   // key by pane ID
  }
  // switch a pane from auto-fit to a manual price window, seeded with its current visible extent
  _ensureManual(pos) { const y = this._yOf(this._idAt(pos)); if (y.auto) { const g = this._gridAt(pos); y.range = g ? [g.$_hi, g.$_lo] : null; y.auto = false; } }

  // offchart series grouped by pane index, ordered -> [{ paneIndex, series:[...] }]
  _offcharts() {
    const byPane = new Map();
    for (const s of this._series) {
      // a pane with NO visible series is dropped entirely (LWC-style), reclaiming its space — UNLESS
      // it's preserved (collapsed), in which case its grid is kept as an empty bar (the invisible
      // series still defines the y-range but isn't drawn). The id<->position mapping keeps the rest
      // consistent even mid-stack.
      if (s._pane > 0 && s._rows.length && (s._opts.visible !== false || this._preserve[s._pane])) {
        if (!byPane.has(s._pane)) byPane.set(s._pane, []);
        byPane.get(s._pane).push(s);
      }
    }
    return [...byPane.keys()].sort((a, b) => a - b).map((p) => ({ paneIndex: p, series: byPane.get(p) }));
  }

  _rebuild() {
    const cs = this._cs(); if (!cs || !this._range) { this._g = null; return; }
    const colors = this._colors();
    this._ocs = this._offcharts();
    this._paneIds = [0, ...this._ocs.map((o) => o.paneIndex)];   // grid position -> pane id (main + offcharts)
    // manual Y windows keyed by grid POSITION (the layout indexes per grid). _y is keyed by pane
    // ID; a hidden pane (not in _paneIds) is skipped — its window restores when it reappears.
    const yTransforms = {};
    for (const k in this._y) { const y = this._y[k]; if (!y.auto && y.range) { const pos = this._paneIds.indexOf(+k); if (pos >= 0) yTransforms[pos] = { auto: false, range: y.range }; } }
    const offcharts = this._ocs.map((o) => {
      const id = o.paneIndex;   // pane ID (keys per-pane state, survives reorder/hide)
      const s0 = o.series[0];   // candle pane: drop volume so the y-range scan = [high, low], not volume
      const rows = s0._isCandle() ? s0._rows.map((r) => [r[0], r[1], r[2], r[3], r[4]]) : s0._rows;
      return { rows, grid: { logScale: !!this._paneLog[id], height: this._stretch[id] } };
    });
    const { layout, sub, interval } = buildLayout({
      rows: cs._rows, range: this._range, width: this._w, height: this._h,
      colors, font: this._font(), timezone: this._comp.$props.timezone, yTransforms, offcharts, logScale: this._logScale, ib: this._ib, mainGridHeight: this._stretch[0],
      hidePrice: !this._showPrice, hideTime: !this._showTime,   // reclaim freed space when a scale is hidden
      candleWidth: this._candleWidth(),   // user-set candle body width (fraction of bar step)
    });
    const grids = layout.grids; const g = grids[0]; this._g = g || null;
    if (!g) return;
    if (this._invert) for (const gr of grids) this._invertGrid(gr);   // flip Y before anything reads the layout
    this._chartW = g.width; this._chartH = g.height; this._interval = interval;
    this._sbPx = this._showPrice ? (g.sb || 0) : 0;
    this._chartLeftPx = (this._scaleSide === 'left') ? this._sbPx : 0;
    this._lastValueVisible = !cs._opts || cs._opts.lastValueVisible !== false;
    this._style = cs._style;

    // feed the author's comp/$props the freshly built layout + frame state
    const p = this._comp.$props;
    p.layout = layout; p.sub = sub; p.range = this._range; p.interval = interval; p.colors = colors;
    p.width = this._w; p.height = this._h; p.font = this._font();
    // app's time formatters (the botbar uses these for the axis ticks + crosshair time label)
    p.timeFormatter = (this._options.localization && this._options.localization.timeFormatter) || null;
    p.tickMarkFormatter = (this._options.timeScale && this._options.timeScale.tickMarkFormatter) || null;
    this._comp._layout = layout; this._comp.interval = interval; this._comp.main_section.sub = sub;
    // offchart overlay descriptors — CursorUpdater.overlay_data reads sub_section.data per offchart grid
    this._comp.sub_section.data = this._ocs.map((o) => ({ type: 'line', grid: {}, data: o.series[0]._rows }));
    this._root.style.background = colors.back;

    if (!this._bb) this._bb = new Botbar(this._cv.bb, this._comp);
    this._bb.layout = layout;                  // botbar captures $props.layout in its ctor — refresh
    this._cu = new CursorUpdater(this._comp);   // captures _layout.grids — refresh on rebuild

    this._ensurePanes(grids.length);
    for (const pane of this._panes) {
      const gk = grids[pane.k];
      pane.id = this._idAt(pane.k);             // pane.k = grid POSITION; pane.id = pane ID
      pane.crossComp.$props.layout = gk;        // crosshair reads grid-level layout.id/.width/.height
      pane.crossComp.$props.colors = colors;
      if (pane.k === 0) this._refreshOverlay(g, cs._rows, colors);
      pane.series = this._seriesInPane(pane.id);
      // overlay z-order: candles -> value series -> price lines -> primitive host (under crosshair)
      const overlays = [];
      if (pane.k === 0) overlays.push({ z: 0, display: true, renderer: { draw: (ctx) => this._drawCandles(ctx) } });
      for (const s of pane.series) overlays.push({ z: 10, display: true, renderer: { draw: (ctx) => this._drawSeries(ctx, pane.k, s) } });
      overlays.push({ z: 1e5, display: true, renderer: { draw: (ctx) => this._drawPriceLines(ctx, pane.k) } });
      overlays.push({ z: 1e6, display: true, renderer: { draw: (ctx) => this._drawPrimitives(ctx, pane) } });
      pane.grid.overlays = overlays;
    }

    this._sizeLayers(layout);
    this._layoutDirty = false;
  }

  // create/destroy pane bundles to match the grid count
  _ensurePanes(n) {
    while (this._panes.length < n) this._panes.push(this._makePane(this._panes.length));
    while (this._panes.length > n) { const pane = this._panes.pop(); this._destroyPane(pane); }
  }
  _makePane(k) {
    const gridCv = this._mkcv(), sbCv = this._mkcv();
    this._comp.$props.grid_id = k;             // Grid/Sidebar capture this.id = grid_id at construction
    const grid = new Grid(gridCv, this._comp);
    const sb = new Sidebar(sbCv, this._comp, this._scaleSide);
    // crosshair needs grid-level layout (id/width/height) -> its OWN tiny comp pointing at grids[k]
    const crossComp = { $props: { layout: this._comp.$props.layout.grids[k], cursor: this._comp.cursor, colors: this._comp.$props.colors } };
    const cross = new Crosshair(crossComp);
    const pane = { k, gridCv, sbCv, grid, sb, crossComp, cross, crossLayer: { renderer: cross }, series: [], ov: null };
    if (k === 0) { this._buildOverlay(); pane.ov = this._ov; }   // overlays assigned in _rebuild
    return pane;
  }
  _destroyPane(pane) {
    try { this._root.removeChild(pane.gridCv); this._root.removeChild(pane.sbCv); } catch (_) {}
  }

  // size + position each pane's grid+sidebar stack, plus the shared botbar (DPR-scaled; draw in CSS px)
  _sizeLayers(layout) {
    const grids = layout.grids, bb = layout.botbar;
    const left = this._scaleSide === 'left';
    for (const pane of this._panes) {
      const g = grids[pane.k], sb = g.sb || 0;
      const gx = left ? sb : 0;          // grid x (chart shifts right when the scale is on the left)
      const sx = left ? 0 : g.width;     // sidebar x
      this._place(pane.gridCv, g.width, g.height, gx, g.offset);
      this._place(pane.sbCv, sb, g.height, sx, g.offset);
      pane.sbCv.style.display = this._showPrice ? 'block' : 'none';   // visibility toggle (no space reclaim)
    }
    this._place(this._cv.bb, bb.width, bb.height, left ? (this._sbPx) : 0, bb.offset);
    this._cv.bb.style.display = this._showTime ? 'block' : 'none';
  }
  _place(cv, w, h, left, top) {
    const dpr = this._dpr;
    cv.style.left = left + 'px'; cv.style.top = top + 'px';
    cv.style.width = Math.round(w) + 'px'; cv.style.height = Math.round(h) + 'px';
    const bw = Math.max(1, Math.round(w * dpr)), bh = Math.max(1, Math.round(h * dpr));
    if (cv.width !== bw) cv.width = bw;
    if (cv.height !== bh) cv.height = bh;
    const ctx = cv.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);    // canvas.width assign resets transform; re-apply
    ctx.font = this._comp.$props.font;
  }

  // Faithful Candles-overlay surrogate: the author's Volbar / Candle / Price primitives read off it.
  // Its $props.layout is the GRID (grids[0]), unlike the render classes whose $props.layout is full.
  _buildOverlay() {
    const ov = {
      $props: { layout: null, data: [], config: Const.ChartConfig, colors: this._comp.$props.colors, last: null, meta: {}, tf: undefined },
      data: [],
      $emit: (ev, s) => { if (ev === 'new-shader') (s.target === 'sidebar' ? this._sbShaders : this._gridShaders).push(s); },
      show_volume: true, price_line: true,
    };
    this._ov = ov;
    this._applyOvStyle();
    ov.price = new Price(ov);   // last-price line + (emitted) sidebar price-tag shader
  }
  _applyOvStyle() {
    const ov = this._ov, st = this._style;
    ov.colorCandleUp = st.colorCandleUp; ov.colorCandleDw = st.colorCandleDw;
    ov.colorWickUp = st.colorWickUp; ov.colorWickDw = st.colorWickDw;
    ov.colorCandleBorderUp = st.colorCandleBorderUp; ov.colorCandleBorderDw = st.colorCandleBorderDw;
    ov.colorVolUp = st.colorVolUp; ov.colorVolDw = st.colorVolDw;
  }
  _refreshOverlay(g, rows, colors) {
    const ov = this._ov; if (!ov) return;
    const last = rows && rows.length ? rows[rows.length - 1] : null;
    ov.$props.layout = g; ov.$props.colors = colors;
    ov.$props.data = rows; ov.data = rows;
    ov.$props.last = last; ov.$props.meta = { last };
    const cs = this._cs(); ov.price_line = !cs || cs._opts.priceLineVisible !== false;   // series priceLineVisible toggle
    this._applyOvStyle();
  }
  // the author's Candles.draw loop: volume bars, then candles, then the last-price line
  _drawCandles(ctx) {
    const ov = this._ov, g = ov && ov.$props.layout; if (!g) return;
    if (ov.show_volume) for (const v of (g.volume || [])) new Volbar(ov, ctx, v);
    for (const c of (g.candles || [])) new Candle(ov, ctx, c);
    this._drawCurrentPriceLine(ctx, g);
  }
  // the current (last) price line — LWC series priceLineVisible/Color/Width/Style at the last close
  _drawCurrentPriceLine(ctx, g) {
    const cs = this._cs(); if (!cs || !cs._rows.length) return;
    const o = cs._opts; if (o.priceLineVisible === false) return;
    const last = cs._rows[cs._rows.length - 1], price = last[4];
    const y = Math.floor(g.$2screen(price)) + 0.5;
    ctx.beginPath();
    ctx.strokeStyle = o.priceLineColor || (price >= last[1] ? this._style.colorCandleUp : this._style.colorCandleDw);
    ctx.lineWidth = o.priceLineWidth || 1;
    ctx.setLineDash(dashFor(o.priceLineStyle != null ? o.priceLineStyle : 2));   // LWC default = dashed
    ctx.moveTo(0, y); ctx.lineTo(g.width, y); ctx.stroke();
    ctx.setLineDash([]);
  }
  // ---- series-type renderers (value series; candles use the Candles overlay) ----
  // series to render in a pane via _drawSeries — excludes the MAIN candle (drawn by the Candles overlay)
  _seriesInPane(k) { const main = this._cs(); return this._series.filter((s) => s._pane === k && s._rows.length && s !== main && s._opts.visible !== false); }
  _drawSeries(ctx, k, s) {
    const g = this._gridAt(k); if (!g || !s._rows.length) return;
    if (s._isCandle()) return this._drawCandleSeries(ctx, g, s);   // candle in an offchart pane (e.g. compare)
    switch (s._type.type) {
      case 'Area': return this._drawArea(ctx, g, s);
      case 'Baseline': return this._drawBaseline(ctx, g, s);
      case 'Histogram': return this._drawHistogram(ctx, g, s);
      default: return this._drawLineSeries(ctx, g, s);   // Line
    }
  }
  _polyline(ctx, g, rows) {
    let started = false;
    for (const r of rows) { const x = g.t2screen(r[0]), y = g.$2screen(r[1]); if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y); }
  }
  _drawLineSeries(ctx, g, s) {
    const o = s._opts;
    ctx.beginPath(); this._polyline(ctx, g, s._rows);
    ctx.lineWidth = o.lineWidth || 1.5; ctx.strokeStyle = o.color || o.lineColor || '#4d88ff'; ctx.stroke();
  }
  _drawArea(ctx, g, s) {
    const o = s._opts, rows = s._rows, base = g.height;
    const line = o.lineColor || o.color || '#4d88ff';
    const top = o.topColor || hexA(line, 0.4), bot = o.bottomColor || hexA(line, 0.04);
    const x0 = g.t2screen(rows[0][0]), x1 = g.t2screen(rows[rows.length - 1][0]);
    ctx.beginPath(); this._polyline(ctx, g, rows);
    ctx.lineTo(x1, base); ctx.lineTo(x0, base); ctx.closePath();
    let fill = top;
    if (ctx.createLinearGradient) { const gr = ctx.createLinearGradient(0, 0, 0, base); gr.addColorStop(0, top); gr.addColorStop(1, bot); fill = gr; }
    ctx.fillStyle = fill; ctx.fill();
    ctx.beginPath(); this._polyline(ctx, g, rows);
    ctx.lineWidth = o.lineWidth || 2; ctx.strokeStyle = line; ctx.stroke();
  }
  _drawBaseline(ctx, g, s) {
    const o = s._opts, rows = s._rows;
    const bv = (o.baseValue && o.baseValue.price != null) ? o.baseValue.price : (o.baseValue != null ? o.baseValue : 0);
    const topLine = o.topLineColor || '#26a69a', botLine = o.bottomLineColor || '#ef5350';
    const yBase = g.$2screen(bv), x0 = g.t2screen(rows[0][0]), x1 = g.t2screen(rows[rows.length - 1][0]);
    // fill: line -> base, split at the baseline (top half vs bottom half) via a 2-stop gradient
    if (ctx.createLinearGradient) {
      ctx.beginPath(); this._polyline(ctx, g, rows); ctx.lineTo(x1, yBase); ctx.lineTo(x0, yBase); ctx.closePath();
      const f = Math.max(0, Math.min(1, yBase / g.height));
      const gr = ctx.createLinearGradient(0, 0, 0, g.height);
      gr.addColorStop(0, o.topFillColor1 || hexA(topLine, 0.28));
      gr.addColorStop(f, o.topFillColor2 || hexA(topLine, 0.05));
      gr.addColorStop(f, o.bottomFillColor1 || hexA(botLine, 0.05));
      gr.addColorStop(1, o.bottomFillColor2 || hexA(botLine, 0.28));
      ctx.fillStyle = gr; ctx.fill();
    }
    // line, colored per segment by side of the baseline
    ctx.lineWidth = o.lineWidth || 2;
    let prev = null;
    for (const r of rows) {
      const x = g.t2screen(r[0]), y = g.$2screen(r[1]);
      if (prev) { ctx.beginPath(); ctx.moveTo(prev.x, prev.y); ctx.lineTo(x, y); ctx.strokeStyle = (r[1] >= bv) ? topLine : botLine; ctx.stroke(); }
      prev = { x, y };
    }
  }
  _drawHistogram(ctx, g, s) {
    const o = s._opts, rows = s._rows, base = o.base != null ? o.base : 0;
    const yBase = g.$2screen(base);
    let bw = 1;
    if (rows.length > 1) bw = Math.max(1, Math.abs(g.t2screen(rows[1][0]) - g.t2screen(rows[0][0])) * 0.7);
    const dft = o.color || '#4d88ff';
    for (const r of rows) { const x = g.t2screen(r[0]), y = g.$2screen(r[1]); ctx.fillStyle = r[2] || dft; ctx.fillRect(Math.floor(x - bw / 2), yBase, Math.max(1, Math.floor(bw)), y - yBase); }
  }
  // candle series in an offchart pane (e.g. a compare instrument): coords from the pane's grid + the author's Candle
  _drawCandleSeries(ctx, g, s) {
    const rows = s._rows, w = (g.px_step || 6) * this._candleWidth();
    for (const r of rows) {
      const x = g.t2screen(r[0]) + 0.5;
      new Candle(s._style, ctx, { x, w, o: g.$2screen(r[1]), h: g.$2screen(r[2]), l: g.$2screen(r[3]), c: g.$2screen(r[4]), raw: r });
    }
  }
  // horizontal price lines on a series' pane (createPriceLine)
  _drawPriceLines(ctx, k) {   // k = grid POSITION
    const g = this._gridAt(k); if (!g) return;
    const id = this._idAt(k);
    for (const s of this._series) {
      if (s._pane !== id || !s._priceLines.length) continue;
      for (const pl of s._priceLines) {
        const o = pl._opts; if (o.lineVisible === false || o.price == null) continue;
        const y = Math.floor(g.$2screen(o.price)) + 0.5;
        ctx.beginPath(); ctx.lineWidth = o.lineWidth || 1; ctx.strokeStyle = o.color || '#888';
        if (o.lineStyle === LineStyle.Dotted) ctx.setLineDash([2, 2]);
        else if (o.lineStyle === LineStyle.Dashed || o.lineStyle === LineStyle.LargeDashed) ctx.setLineDash([6, 4]);
        ctx.moveTo(0, y); ctx.lineTo(g.width, y); ctx.stroke(); ctx.setLineDash([]);
      }
    }
  }
  // ---- primitive host: run each attached primitive's paneViews renderer with a coord-space target ----
  _drawPrimitives(ctx, pane) {
    const g = this._gridAt(pane.k); if (!g) return;
    const target = this._makeTarget(ctx, g.width, g.height);
    const zval = (v) => { const z = v.zOrder && v.zOrder(); return z === 'bottom' ? 0 : z === 'top' ? 2 : z === 'aboveSeries' ? 3 : 1; };
    for (const s of this._series) {
      if (s._pane !== pane.id || !s._primitives.length) continue;
      for (const prim of s._primitives) {
        try {
          if (prim.updateAllViews) prim.updateAllViews();
          const views = (prim.paneViews ? prim.paneViews() : []) || [];
          for (const v of views.slice().sort((a, b) => zval(a) - zval(b))) {
            const r = v.renderer && v.renderer(); if (r && r.draw) r.draw(target);
          }
        } catch (_) { /* a misbehaving primitive must not kill the frame */ }
      }
    }
  }
  _fmt(g, price) { return Number(price).toFixed(g.prec != null ? g.prec : 2); }
  // primitive priceAxisViews + price-line labels -> tags on a pane's sidebar (drawn after sb.update)
  _drawAxisViews(pane) {
    const g = this._gridAt(pane.k); if (!g) return;
    const ctx = pane.sbCv.getContext('2d'); ctx.font = this._comp.$props.font;
    const sb = g.sb, h = Const.ChartConfig.PANHEIGHT;   // match the crosshair price panel height (not a squat 16px)
    const tag = (y, text, fg, bg) => {
      if (y == null || !isFinite(y)) return;
      const ty = Math.round(y);
      ctx.fillStyle = bg || '#363a45'; ctx.fillRect(0, ty - h / 2, sb, h);
      ctx.fillStyle = fg || '#fff'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
      ctx.fillText(text, 6, ty);
    };
    for (const s of this._series) {
      if (s._pane !== pane.id) continue;
      // last-value label (LWC lastValueVisible): the current price tag on the axis (any candle series)
      if (s._isCandle() && s._rows.length && s._opts.lastValueVisible !== false) {
        const last = s._rows[s._rows.length - 1], price = last[4], st = s._style;
        tag(g.$2screen(price), this._fmt(g, price), '#fff', s._opts.priceLineColor || (price >= last[1] ? st.colorCandleUp : st.colorCandleDw));
      }
      for (const pl of s._priceLines) {
        const o = pl._opts; if (o.axisLabelVisible === false || o.price == null) continue;
        tag(g.$2screen(o.price), (o.title ? o.title + ' ' : '') + this._fmt(g, o.price), o.axisLabelTextColor || '#fff', o.axisLabelColor || o.color || '#363a45');
      }
      for (const prim of s._primitives) {
        const views = [].concat(prim.priceAxisViews ? prim.priceAxisViews() : [], prim.priceAxisPaneViews ? prim.priceAxisPaneViews() : []);
        for (const v of views) { if (!v || (v.visible && !v.visible())) continue; tag(v.coordinate ? v.coordinate() : null, v.text ? v.text() : '', v.textColor ? v.textColor() : '#fff', v.backColor ? v.backColor() : '#363a45'); }
      }
    }
  }
  // primitive timeAxisViews -> tags on the shared botbar (drawn after bb.update)
  _drawTimeAxisViews() {
    const g = this._g; if (!g) return;
    const ctx = this._cv.bb.getContext('2d'); ctx.font = this._comp.$props.font;
    const tag = (x, text, fg, bg) => {
      if (x == null || !isFinite(x)) return;
      const w = ctx.measureText(text).width + 10, tx = Math.round(x), h = Const.ChartConfig.PANHEIGHT;
      ctx.fillStyle = bg || '#363a45'; ctx.fillRect(tx - w / 2, 0, w, h);   // match the crosshair time panel height (not a squat 16px)
      ctx.fillStyle = fg || '#fff'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(text, tx, h / 2);
    };
    for (const s of this._series) for (const prim of s._primitives) {
      const views = (prim.timeAxisViews ? prim.timeAxisViews() : []) || [];
      for (const v of views) { if (v.visible && !v.visible()) continue; tag(v.coordinate ? v.coordinate() : null, v.text ? v.text() : '', v.textColor ? v.textColor() : '#fff', v.backColor ? v.backColor() : '#363a45'); }
    }
  }
  // topmost primitive hit at (x, y) in root CSS px -> { externalId, cursorStyle, zOrder } | null
  hitTest(x, y) {
    const L = this._comp.$props.layout; if (!L) return null;
    const grids = L.grids; let k = -1;
    for (let i = 0; i < grids.length; i++) { const gi = grids[i]; if (y >= gi.offset && y < gi.offset + gi.height) { k = i; break; } }
    if (k < 0) return null;
    const ly = y - grids[k].offset; let best = null, bz = -Infinity;
    const id = this._idAt(k);
    for (const s of this._series) {
      if (s._pane !== id) continue;
      for (const prim of s._primitives) {
        if (!prim.hitTest) continue;
        const hit = prim.hitTest(x, ly); if (hit) { const z = hit.zOrder || 0; if (z >= bz) { bz = z; best = hit; } }
      }
    }
    return best;
  }

  // CanvasRenderingTarget2D-like: bitmap space = device px (identity), media space = CSS px (dpr)
  _makeTarget(ctx, mediaW, mediaH) {
    const dpr = this._dpr;
    return {
      useBitmapCoordinateSpace(f) {
        ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0);
        try { f({ context: ctx, mediaSize: { width: mediaW, height: mediaH }, bitmapSize: { width: Math.round(mediaW * dpr), height: Math.round(mediaH * dpr) }, horizontalPixelRatio: dpr, verticalPixelRatio: dpr }); } finally { ctx.restore(); }
      },
      useMediaCoordinateSpace(f) {
        ctx.save(); ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        try { f({ context: ctx, mediaSize: { width: mediaW, height: mediaH } }); } finally { ctx.restore(); }
      },
    };
  }

  _clearCursor() { const c = this._comp.cursor; c.x = undefined; c.y = undefined; c.t = undefined; c.y$ = undefined; }

  _redraw() {
    if (this._layoutDirty) this._rebuild();
    const layout = this._comp.$props.layout;
    if (!layout || !this._panes.length || !this._g) return;
    const grids = layout.grids;

    // active pane = the grid the cursor is over; drive the author's CursorUpdater (magnet-snap)
    const m = this._mouse; let active = -1;
    const gx = m ? m.x - this._chartLeftPx : 0;   // grid-local x (chart is offset by sb when scale is on the left)
    if (m && gx >= 0 && gx < this._chartW) {
      for (let k = 0; k < grids.length; k++) { const gk = grids[k]; if (m.y >= gk.offset && m.y < gk.offset + gk.height) { active = k; break; } }
    }
    if (active >= 0) {
      this._cu.sync({ grid_id: active, x: gx, y: m.y });   // updater subtracts grid.offset itself
      const c = this._comp.cursor;
      for (const pane of this._panes) { pane.cross.visible = true; pane.grid.crosshair = pane.crossLayer; }
      const hit = this.hitTest(gx, m.y);
      this._root.style.cursor = (this._sepHover > 0) ? 'row-resize' : ((hit && hit.cursorStyle) ? hit.cursorStyle : 'crosshair');
      // sourceEvent only on the redraw right after a real pointer move (LWC: distinguishes user vs programmatic)
      const srcEv = this._pointerMoved ? this._lastPointerEvent : undefined; this._pointerMoved = false;
      this._emitCross({ time: c.t != null ? this._i2t(c.t) / 1000 : null, point: { x: c.x, y: c.y }, hoveredObjectId: hit ? hit.externalId : undefined, sourceEvent: srcEv });
    } else if (this._forcedCross && this._forcedCross.time != null) {   // programmatic cross (setCrosshairPosition, cross-pane sync)
      const fc = this._forcedCross, pos = fc.series ? this._posOf(fc.series._pane) : 0, gk = grids[pos];
      const c = this._comp.cursor;
      // cursor.t must be in the layout's x units: a bar INDEX in ib mode (the botbar does i2t(cursor.t)),
      // or time-ms in regular mode. fc.time is seconds from the other pane. grid_id is the POSITION.
      c.grid_id = pos; c.t = this._ib ? this._timeToLogical(fc.time * 1000) : fc.time * 1000;
      c.x = gk ? gk.t2screen(c.t) : undefined;
      c.y$ = fc.price; c.y = (gk && fc.price != null) ? gk.$2screen(fc.price) : undefined;
      for (const pane of this._panes) { pane.cross.visible = true; pane.grid.crosshair = pane.crossLayer; }
      this._emitCross({ time: fc.time, point: { x: c.x, y: c.y } });
    } else {
      this._clearCursor();
      for (const pane of this._panes) pane.grid.crosshair = null;
      this._emitCross(null, this._leaveEvent);   // carry the leave event once so the app clears the synced crosshair
      this._leaveEvent = null;
    }

    // crosshair label toggles: horzLine.labelVisible -> sidebar price tag, vertLine.labelVisible ->
    // botbar time tag. Suppress by clearing the cursor field each author panel checks (line stays).
    const o = this._options, cur = this._comp.cursor, sY$ = cur.y$, sT = cur.t;
    const showPriceLbl = !(o.crosshair && o.crosshair.horzLine && o.crosshair.horzLine.labelVisible === false);
    const showTimeLbl = !(o.crosshair && o.crosshair.vertLine && o.crosshair.vertLine.labelVisible === false);
    if (!showPriceLbl) cur.y$ = undefined;

    // paint: each pane's grid+sidebar (+ primitive/price-line axis views), then the shared botbar.
    // Swap $props.shaders so the price-tag shader (target:'sidebar') runs ONLY on the main sidebar.
    const p = this._comp.$props;
    for (const pane of this._panes) {
      p.shaders = this._gridShaders; pane.grid.update();
      if (this._showPrice) {   // skip the price axis entirely when hidden (its space is already reclaimed)
        p.shaders = (pane.k === 0 && this._lastValueVisible) ? this._sbShaders : this._noShaders; pane.sb.update();
        this._drawAxisViews(pane);
      }
    }
    this._drawSeparators();
    cur.y$ = sY$; if (!showTimeLbl) cur.t = undefined;
    if (this._showTime) { p.shaders = this._gridShaders; this._bb.update(); this._drawTimeAxisViews(); }
    cur.t = sT;
  }

  // Boundary at the top of each sub-pane (k>=1): a PLAIN thin line normally; only when the cursor
  // is near it (the drag-to-resize separator) does a soft transparent highlight appear. Drawn on
  // each sub-pane's gridCv, whose y=0 sits exactly at the boundary (canvas placed at grid.offset).
  _drawSeparators() {
    const grids = this._comp.$props.layout && this._comp.$props.layout.grids;
    if (!grids || grids.length < 2) return;
    const colors = this._comp.$props.colors || {};
    for (const pane of this._panes) {
      if (pane.k < 1 || !pane.gridCv) continue;
      const g = grids[pane.k]; if (!g) continue;
      const ctx = pane.gridCv.getContext('2d');
      ctx.save();
      // plain subtle boundary line, always
      ctx.strokeStyle = colors.scale || '#3a3a44'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(0, 0.5); ctx.lineTo(g.width, 0.5); ctx.stroke();
      // soft transparent highlight only when the cursor is near (grab affordance)
      if (this._sepHover === pane.k) { ctx.fillStyle = 'rgba(128,128,128,0.18)'; ctx.fillRect(0, 0, g.width, 5); }
      ctx.restore();
    }
  }
  // LWC crosshair seriesData: Map(series -> its data point at the hovered time)
  _seriesDataMap(tms) {
    const map = new Map();
    for (const s of this._series) {
      const d = s._rows; if (!d.length) continue;
      let lo = 0, hi = d.length - 1; while (lo < hi) { const m = (lo + hi) >> 1; if (d[m][0] < tms) lo = m + 1; else hi = m; }
      let i = lo; if (i > 0 && Math.abs(d[i - 1][0] - tms) <= Math.abs(d[i][0] - tms)) i = i - 1;
      const r = d[i];
      map.set(s, s._isCandle() ? { time: r[0] / 1000, open: r[1], high: r[2], low: r[3], close: r[4], value: r[4] } : { time: r[0] / 1000, value: r[1] });
    }
    return map;
  }
  // leaveEvent: set on a real mouse-leave so the empty (time:undefined) emit carries a sourceEvent —
  // the app treats sourceEvent===undefined as programmatic and won't clear the synced crosshair otherwise.
  _emitCross(p, leaveEvent) {
    if (!this._cbs.crosshair.size) return;
    let arg;
    if (p) {
      const seriesData = (p.time != null) ? this._seriesDataMap(p.time * 1000) : new Map();
      arg = { time: p.time, point: p.point, seriesData, hoveredObjectId: p.hoveredObjectId, sourceEvent: p.sourceEvent };
    } else {
      arg = { time: undefined, point: undefined, seriesData: new Map(), sourceEvent: leaveEvent || undefined };
    }
    this._cbs.crosshair.forEach((cb) => { try { cb(arg); } catch (_) {} });
  }

  // map LWC options -> the author's color keys (single grid color; scale=axis border; cross/panel/textHL=cursor)
  // canvas font for axis/scale text, from LWC layout.fontSize / layout.fontFamily
  _font() {
    const l = this._options.layout || {};
    return `${l.fontSize || 11}px ${l.fontFamily || '-apple-system, BlinkMacSystemFont, Arial, sans-serif'}`;
  }
  _colors() {
    const o = this._options;
    const hz = o.grid.horzLines || {}, vt = o.grid.vertLines || {};
    const ch = o.crosshair || {}; ch.vertLine = ch.vertLine || {}; ch.horzLine = ch.horzLine || {};
    const gridColor = hz.color || vt.color || '#1a1a20';
    const HIDDEN = 'rgba(0,0,0,0)';   // visible:false -> transparent (the author's grid always strokes)
    return {
      back: (o.layout.background && o.layout.background.color) || '#fff',
      grid: gridColor,
      gridVert: vt.visible === false ? HIDDEN : (vt.color || gridColor),   // per-direction (gridMode none/vert/horz/both)
      gridHorz: hz.visible === false ? HIDDEN : (hz.color || gridColor),
      gridDashVert: dashFor(vt.style || 0), gridDashHorz: dashFor(hz.style || 0),   // line style (solid/dotted/dashed)
      scale: (o.rightPriceScale && o.rightPriceScale.borderColor) || (o.timeScale && o.timeScale.borderColor) || '#333',
      text: o.layout.textColor || '#888',
      // crosshair: the app sets crosshair.vertLine / horzLine (LWC shape), not crosshair.color
      cross: ch.vertLine.color || ch.horzLine.color || ch.color || '#758696',
      crossWidth: ch.vertLine.width || ch.horzLine.width || 1,
      crossDash: dashFor(ch.vertLine.style != null ? ch.vertLine.style : (ch.horzLine.style != null ? ch.horzLine.style : 2)),
      panel: ch.vertLine.labelBackgroundColor || ch.horzLine.labelBackgroundColor || ch.labelBg || '#363a45',
      textHL: ch.labelText || '#e6e6e6',
    };
  }

  _gridAt(pos) { const L = this._comp.$props.layout; return L && L.grids[pos]; }   // by grid POSITION
  // pane ID <-> grid POSITION mapping (identity when no pane is hidden/removed)
  _idAt(pos) { const v = this._paneIds[pos]; return v != null ? v : pos; }
  _posOf(id) { return this._paneIds.indexOf(id); }   // grid position, or -1 if the pane is hidden (no grid)
  _gridOf(id) { return this._gridAt(this._posOf(id)); }   // grid for a pane ID (null when hidden)
  _sbWidth() { return (this._showPrice && this._g) ? this._g.sb : 0; }
  // is root-relative x over the price-axis strip? (left strip when scale is on the left, else right)
  _inSidebarZone(x) { return this._showPrice && (this._scaleSide === 'left' ? x < this._sbPx : x >= this._chartLeftPx + this._chartW); }
  _priceToCoord(id, price) { const g = this._gridOf(id); return g ? Math.floor(price * g.A + g.B) : null; }   // id = pane ID
  _coordToPrice(id, y) { const g = this._gridOf(id); return g ? (y - g.B) / g.A : null; }

  // ---- interaction (native; feeds range/cursor, drives ported calc_zoom/range) ----
  _wire() {
    const root = this._root; let mode = null, lx = 0, ly = 0;   // mode: 'pan' (chart) | 'yzoom' (main price axis)
    root.addEventListener('mousedown', (e) => {
      const r = root.getBoundingClientRect();
      const x = e.clientX - r.left, y = e.clientY - r.top, k = this._paneAt(y);
      lx = e.clientX; ly = e.clientY;
      const sep = this._separatorAt(y);
      if (sep > 0) {   // drag the boundary between stacked panes -> resize (author's grid-resize)
        mode = 'presize'; e.preventDefault();
        const grids = this._comp.$props.layout.grids;
        this._sepDrag = { k: sep, y0: e.clientY, h1: grids[sep - 1].height, h2: grids[sep].height };
      } else if (this._inSidebarZone(x) && k >= 0) {   // sidebar zone of pane k -> Y-zoom that pane
        mode = 'yzoom';
        this._ensureManual(k);   // k = grid POSITION
        const id = this._idAt(k), g = this._gridAt(k), yst = this._yOf(id);   // state by id; grid by position
        this._yDrag = { k: id, y0: e.clientY, z: yst.zoom, height: g ? g.height : this._h, log: this._paneLogOf(id), A: g ? g.A : null, B: g ? g.B : null };
        this._yStartRange = yst.range ? yst.range.slice() : (g ? [g.$_hi, g.$_lo] : null);
      } else { mode = 'pan'; this._panPane = k; }
    });
    window.addEventListener('mouseup', () => { mode = null; });
    root.addEventListener('mousemove', (e) => {
      const r = root.getBoundingClientRect();
      this._mouse = { x: e.clientX - r.left, y: e.clientY - r.top };
      this._lastPointerEvent = e; this._pointerMoved = true;   // crosshair sourceEvent (real vs programmatic)
      if (mode === 'pan' && this._range) {
        const dx = e.clientX - lx, dy = e.clientY - ly; lx = e.clientX; ly = e.clientY;
        if (dx) {   // time pan (shared across all panes)
          const span = this._range[1] - this._range[0];
          const dt = -dx * span / Math.max(1, this._chartW || this._w);
          this._range = [this._range[0] + dt, this._range[1] + dt]; this._emitRange();
        }
        // vertical pan of the pane the drag started in — manual only; log-correct via $2screen/screen2$
        if (dy && this._panPane >= 0) {
          const yst = this._yOf(this._idAt(this._panPane)), g = this._gridAt(this._panPane);   // state by id; grid by position
          if (!yst.auto && yst.range && g) yst.range = [g.screen2$(g.$2screen(yst.range[0]) - dy), g.screen2$(g.$2screen(yst.range[1]) - dy)];
        }
        this._invalidate();
      } else if (mode === 'yzoom') {   // price-axis drag = scale that pane's Y, via trading-vue's calc_zoom/calc_range
        const d = this._yDrag;
        if (d && this._yStartRange) {
          const z = calcZoom(d, e.clientY); this._yOf(d.k).zoom = z;
          this._yOf(d.k).range = calcRange(this._yStartRange, z / d.z, d.log ? { A: d.A, B: d.B, height: d.height } : null);
        }
        this._invalidate();
      } else if (mode === 'presize') {   // dragging a pane boundary -> resize
        this._resizePanes(e.clientY); this._invalidate();
      } else { this._sepHover = this._separatorAt(this._mouse.y); this._schedule(); }
    });
    root.addEventListener('mouseleave', (e) => { this._mouse = null; this._sepHover = -1; this._leaveEvent = e; this._schedule(); });
    root.addEventListener('dblclick', (e) => {
      const r = root.getBoundingClientRect();
      const x = e.clientX - r.left, y = e.clientY - r.top, k = this._paneAt(y);
      if (this._inSidebarZone(x) && k >= 0) { const yst = this._yOf(this._idAt(k)); yst.auto = true; yst.range = null; yst.zoom = 1; this._invalidate(); }   // reset that pane to auto-fit (state by id)
    });
    root.addEventListener('wheel', (e) => {
      if (!this._range) return; e.preventDefault();
      // Author's grid.js mousezoom, transcribed for the engine's index-space range. The original
      // GUARDS on the visible bar count (this.data.length), steps proportional to it, and is
      // RIGHT-anchored by default (only the left edge moves; ctrl zooms under the cursor). That
      // guard is what prevents over-compression, and the right anchor is what kept the price scale
      // from jumping. The previous cursor-centered span zoom had neither. (Can't call mousezoom()
      // directly: in ib mode its interval is real-ms while our range is index units -> mismatch.)
      const n = this._visibleCount(); if (n < 2) return;
      const out = e.deltaY > 0;
      if (out && n > this._maxZoom()) return;     // can't zoom out past maxZoom bars (over-compression)
      if (!out && n <= this._minZoom()) return;   // can't zoom in past minZoom bars (over-zoom limit)
      const step = this._ib ? 1 : this._iv();
      const diff = (out ? 1 : -1) * 50 * (step / 1000) * n;  // his: delta(=±50) * (interval/1000) * N
      const [t0, t1] = this._range;
      if (e.ctrlKey) {                                       // his ctrl branch: zoom under the cursor
        const mx = (e.clientX - root.getBoundingClientRect().left) - this._chartLeftPx;
        const d1 = (mx / Math.max(1, this._chartW || this._w)) * diff;
        this._range = [t0 - d1, t1 + (diff - d1)];
      } else {
        this._range = [t0 - diff, t1];                       // right-anchored (default)
      }
      this._emitRange(); this._invalidate();
    }, { passive: false });
  }
  // Zoom bounds in bars: maxZoom (most bars on screen = max over-compression) and minZoom (fewest
  // bars = widest candles). User-settable via chart options; default to the author's Const.ChartConfig.
  _maxZoom() { const v = this._options.maxZoom; return v > 0 ? v : Const.ChartConfig.MAX_ZOOM; }
  _minZoom() { const v = this._options.minZoom; return v > 0 ? v : Const.ChartConfig.MIN_ZOOM; }
  // candle body width as a fraction of the bar step (CANDLEW); user-settable, default 0.7.
  _candleWidth() { const v = this._options.candleWidth; return v > 0 ? v : Const.ChartConfig.CANDLEW; }
  // Compression bounds: refuse to over-compress past maxZoom bars or over-zoom below minZoom.
  // _range is in INDEX units in ib mode (so span === bar count) and in MS otherwise (count =
  // span / interval). Clamps the span while keeping the anchor's relative position fixed.
  _clampZoom(r, anchor) {
    if (!r) return r;
    const a = r[0], b = r[1], span = b - a;
    if (!(span > 0)) return r;
    const unit = this._ib ? 1 : this._iv();
    const max = this._maxZoom() * unit, min = this._minZoom() * unit;
    let want = span;
    if (span > max) want = max; else if (span < min) want = min; else return r;
    const anc = (anchor != null && anchor >= a && anchor <= b) ? anchor : (a + b) / 2;
    const left = (anc - a) / span;
    return [anc - left * want, anc + (1 - left) * want];
  }
  // The author's this.data.length: how many real bars are currently in view. Drives the zoom
  // guards (MAX_ZOOM / MIN_ZOOM). ib: count indices in range clamped to data; otherwise count
  // rows whose time falls in [range0, range1].
  _visibleCount() {
    const cs = this._cs(); if (!cs || !this._range) return 0;
    const rows = cs._rows, n = rows.length; if (n < 1) return 0;
    if (this._ib) {
      const a = Math.max(0, Math.ceil(this._range[0]));
      const b = Math.min(n - 1, Math.floor(this._range[1]));
      return Math.max(0, b - a + 1);
    }
    const lb = (t) => { let lo = 0, hi = n; while (lo < hi) { const m = (lo + hi) >> 1; if (rows[m][0] < t) lo = m + 1; else hi = m; } return lo; };
    return Math.max(0, lb(this._range[1]) - lb(this._range[0]));
  }
  _emitRange() {
    const ts = this.timeScale();
    const tr = ts.getVisibleRange(); this._cbs.range.forEach((cb) => { try { cb(tr); } catch (_) {} });
    const lr = ts.getVisibleLogicalRange(); this._cbs.logical.forEach((cb) => { try { cb(lr); } catch (_) {} });
  }

  // ---- ENGINE_API.md surface ----
  addSeries(type, opts = {}, paneIndex = 0) { const s = new Series(this, type, opts, paneIndex); this._series.push(s); this._invalidate(); return s; }
  removeSeries(s) { const i = this._series.indexOf(s); if (i >= 0) this._series.splice(i, 1); this._invalidate(); }
  applyOptions(o = {}) {
    this._options = deepMerge(this._options, o);
    const prevSide = this._scaleSide;
    this._readScaleOpts(o);                          // log mode / invert / side / visibility (runtime)
    if (this._scaleSide !== prevSide) this._resetPanes();   // side flip -> rebuild sidebars with the new side
    if (this._root) this._root.style.background = this._colors().back;
    this._invalidate(); return this;
  }
  options() { return { ...this._options, localization: this._options.localization || {} }; }   // LWC IChartApi.options()
  // parse the LWC price/time-scale options the app uses (applyScale): mode(log), invertScale,
  // left-vs-right side, scale/time-axis visibility
  _readScaleOpts(o) {
    const rp = o.rightPriceScale, lp = o.leftPriceScale, t = o.timeScale;
    if (rp && rp.mode != null) this._logScale = (rp.mode === 1);
    else if (lp && lp.mode != null) this._logScale = (lp.mode === 1);
    if ((rp && rp.invertScale != null) || (lp && lp.invertScale != null)) this._invert = !!((rp && rp.invertScale) || (lp && lp.invertScale));
    if (lp || rp) {
      const leftVis = lp && lp.visible === true, rightVis = rp && rp.visible === true;
      if (leftVis && !rightVis) { this._scaleSide = 'left'; this._showPrice = true; }
      else if (rightVis && !leftVis) { this._scaleSide = 'right'; this._showPrice = true; }
      else if ((lp && lp.visible === false) && (rp && rp.visible === false)) this._showPrice = false;
    }
    if (t && t.visible != null) this._showTime = t.visible !== false;
  }
  // invertScale (flip Y): mutate the pane layout in-place. $2screen/screen2$ read A/B live, so flipping
  // A/B + the precomputed candle/tick y-coords keeps everything consistent (the author has no native flag).
  _invertGrid(g) {
    const H = g.height, fy = (y) => H - y;
    if (g.candles) for (const c of g.candles) { c.o = fy(c.o); c.h = fy(c.h); c.l = fy(c.l); c.c = fy(c.c); }
    if (g.ys) for (const tk of g.ys) tk[0] = fy(tk[0]);
    g.A = -g.A; g.B = H - g.B;
  }
  _resetPanes() { for (const p of this._panes) this._destroyPane(p); this._panes = []; }
  chartElement() { return this.el; }
  panes() {
    // Derive panes from the CURRENT series (main 0 + each distinct offchart _pane), not from
    // this._panes, which only updates on rebuild. The app assigns a new study's pane via
    // panes().length, and restores several studies synchronously before any rebuild — using the
    // stale render bundles made them all land in the same pane (stacked). LWC's panes() likewise
    // reflects series immediately.
    // include ALL panes (even hidden ones) so the app's paneIndex assignment (panes().length) and
    // paneIndexOf stay collision-free. A hidden pane has no grid (excluded from _offcharts), so its
    // getHeight() reads 0 -> it occupies no space and doesn't shift the others.
    const ids = new Set([0]);
    for (const s of this._series) if (s._pane > 0) ids.add(s._pane);
    return [...ids].sort((a, b) => a - b).map((k, pos) => ({
      paneIndex: () => k,
      getHeight: () => { const g = this._gridOf(k); return g ? g.height : 0; },
      getStretchFactor: () => this._stretch[k] || 1,
      setStretchFactor: (f) => { this._stretch[k] = Math.max(0.0001, +f || 1); this._invalidate(); },
      moveTo: (idx) => this._movePane(pos, idx),   // pos = this pane's index in panes() (= _movePane's order)
      setPreserveEmptyPane: (on) => { if (on) this._preserve[k] = true; else delete this._preserve[k]; this._invalidate(); },
      preserveEmptyPane: () => !!this._preserve[k],
      priceScale: () => ({ width: () => this._sbWidth(), applyOptions: (o = {}) => { if (o.mode != null) this._setPaneLog(k, o.mode === 1); }, options: () => ({ mode: this._paneLogOf(k) ? 1 : 0 }) }),
      getSeries: () => this._series.filter((s) => s._pane === k),
    }));
  }
  removePane(index) {   // drop every series in that grid; the now-empty grid disappears on rebuild
    this._series = this._series.filter((s) => s._pane !== index);
    delete this._paneLog[index]; delete this._y[index]; delete this._stretch[index];
    this._invalidate();
  }
  // reorder panes: move grid `from` to position `to` (reassigns series._pane + per-pane state)
  _movePane(from, to) {
    // ALL panes (incl. hidden ones) in id order — must match panes()'s position space, since the
    // app passes panes() positions. Using only active offcharts here desynced reorders whenever a
    // pane was hidden.
    const allIds = new Set(); for (const s of this._series) if (s._pane > 0) allIds.add(s._pane);
    const order = [0, ...[...allIds].sort((a, b) => a - b)];
    if (from < 0 || from >= order.length || to < 0 || to >= order.length || from === to) return;
    // The main candle pane is pinned to the top (it is always rendered as grid 0 via the Candles
    // overlay). Moving it, or moving any pane above it, would give the candle _pane>0 -> it would
    // render BOTH as grid 0 and as a duplicate offchart grid. So sub-panes reorder only below it.
    if (from === 0 || to === 0) return;
    const moved = order.splice(from, 1)[0]; order.splice(to, 0, moved);
    const remap = {}; order.forEach((oldP, newIdx) => { remap[oldP] = newIdx; });
    const reKey = (obj) => { const o = {}; for (const k in obj) o[(remap[k] != null ? remap[k] : k)] = obj[k]; return o; };
    for (const s of this._series) if (remap[s._pane] != null) s._pane = remap[s._pane];
    this._paneLog = reKey(this._paneLog); this._y = reKey(this._y); this._stretch = reKey(this._stretch);
    this._invalidate();
  }
  _setPaneLog(k, on) { if (k === 0) this._logScale = !!on; else this._paneLog[k] = !!on; this._invalidate(); }
  _paneLogOf(k) { return k === 0 ? this._logScale : !!this._paneLog[k]; }
  paneIndexOf(s) { return s ? s._pane : 0; }
  addPane() { const idx = this._panes.length; return { paneIndex: () => idx }; }
  priceToCoordinate(p) { return this._priceToCoord(0, p); }
  coordinateToPrice(y) { return this._coordToPrice(0, y); }
  subscribeCrosshairMove(cb) { this._cbs.crosshair.add(cb); }
  unsubscribeCrosshairMove(cb) { this._cbs.crosshair.delete(cb); }
  subscribeClick(cb) { this._cbs.click.add(cb); }
  setCrosshairPosition(price, time, series) { this._forcedCross = { price, time, series }; this._schedule(); }
  clearCrosshairPosition() { this._forcedCross = null; this._schedule(); }
  takeScreenshot() { return this._panes[0] ? this._panes[0].gridCv : null; }
  timeScale() {
    const c = this;
    return {
      // ib: convert time<->index via the candle DATA (_logicalToTime/_timeToLogical), NOT ti_map —
      // works before the first layout exists (the app restores a saved range right after setData).
      getVisibleRange: () => (!c._range ? null : (c._ib ? { from: c._logicalToTime(c._range[0]) / 1000, to: c._logicalToTime(c._range[1]) / 1000 } : { from: c._range[0] / 1000, to: c._range[1] / 1000 })),
      setVisibleRange: (r) => { if (!r) return; c._range = c._ib ? [c._timeToLogical(r.from * 1000), c._timeToLogical(r.to * 1000)] : [r.from * 1000, r.to * 1000]; c._invalidate(); },
      getVisibleLogicalRange: () => (!c._range ? null : (c._ib ? { from: c._range[0], to: c._range[1] } : { from: c._timeToLogical(c._range[0]), to: c._timeToLogical(c._range[1]) })),
      setVisibleLogicalRange: (r) => { if (!r) return; c._range = c._clampZoom(c._ib ? [r.from, r.to] : [c._logicalToTime(r.from), c._logicalToTime(r.to)]); c._emitRange(); c._invalidate(); },
      subscribeVisibleTimeRangeChange: (cb) => c._cbs.range.add(cb),
      subscribeVisibleLogicalRangeChange: (cb) => c._cbs.logical.add(cb),
      timeToCoordinate: (t) => (c._g ? c._g.t2screen(t * 1000) : null),   // t2screen auto-converts (smth2i) in ib
      coordinateToTime: (x) => (c._g ? c._i2t(c._g.screen2t(x)) / 1000 : null),
      // LWC logical = fractional bar index. Drawing engine uses these heavily (cross-timeframe
      // anchors, whitespace, magnet/snap). ib: index IS logical; regular: bar-index <-> time <-> x.
      logicalToCoordinate: (i) => (!c._g ? null : (c._ib ? c._g.t2screen(i) : c._g.t2screen(c._logicalToTime(i)))),
      coordinateToLogical: (x) => { if (!c._g) return null; const t = c._g.screen2t(x); return c._ib ? t : c._timeToLogical(t); },
      fitContent: () => { c._range = null; c._fitToData(); c._invalidate(); },
      scrollToRealTime: () => { c._fitToData(); c._invalidate(); }, scrollToPosition: () => {},
      // height = the time-axis (botbar) strip only. NOT _h - _chartH: _chartH is just the MAIN
      // grid, so with sub-panes that subtraction wrongly includes every sub-pane's height (which
      // made the app treat the whole lower area as "over the time scale" -> no drawing there).
      width: () => c._chartW, height: () => { if (!c._showTime) return 0; const L = c._comp.$props.layout; return (L && L.botbar && L.botbar.height) || 0; },
      // LWC ITimeScaleApi.applyOptions: barSpacing (px/bar -> zoom), rightOffset
      applyOptions: (o = {}) => {
        if (o.rightOffset != null) c._options.timeScale.rightOffset = o.rightOffset;
        if (o.barSpacing != null && o.barSpacing > 0 && c._chartW > 0) {
          const cs = c._cs();
          if (cs && cs._rows.length) {
            const off = c._options.timeScale.rightOffset || 6, wB = c._chartW / o.barSpacing, n = cs._rows.length;
            if (c._ib) { const last = n - 1; c._range = [last + off - wB, last + off]; }
            else { const iv = c._iv(), last = cs._rows[n - 1][0], t1 = last + off * iv; c._range = [t1 - wB * iv, t1]; }
            c._invalidate();
          }
        }
      },
      options: () => ({ ...c._options.timeScale }),
    };
  }
  priceScale(id) {
    const c = this;
    return { width: () => c._sbWidth(), applyOptions: (o = {}) => { if (o.mode != null) c._setPaneLog(0, o.mode === 1); }, options: () => ({ mode: c._logScale ? 1 : 0 }) };
  }
  remove() { try { this._ro.disconnect(); } catch (_) {} try { this.el.removeChild(this._root); } catch (_) {} }
}

export function createChart(el, options) { return new Chart(el, options); }
export default { createChart, CrosshairMode, LineStyle, CandlestickSeries, LineSeries, AreaSeries, BaselineSeries, HistogramSeries };
