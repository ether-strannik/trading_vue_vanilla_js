// A tiny self-contained "datafeed" for the demo.
//
// It synthesizes a deterministic OHLCV series in the SAME shape the app preloads
// into the engine — one bar is:
//
//   { time, open, high, low, close, volume }      // time = UNIX seconds
//
// In a real app you would replace generateBars() with a fetch() of your own
// history endpoint (or a broker adapter) that yields objects of that shape, e.g.
//
//   const bars = await fetch('/api/history?symbol=EP&tf=1h').then((r) => r.json());
//   candleSeries.setData(bars);
//
// The series is deterministic (seeded) so the demo looks identical on every load.

function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const r2 = (x) => Math.round(x * 100) / 100;

export function generateBars({
  count = 300,
  startTime = 1700000000,   // fixed epoch -> reproducible
  step = 3600,              // hourly bars
  startPrice = 100,
  seed = 42,
} = {}) {
  const rnd = mulberry32(seed);
  const bars = [];
  let price = startPrice;
  for (let i = 0; i < count; i++) {
    const open = price;
    const drift = (rnd() - 0.48) * 2.2;                 // gentle upward-biased random walk
    const close = Math.max(1, open + drift);
    const high = Math.max(open, close) + rnd() * 1.3;
    const low = Math.max(0.5, Math.min(open, close) - rnd() * 1.3);
    const volume = Math.round(500 + rnd() * 1800);
    bars.push({ time: startTime + i * step, open: r2(open), high: r2(high), low: r2(low), close: r2(close), volume });
    price = close;
  }
  return bars;
}

// Standard Wilder RSI computed straight off the bars; returns line-series points
// ({ time, value }) starting once there is a full `period` of history.
export function computeRSI(bars, period = 14) {
  const out = [];
  let avgGain = 0, avgLoss = 0;
  for (let i = 1; i < bars.length; i++) {
    const ch = bars[i].close - bars[i - 1].close;
    const gain = Math.max(ch, 0), loss = Math.max(-ch, 0);
    if (i <= period) {
      avgGain += gain; avgLoss += loss;
      if (i === period) {
        avgGain /= period; avgLoss /= period;
        const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
        out.push({ time: bars[i].time, value: r2(100 - 100 / (1 + rs)) });
      }
    } else {
      avgGain = (avgGain * (period - 1) + gain) / period;
      avgLoss = (avgLoss * (period - 1) + loss) / period;
      const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
      out.push({ time: bars[i].time, value: r2(100 - 100 / (1 + rs)) });
    }
  }
  return out;
}
