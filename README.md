# trading-vue-vanilla

A **zero-dependency, framework-free** canvas charting engine.

It is the render core of [trading-vue-js](https://github.com/tvjsx/trading-vue-js)
(its `grid_maker` / `grid` / `layout` / `yscale` logic and canvas primitives) lifted
out of the Vue shell and wrapped in a small **[Lightweight-Charts]-compatible API**.
If you know the Lightweight-Charts v5 API, you already know this.

- No Vue. No React. No npm runtime dependencies. **No build step.**
- ~4,700 lines of plain ES modules — drop the folder in and `import`.
- Candlesticks, lines, areas, baselines, histograms; stacked indicator panes;
  log/linear price scales; gap-collapsed (index-based) time axis; crosshair, drag
  pan, wheel zoom, draggable pane separators.

**Live demo:** https://ether-strannik.github.io/trading_vue_vanilla_js/examples/

[Lightweight-Charts]: https://github.com/tradingview/lightweight-charts

## Install

It is pure ES-module source, so there is nothing to compile.

**Copy the folder** into your project and import from `index.js`:

```html
<script type="module">
  import { createChart, CandlestickSeries } from './trading-vue-vanilla/index.js';
  // ...
</script>
```

**Or via a bundler / npm** (from git):

```bash
npm install github:ether-strannik/trading_vue_vanilla_js
```

```js
import { createChart, CandlestickSeries } from 'trading-vue-vanilla';
```

## Quick start

```js
import { createChart, CandlestickSeries, LineSeries } from './index.js';

const chart = createChart(document.getElementById('chart'), {
  width: 800,
  height: 400,
});

const candles = chart.addSeries(CandlestickSeries);
candles.setData([
  { time: 1718000000, open: 100, high: 105, low: 98,  close: 103 },
  { time: 1718000060, open: 103, high: 107, low: 102, close: 106 },
  // ...
]);

// a line in its own stacked pane below the price (paneIndex = 1)
const ma = chart.addSeries(LineSeries, { color: '#2962ff' }, 1);
ma.setData([{ time: 1718000000, value: 101 }, { time: 1718000060, value: 104 }]);
```

The container element should have a size (or pass `width`/`height`); the chart
installs a `ResizeObserver` and follows the element afterwards.

## Runnable example

`examples/index.html` is a complete, dependency-free demo: candlesticks plus a
14-period **RSI in its own stacked sub-pane**, with colors driven by an editable
`examples/settings.json` and bars produced by `examples/feed.js` (a stand-in
datafeed in the engine's preload shape). It is what the live demo above serves.

To run it locally — ES modules and `fetch` need `http://`, not `file://`:

```bash
python3 -m http.server 8080
# then open http://localhost:8080/examples/
```

- `feed.js` — `generateBars()` (deterministic OHLCV in `{ time, open, high, low,
  close, volume }`) and a Wilder `computeRSI()`. Swap `generateBars` for your own
  `fetch()` to feed real data.
- `settings.json` — background / grid / crosshair colors and candle up/down colors;
  edit and reload to recolor.

## API

Mirrors the Lightweight-Charts v5 shape. The supported surface:

### `createChart(element, options)` -> chart

| chart method | notes |
|---|---|
| `addSeries(SeriesType, options?, paneIndex?)` | `paneIndex` 0 = main; >0 = stacked sub-pane |
| `removeSeries(series)` | |
| `applyOptions(options)` | layout/grid/crosshair/time-scale options |
| `options()` | current options |
| `timeScale()` | `setVisibleRange`, `getVisibleRange`, `applyOptions({barSpacing,rightOffset})`, `scrollToPosition`, `fitContent`, `height`, coordinate<->logical helpers |
| `priceScale(id?)` | `applyOptions({mode, autoScale})` — `mode` 0 linear, 1 log |
| `panes()` | array of pane handles: `getHeight`, `moveTo`, `priceScale`, `setPreserveEmptyPane`, ... |
| `subscribeCrosshairMove(cb)` / `unsubscribeCrosshairMove(cb)` | |
| `subscribeClick(cb)` | |
| `resize(w?, h?)` | usually automatic via ResizeObserver |
| `remove()` | tear down + detach from the DOM |

### series

| series method | notes |
|---|---|
| `setData(bars)` | replace all data |
| `update(bar)` | append/replace the last bar (live updates) |
| `applyOptions(options)` | color, line width/style, price line, last-value label, ... |
| `createPriceLine(options)` | horizontal price line (e.g. Bid/Ask) |
| `priceScale()` | the series' pane price scale |

### Series types

`CandlestickSeries`, `LineSeries`, `AreaSeries`, `BaselineSeries`, `HistogramSeries`.

### Bar shapes

- Candlestick: `{ time, open, high, low, close }`
- Line / Area / Baseline / Histogram: `{ time, value }`

`time` is a UNIX timestamp (seconds). The axis is **index-based** (gaps between
bars are collapsed, like Lightweight-Charts), not a continuous clock.

### Enums

- `CrosshairMode`: `Normal | Magnet | Hidden`
- `LineStyle`: `Solid | Dotted | Dashed | LargeDashed | SparseDotted`

## What this is NOT

This is the **engine**, not a batteries-included product. It deliberately does not
ship:

- Indicator / overlay library (RSI, MACD, ...), `DataCube`, or the script engine —
  bring your own studies and feed them in as extra series/panes.
- A data feed — you supply bars from any source.

If you want a finished, broker-connected charting app built on top of this engine,
see the [plain_charts](https://github.com/ether-strannik/plain_charts) project.

## License

GPL-3.0-or-later. See `LICENSE`.

Derived from **trading-vue-js**, Copyright (c) C451, released under the MIT License —
that original copyright notice is retained for the portions of the render core
(`core/`) ported from it.
