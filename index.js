// trading-vue-vanilla — public entry point.
//
// A zero-dependency, framework-free canvas charting engine: the render core of
// trading-vue-js (grid_maker / grid / layout / yscale + primitives) extracted from
// its Vue shell and driven by a small Lightweight-Charts-compatible API.
//
// Import from THIS file (not engine.js directly):
//
//   import { createChart, CandlestickSeries } from 'trading-vue-vanilla';
//   // or, no build step / no bundler, straight from a CDN or local copy:
//   import { createChart, CandlestickSeries }
//     from 'https://your-host/trading-vue-vanilla/index.js';
//
//   const chart = createChart(document.getElementById('chart'), { width: 800, height: 400 });
//   const series = chart.addSeries(CandlestickSeries);
//   series.setData([{ time: 1718000000, open: 1, high: 2, low: 0.5, close: 1.5 }, /* ... */]);
//
// See README.md for the full supported API surface.
export {
  createChart,
  CrosshairMode,
  LineStyle,
  CandlestickSeries,
  LineSeries,
  AreaSeries,
  BaselineSeries,
  HistogramSeries,
} from './engine.js';

export { default } from './engine.js';
