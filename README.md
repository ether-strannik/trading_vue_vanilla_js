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
and the engine addresses bars by **position** — the array index — with time looked up
only for axis labels, never as the bar's identity.

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
You imperatively create a series object for each plot and feed it objects whose key is
`time`: a bar's identity *is* its timestamp (unique, ascending). The time scale knows
each bar's time — for axis labels, the crosshair, and business-day handling.

```js
const s = chart.addCandlestickSeries();
s.setData([{ time: 1551128400, open: 33, high: 37.1, low: 14, close: 14 }, ...]);
```

**This engine** inverts those choices (see [The data model](#the-data-model) above): one
declarative tree of positional arrays, where a bar's identity is its **position** (the
array index), not its time.

|                  | Lightweight Charts        | this engine                       |
| ---------------- | ------------------------- | --------------------------------- |
| Unit of data     | a series object per plot  | one declarative chart tree        |
| A point is       | an object `{time, value}` | a positional array `[t, ...vals]` |
| A bar's identity | its **timestamp**         | its **position** (array index)    |
| Indicators       | each is its own series API | just more `data` arrays           |
| What you render   | a fixed set of series types | anything expressible as data, via the transforms |

Both, by the way, space bars **evenly by position** and stay tidy — neither leaves
proportional gaps for missing time by default. The difference isn't how the chart
*looks*; it's the model underneath. The deepest part follows from the philosophy above:
Lightweight Charts is a **closed catalog of series types you feed**; this is an **open
mapping environment** in which the built-in plots have no special status over what you
draw. Neither is "correct" — LWC's time-keyed identity gives it built-in business-day
handling and a mature ecosystem; this engine's positional model makes a chart a plain
ordered sequence addressed by index, drawn through data->screen transforms.

## Declared, not drawn

This is the difference that matters, and most people never see it — for many a chart is
just lines on a screen. But there are dozens of price-rendering engines, and only a few
stand out, because of *what they are*. Most are **canvases you plot dots on**: you
compute positions and issue draw commands. A few are **environments you feed datasets
to**. This is one of the latter, and it's the whole reason the engine was worth
preserving.

Both kinds end in pixels on a canvas. So the difference is not *drawing vs not-drawing* —
it's **who holds the model, and how the picture comes to exist**:

- **Imperative (Lightweight Charts): you are the draftsman.** You create a series, mutate
  it, push points, issue commands. The chart is the running total of your operations.
- **Declarative (this engine): you state what is.** You hand over one value — the data
  tree — and the engine **reconciles the screen to match it**. You describe the end
  state; the system makes reality agree. It is **React, but for a chart**: you declare
  what exists, and the environment brings it into being.

### The components are deliberately dumb

A plot here knows exactly one thing. RSI does not know geometry — it cannot measure the
distance from A to B, or reason about the chart. It knows only: *given my value at this
index, here is my shape.* The candle is the same: *given OHLC at this index, here is my
body and wicks.* Each plot is a pure function of **its own datum**, nothing more.

And nothing on the chart computes *meaning*. `RSI = 56.6` is not calculated by the
renderer — it arrives as data (the indicator math lives upstream, outside this engine).
The render system never asks "what is RSI"; it asks only "where does 56.6 go." No
semantic calculation happens at the plot — only data -> screen mapping.

### The environment is already there

What pre-exists isn't the candle — it's the **environment**: the coordinate space, the
scales, the viewport, the `t2screen` / `$2screen` transforms. The empty market space,
standing ready. Data doesn't *draw into* it; data **populates** it, and the dumb
primitives read the mapping and resolve themselves into pixels.

So feeding the engine isn't plotting a candle. It's closer to:

> "Hey, candle at `1551128400000` — you'll be here, and you'll be this big."
> The candle says "okay," and materializes.

The candle was already there in a dormant state, as funny as that sounds; the data
inhales life into it. The market environment doesn't need to be drawn — it exists in its
primordial form, and you feed it the dataset that brings each object to life.

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
