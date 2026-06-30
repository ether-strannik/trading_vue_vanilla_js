# trading-vue-vanilla

A **zero-dependency, no-build** canvas charting engine. You feed it data; it owns the
viewport — scrolling, scaling, reactivity — and maps that data to the screen for you.
~4,700 lines of plain ES modules; the browser runs the same files that sit in the repo.

**Live demo:** https://ether-strannik.github.io/trading_vue_vanilla_js/examples/

## Where it comes from

This is the canvas rendering core of **[trading-vue-js](https://github.com/tvjsx/trading-vue-js)**
(by C451) — its `grid_maker` / `grid` / `layout` / `yscale` logic and drawing
primitives — lifted out of the Vue shell and shipped as a standalone engine. No Vue,
no framework, no runtime dependencies.

The original project has not been maintained since **April 2021**. This is part of why
it was worth extracting the engine on its own terms: the rendering core is solid and
self-contained, and freeing it from the abandoned Vue shell keeps it usable.

## Core philosophy: Data -> Screen Mapping

The engine is not a fixed catalog of chart types you fill in. It is an **environment
that maps your data to screen coordinates**. It owns the viewport — scrolling, scaling,
reactivity — and hands you the transforms:

```js
layout.t2screen(t)   // time  -> x
layout.$2screen($)   // price -> y
layout.screen2t(x)   // x     -> time
layout.screen2$(y)   // y     -> price
layout.t_magnet(t)   // time  -> nearest candle's x
```

With these plus the standard canvas API you can draw anything in data coordinates. The
crucial part: the engine's **own** candles, lines and indicators are themselves just
consumers of these same transforms — they have no special status over what you draw.
Bring any data, and you render it the way the engine renders price.

(These transforms are intact in this standalone extraction — the primitives in `core/`
call `t2screen` / `$2screen` directly — so the mapping environment is fully preserved.)

## The data model

Internally a chart is **one declarative object** — price plus every indicator and which
pane it lives in (this is also the shape the original library accepts as input). A data
point is a **positional array** `[timestamp, ...values]` (timestamp in milliseconds),
and the engine works in **bar-index space** (time is a lookup for axis labels, not the
primary key), so missing bars collapse instead of leaving whitespace.

```js
{
  chart:    { type: 'Candles', data: [[1551128400000, 33, 37.1, 14, 14, 196], ...] },
  onchart:  [{ name: 'EMA', type: 'EMA', data: [[1551128400000, 3091], ...] }],
  offchart: [{ name: 'RSI', type: 'RSI', data: [[1551128400000, 61.2], ...] }]
}
```

You don't have to assemble this tree by hand: this extraction ships convenience
functions (see [Quick start](#quick-start)) that build it for you.

## How this differs from TradingView's Lightweight Charts

Both draw candles to a canvas, but they map data in fundamentally different ways.

**Lightweight Charts — time-keyed, object-per-point, one series per plot.**
You imperatively create a series object for each plot and feed it objects keyed by
`time`. The x-axis is a **time scale** that reasons about the calendar — sessions,
gaps, whitespace — because *time* is the primary key.

```js
const s = chart.addCandlestickSeries();
s.setData([{ time: 1551128400, open: 33, high: 37.1, low: 14, close: 14 }, ...]);
```

**This engine** inverts every one of those choices (see [The data model](#the-data-model)
above): one declarative tree of positional arrays, addressed by **bar index** — so gaps
collapse on their own and there is no whitespace concept.

|                  | Lightweight Charts        | this engine                       |
| ---------------- | ------------------------- | --------------------------------- |
| Unit of data     | a series object per plot  | one declarative chart tree        |
| A point is       | an object `{time, value}` | a positional array `[t, ...vals]` |
| X-axis key       | **time** (calendar scale) | **bar index** (time is looked up) |
| Missing bars     | gaps / whitespace         | collapsed automatically           |
| Indicators       | each is its own series API | just more `data` arrays           |
| What you render   | a fixed set of series types | anything expressible as data, via the transforms |

The deepest difference follows from the philosophy above: Lightweight Charts is a
**closed catalog of series types you feed**; this is an **open mapping environment** in
which the built-in plots have no special status over what you draw. Neither is
"correct" — LWC's calendar time scale is the better fit when you need real session gaps
— but conceptually this engine treats a chart as what it is: an ordered sequence of
bars addressed by position, drawn through data->screen transforms.

## Quick start

> Note: the public function names below (`createChart`, `addSeries`, `setData`) are
> arbitrary — just the current names of the public surface. They can be renamed to
> anything; they are not tied to any other library.

```js
import { createChart, CandlestickSeries, LineSeries } from './index.js';

const chart = createChart(document.getElementById('chart'), { width: 800, height: 400 });

const candles = chart.addSeries(CandlestickSeries);
candles.setData([
  { time: 1718000000, open: 100, high: 105, low: 98, close: 103 },
  // ...
]);

const ma = chart.addSeries(LineSeries, { color: '#2962ff' }, 1);  // paneIndex 1 = sub-pane
ma.setData([{ time: 1718000000, value: 101 }, ...]);
```

These functions are a thin layer over [the data model](#the-data-model): each point you
pass becomes a positional `[t, ...]` row, and timestamps (seconds here) are scaled to
the engine's millisecond rows. So the convenience API and the declarative model are the
same chart, described two ways.

## License

GPL-3.0-or-later. Derived from trading-vue-js (C451), MIT — original notice retained
for the ported render core.
