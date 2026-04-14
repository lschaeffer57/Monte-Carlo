"use client";

import { useState, useMemo, useCallback, useRef } from "react";
import {
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  ReferenceLine,
  Area,
  ComposedChart,
  Line,
  BarChart,
  Bar,
  Cell,
  Brush,
} from "recharts";

// ─── PRNG ────────────────────────────────────────────────────
function mulberry32(seed: number) {
  return function () {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ─── TYPES ───────────────────────────────────────────────────
const MAX_DRAWN_LINES = 20;

interface SimResult {
  betNumber: number;
  ev: number;
  p5: number;
  p25: number;
  median: number;
  p75: number;
  p95: number;
  bandOuter: [number, number];
  bandInner: [number, number];
  pctProfitable: number;
  [key: string]: number | [number, number];
}

interface HistoBin {
  range: string;
  center: number;
  count: number;
  pct: number;
}

// ─── SIMULATION ENGINE ──────────────────────────────────────
function percentile(sorted: number[], p: number): number {
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

function runSimulations(
  numSims: number,
  numBets: number,
  avgOdds: number,
  ev: number,
  ruinThreshold: number
) {
  const winProb = (1 + ev / 100) / avgOdds;
  const clampedProb = Math.max(0.001, Math.min(0.999, winProb));

  const step = Math.max(1, Math.floor(numBets / 200));
  const samplePoints: number[] = [];
  for (let b = 0; b <= numBets; b += step) samplePoints.push(b);
  if (samplePoints[samplePoints.length - 1] !== numBets) samplePoints.push(numBets);
  const numPoints = samplePoints.length;

  const linesToDraw = Math.min(numSims, MAX_DRAWN_LINES);
  const bankrollsAtPoint: number[][] = samplePoints.map(() => []);
  const profitableAtPoint: number[] = new Array(numPoints).fill(0);
  const drawnLines: number[][] = Array.from({ length: linesToDraw }, () =>
    new Array(numPoints).fill(0)
  );
  const finalPnls: number[] = [];

  let profitable = 0;
  let totalFinal = 0;
  let worstDrawdown = 0;
  let ruinCount = 0;

  for (let s = 0; s < numSims; s++) {
    const rng = mulberry32(s * 31337 + 42);
    let bankroll = 0;
    let peak = 0;
    let sampleIdx = 0;
    let ruined = false;

    bankrollsAtPoint[0].push(0);
    if (s < linesToDraw) drawnLines[s][0] = 0;
    sampleIdx = 1;

    for (let b = 1; b <= numBets; b++) {
      if (rng() < clampedProb) {
        bankroll += avgOdds - 1;
      } else {
        bankroll -= 1;
      }

      if (bankroll > peak) peak = bankroll;
      const dd = peak - bankroll;
      if (dd > worstDrawdown) worstDrawdown = dd;
      if (!ruined && bankroll <= -ruinThreshold) {
        ruined = true;
        ruinCount++;
      }

      if (sampleIdx < numPoints && b === samplePoints[sampleIdx]) {
        bankrollsAtPoint[sampleIdx].push(bankroll);
        if (bankroll > 0) profitableAtPoint[sampleIdx]++;
        if (s < linesToDraw) {
          drawnLines[s][sampleIdx] = parseFloat(bankroll.toFixed(2));
        }
        sampleIdx++;
      }
    }

    finalPnls.push(bankroll);
    if (bankroll > 0) profitable++;
    totalFinal += bankroll;
  }

  // Convergence point: first sample where >= 90% of sims are profitable
  let convergenceBet: number | null = null;
  for (let i = 1; i < numPoints; i++) {
    if (profitableAtPoint[i] / numSims >= 0.9) {
      convergenceBet = samplePoints[i];
      break;
    }
  }

  // Build chart data
  const evPerBet = ev / 100;
  const data: SimResult[] = samplePoints.map((betNum, i) => {
    const values = bankrollsAtPoint[i].slice().sort((a, b) => a - b);
    const p5v = parseFloat(percentile(values, 5).toFixed(2));
    const p25v = parseFloat(percentile(values, 25).toFixed(2));
    const med = parseFloat(percentile(values, 50).toFixed(2));
    const p75v = parseFloat(percentile(values, 75).toFixed(2));
    const p95v = parseFloat(percentile(values, 95).toFixed(2));

    const point: SimResult = {
      betNumber: betNum,
      ev: parseFloat((betNum * evPerBet).toFixed(2)),
      p5: p5v,
      p25: p25v,
      median: med,
      p75: p75v,
      p95: p95v,
      bandOuter: [p5v, p95v],
      bandInner: [p25v, p75v],
      pctProfitable: i === 0 ? 0 : parseFloat(((profitableAtPoint[i] / numSims) * 100).toFixed(1)),
    };

    for (let s = 0; s < linesToDraw; s++) {
      point[`sim${s}`] = drawnLines[s][i];
    }
    return point;
  });

  // Histogram of final PnLs
  const sortedFinals = finalPnls.slice().sort((a, b) => a - b);
  const hMin = sortedFinals[0];
  const hMax = sortedFinals[sortedFinals.length - 1];
  const binCount = Math.min(30, Math.max(10, Math.ceil(Math.sqrt(numSims))));
  const binWidth = (hMax - hMin) / binCount || 1;
  const bins: HistoBin[] = [];
  for (let i = 0; i < binCount; i++) {
    const lo = hMin + i * binWidth;
    const hi = lo + binWidth;
    const center = (lo + hi) / 2;
    const count = finalPnls.filter((v) => v >= lo && (i === binCount - 1 ? v <= hi : v < hi)).length;
    bins.push({
      range: `${lo.toFixed(0)} → ${hi.toFixed(0)}`,
      center: parseFloat(center.toFixed(1)),
      count,
      pct: parseFloat(((count / numSims) * 100).toFixed(1)),
    });
  }

  // Color each drawn line by final PnL (red → green gradient)
  const lineColors: string[] = [];
  for (let s = 0; s < linesToDraw; s++) {
    const final_ = drawnLines[s][numPoints - 1];
    const allFinals = drawnLines.map((l) => l[numPoints - 1]);
    const minF = Math.min(...allFinals);
    const maxF = Math.max(...allFinals);
    const range = maxF - minF || 1;
    const t = (final_ - minF) / range; // 0 = worst, 1 = best
    lineColors.push(interpolateColor(t));
  }

  return {
    data,
    linesToDraw,
    lineColors,
    histogram: bins,
    convergenceBet,
    stats: {
      profitable: (profitable / numSims) * 100,
      maxDrawdown: parseFloat(worstDrawdown.toFixed(2)),
      avgFinal: parseFloat((totalFinal / numSims).toFixed(2)),
      ruinPct: parseFloat(((ruinCount / numSims) * 100).toFixed(1)),
      medianFinal: parseFloat(percentile(sortedFinals, 50).toFixed(2)),
      stdDev: parseFloat(stddev(finalPnls).toFixed(2)),
    },
  };
}

function stddev(arr: number[]): number {
  const mean = arr.reduce((s, v) => s + v, 0) / arr.length;
  return Math.sqrt(arr.reduce((s, v) => s + (v - mean) ** 2, 0) / arr.length);
}

function interpolateColor(t: number): string {
  // 0 = red (#ef4444), 0.5 = yellow (#eab308), 1 = green (#22c55e)
  const r = t < 0.5 ? 239 : Math.round(239 - (239 - 34) * ((t - 0.5) * 2));
  const g = t < 0.5 ? Math.round(68 + (179 - 68) * (t * 2)) : Math.round(179 + (197 - 179) * ((t - 0.5) * 2));
  const b = t < 0.5 ? Math.round(68 + (8 - 68) * (t * 2)) : Math.round(8 + (94 - 8) * ((t - 0.5) * 2));
  return `rgb(${r},${g},${b})`;
}

// ─── SLIDER STEPS ────────────────────────────────────────────
const SIM_STEPS = [
  1, 2, 3, 5, 10, 20, 50, 100, 200, 500,
  1000, 2000, 5000, 10000, 20000, 50000,
];

// ─── COMPONENTS ──────────────────────────────────────────────
function Slider({
  label,
  value,
  onChange,
  min,
  max,
  step,
  unit,
  formatValue,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  min: number;
  max: number;
  step: number;
  unit?: string;
  formatValue?: (v: number) => string;
}) {
  const display = formatValue ? formatValue(value) : `${value}`;
  return (
    <div className="flex flex-col gap-1">
      <div className="flex justify-between text-sm">
        <span className="text-zinc-400">{label}</span>
        <span className="font-mono font-bold text-blue-400">
          {display}
          {unit || ""}
        </span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        className="w-full"
      />
    </div>
  );
}

function StatCard({
  label,
  value,
  sub,
  color,
}: {
  label: string;
  value: string;
  sub: string;
  color?: string;
}) {
  return (
    <div className="bg-zinc-900/80 backdrop-blur rounded-lg p-3 border border-zinc-800 transition-all duration-300 hover:border-zinc-600 hover:bg-zinc-800/80">
      <div className="text-xs text-zinc-500">{label}</div>
      <div className={`text-xl font-bold font-mono ${color || "text-white"} transition-colors duration-300`}>
        {value}
      </div>
      <div className="text-xs text-zinc-600">{sub}</div>
    </div>
  );
}

function formatNum(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(n % 1000 === 0 ? 0 : 1)}k`;
  return `${n}`;
}

// ─── CUSTOM TOOLTIP ─────────────────────────────────────────
function CustomTooltip({ active, payload, label }: { active?: boolean; payload?: Array<{ dataKey: string; value: number | [number, number]; color: string; name: string }>; label?: number }) {
  if (!active || !payload || !label) return null;

  const evLine = payload.find((p) => p.dataKey === "ev");
  const medianLine = payload.find((p) => p.dataKey === "median");
  const outer = payload.find((p) => p.dataKey === "bandOuter");
  const inner = payload.find((p) => p.dataKey === "bandInner");
  const pctProf = payload.find((p) => p.dataKey === "pctProfitable");

  return (
    <div className="bg-zinc-900/95 backdrop-blur border border-zinc-700 rounded-lg p-3 shadow-xl text-xs max-w-[240px]">
      <div className="font-bold text-zinc-200 mb-2 border-b border-zinc-700 pb-1">
        Pari #{label}
      </div>
      {evLine && (
        <div className="flex justify-between gap-4">
          <span className="text-zinc-400">EV theorique</span>
          <span className="font-mono text-white font-bold">{(evLine.value as number).toFixed(2)}u</span>
        </div>
      )}
      {medianLine && (
        <div className="flex justify-between gap-4">
          <span className="text-zinc-400">Mediane</span>
          <span className="font-mono text-blue-400">{(medianLine.value as number).toFixed(2)}u</span>
        </div>
      )}
      {outer && Array.isArray(outer.value) && (
        <div className="flex justify-between gap-4">
          <span className="text-zinc-400">P5 → P95</span>
          <span className="font-mono text-zinc-300">{outer.value[0]} → {outer.value[1]}</span>
        </div>
      )}
      {inner && Array.isArray(inner.value) && (
        <div className="flex justify-between gap-4">
          <span className="text-zinc-400">P25 → P75</span>
          <span className="font-mono text-zinc-300">{inner.value[0]} → {inner.value[1]}</span>
        </div>
      )}
      {pctProf && (
        <div className="flex justify-between gap-4 mt-1 pt-1 border-t border-zinc-700">
          <span className="text-zinc-400">En profit</span>
          <span className={`font-mono font-bold ${(pctProf.value as number) >= 50 ? "text-green-400" : "text-red-400"}`}>
            {(pctProf.value as number).toFixed(1)}%
          </span>
        </div>
      )}
    </div>
  );
}

// ─── MAIN PAGE ──────────────────────────────────────────────
export default function Home() {
  const [simSlider, setSimSlider] = useState(4);
  const [ev, setEv] = useState(3);
  const [numBets, setNumBets] = useState(500);
  const [avgOdds, setAvgOdds] = useState(2.0);
  const [ruinThreshold, setRuinThreshold] = useState(50);

  const numSims = SIM_STEPS[simSlider];
  const showBands = numSims > MAX_DRAWN_LINES;

  const { data, linesToDraw, lineColors, histogram, convergenceBet, stats } = useMemo(
    () => runSimulations(numSims, numBets, avgOdds, ev, ruinThreshold),
    [numSims, numBets, avgOdds, ev, ruinThreshold]
  );

  const winProb = ((1 + ev / 100) / avgOdds * 100).toFixed(1);

  return (
    <div className="flex flex-col min-h-screen p-4 md:p-8 gap-6 max-w-[1400px] mx-auto w-full">
      {/* Header */}
      <header className="text-center">
        <h1 className="text-2xl md:text-4xl font-bold bg-gradient-to-r from-blue-400 via-purple-400 to-pink-400 bg-clip-text text-transparent">
          Simulateur Monte Carlo
        </h1>
        <p className="text-zinc-500 mt-1 text-sm">
          Variance &amp; Loi des grands nombres dans les paris sportifs
        </p>
      </header>

      {/* Controls */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-4 bg-zinc-900/80 backdrop-blur rounded-xl p-4 border border-zinc-800">
        <Slider
          label="Simulations"
          value={simSlider}
          onChange={(v) => setSimSlider(Math.round(v))}
          min={0}
          max={SIM_STEPS.length - 1}
          step={1}
          formatValue={() => formatNum(numSims)}
        />
        <Slider
          label="Expected Value (EV)"
          value={ev}
          onChange={setEv}
          min={-10}
          max={20}
          step={0.5}
          unit="%"
        />
        <Slider
          label="Nombre de paris"
          value={numBets}
          onChange={setNumBets}
          min={50}
          max={10000}
          step={50}
        />
        <Slider
          label="Cote moyenne"
          value={avgOdds}
          onChange={setAvgOdds}
          min={1.2}
          max={5.0}
          step={0.1}
        />
        <Slider
          label="Seuil de ruine"
          value={ruinThreshold}
          onChange={setRuinThreshold}
          min={10}
          max={200}
          step={5}
          unit="u"
        />
      </div>

      {/* Stats row */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
        <StatCard
          label="Prob. de gain / pari"
          value={`${winProb}%`}
          sub={`cote ${avgOdds.toFixed(1)}`}
        />
        <StatCard
          label="Sims rentables"
          value={`${stats.profitable.toFixed(1)}%`}
          sub={`sur ${formatNum(numSims)}`}
          color={stats.profitable >= 50 ? "text-green-400" : "text-red-400"}
        />
        <StatCard
          label="Profit moyen"
          value={`${stats.avgFinal > 0 ? "+" : ""}${stats.avgFinal}u`}
          sub={`median: ${stats.medianFinal > 0 ? "+" : ""}${stats.medianFinal}u`}
          color={stats.avgFinal >= 0 ? "text-green-400" : "text-red-400"}
        />
        <StatCard
          label="Ecart-type"
          value={`${stats.stdDev}u`}
          sub="volatilite finale"
          color="text-purple-400"
        />
        <StatCard
          label="Prob. de ruine"
          value={`${stats.ruinPct}%`}
          sub={`seuil: -${ruinThreshold}u`}
          color={stats.ruinPct <= 5 ? "text-green-400" : stats.ruinPct <= 20 ? "text-yellow-400" : "text-red-400"}
        />
        <StatCard
          label="Pire drawdown"
          value={`${stats.maxDrawdown}u`}
          sub="sur toutes les simus"
          color="text-orange-400"
        />
      </div>

      {/* Convergence banner */}
      {convergenceBet !== null && (
        <div className="bg-green-950/40 border border-green-800 rounded-lg px-4 py-2 text-sm text-green-300 text-center transition-all duration-500">
          Convergence : 90% des simulations sont rentables a partir du pari <strong>#{convergenceBet}</strong>
        </div>
      )}
      {convergenceBet === null && ev > 0 && numBets >= 200 && (
        <div className="bg-yellow-950/40 border border-yellow-800 rounded-lg px-4 py-2 text-sm text-yellow-300 text-center">
          Pas encore de convergence a 90% — augmentez le nombre de paris pour voir la loi des grands nombres s&apos;appliquer
        </div>
      )}

      {/* Main chart + Histogram side by side */}
      <div className="grid grid-cols-1 lg:grid-cols-[1fr_300px] gap-4">
        {/* Main trajectory chart */}
        <div className="bg-zinc-900/80 backdrop-blur rounded-xl p-4 border border-zinc-800 min-h-[450px]">
          <div className="flex items-center justify-between mb-2">
            <h2 className="text-sm font-semibold text-zinc-300">Trajectoires de bankroll</h2>
            {showBands && (
              <span className="text-xs text-zinc-500">
                {formatNum(numSims)} simus / {linesToDraw} tracees
              </span>
            )}
          </div>
          <ResponsiveContainer width="100%" height={420}>
            <ComposedChart data={data}>
              <defs>
                <linearGradient id="bandOuterGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#3b82f6" stopOpacity={0.15} />
                  <stop offset="100%" stopColor="#3b82f6" stopOpacity={0.03} />
                </linearGradient>
                <linearGradient id="bandInnerGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#3b82f6" stopOpacity={0.3} />
                  <stop offset="100%" stopColor="#3b82f6" stopOpacity={0.08} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="#1f1f23" />
              <XAxis
                dataKey="betNumber"
                stroke="#52525b"
                fontSize={11}
                tickFormatter={(v) => formatNum(v)}
              />
              <YAxis
                stroke="#52525b"
                fontSize={11}
                tickFormatter={(v) => `${v > 0 ? "+" : ""}${formatNum(v)}`}
              />
              <Tooltip content={<CustomTooltip />} />
              <ReferenceLine y={0} stroke="#3f3f46" strokeWidth={1.5} />

              {/* Convergence marker */}
              {convergenceBet !== null && (
                <ReferenceLine
                  x={convergenceBet}
                  stroke="#22c55e"
                  strokeWidth={2}
                  strokeDasharray="6 3"
                  label={{
                    value: "90% rentable",
                    position: "top",
                    fill: "#22c55e",
                    fontSize: 10,
                  }}
                />
              )}

              {/* Hidden line for tooltip data */}
              <Line type="monotone" dataKey="pctProfitable" stroke="none" dot={false} name="% En profit" />

              {/* Percentile bands */}
              {showBands && (
                <Area
                  type="monotone"
                  dataKey="bandOuter"
                  fill="url(#bandOuterGrad)"
                  stroke="none"
                  name="P5-P95"
                  animationDuration={800}
                />
              )}
              {showBands && (
                <Area
                  type="monotone"
                  dataKey="bandInner"
                  fill="url(#bandInnerGrad)"
                  stroke="none"
                  name="P25-P75"
                  animationDuration={800}
                />
              )}

              {/* Median */}
              {showBands && (
                <Line
                  type="monotone"
                  dataKey="median"
                  stroke="#60a5fa"
                  strokeWidth={2}
                  dot={false}
                  name="Mediane"
                  animationDuration={600}
                />
              )}

              {/* EV line */}
              <Line
                type="monotone"
                dataKey="ev"
                stroke="#ffffff"
                strokeWidth={2.5}
                strokeDasharray="8 4"
                dot={false}
                name="EV theorique"
                animationDuration={600}
              />

              {/* Simulation lines with gradient colors */}
              {Array.from({ length: linesToDraw }, (_, i) => (
                <Line
                  key={i}
                  type="monotone"
                  dataKey={`sim${i}`}
                  stroke={lineColors[i]}
                  strokeWidth={showBands ? 1 : 1.5}
                  dot={false}
                  name={`Sim ${i + 1}`}
                  opacity={showBands ? 0.35 : 0.75}
                  animationDuration={400 + i * 50}
                />
              ))}

              {/* Zoom brush */}
              <Brush
                dataKey="betNumber"
                height={25}
                stroke="#3f3f46"
                fill="#18181b"
                tickFormatter={(v) => formatNum(v)}
              />
            </ComposedChart>
          </ResponsiveContainer>
        </div>

        {/* Histogram */}
        <div className="bg-zinc-900/80 backdrop-blur rounded-xl p-4 border border-zinc-800">
          <h2 className="text-sm font-semibold text-zinc-300 mb-2">Distribution du P&amp;L final</h2>
          <ResponsiveContainer width="100%" height={420}>
            <BarChart data={histogram} layout="vertical" margin={{ left: 10, right: 10 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#1f1f23" horizontal={false} />
              <XAxis type="number" stroke="#52525b" fontSize={10} tickFormatter={(v) => `${v}%`} />
              <YAxis
                type="category"
                dataKey="center"
                stroke="#52525b"
                fontSize={9}
                width={45}
                tickFormatter={(v) => `${v > 0 ? "+" : ""}${v}`}
              />
              <Tooltip
                contentStyle={{
                  backgroundColor: "#18181b",
                  border: "1px solid #3f3f46",
                  borderRadius: "8px",
                  fontSize: "11px",
                }}
                formatter={((value: number) => [`${value}%`, "Frequence"]) as never}
                labelFormatter={(v) => `~${v}u`}
              />
              <ReferenceLine y={0} stroke="#52525b" strokeWidth={1} />
              <Bar dataKey="pct" radius={[0, 3, 3, 0]} animationDuration={600}>
                {histogram.map((bin, i) => (
                  <Cell
                    key={i}
                    fill={bin.center >= 0 ? "#22c55e" : "#ef4444"}
                    fillOpacity={0.7 + (bin.pct / 100) * 0.3}
                  />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* Legend */}
      <div className="flex flex-wrap gap-4 justify-center text-xs text-zinc-500">
        <span className="flex items-center gap-1.5">
          <span className="w-5 h-0.5 bg-white" style={{ backgroundImage: "repeating-linear-gradient(90deg, white 0, white 5px, transparent 5px, transparent 8px)" }} />
          EV theorique
        </span>
        {showBands && (
          <>
            <span className="flex items-center gap-1.5">
              <span className="w-3.5 h-3.5 rounded bg-blue-500/10 border border-blue-500/30" />
              P5-P95
            </span>
            <span className="flex items-center gap-1.5">
              <span className="w-3.5 h-3.5 rounded bg-blue-500/25 border border-blue-500/40" />
              P25-P75
            </span>
            <span className="flex items-center gap-1.5">
              <span className="w-5 h-0.5 bg-blue-400" />
              Mediane
            </span>
          </>
        )}
        <span className="flex items-center gap-1.5">
          <span className="w-5 h-2 rounded" style={{ background: "linear-gradient(90deg, #ef4444, #eab308, #22c55e)" }} />
          Trajectoires (rouge=pire, vert=meilleure)
        </span>
        {convergenceBet !== null && (
          <span className="flex items-center gap-1.5">
            <span className="w-5 h-0.5 bg-green-500" style={{ backgroundImage: "repeating-linear-gradient(90deg, #22c55e 0, #22c55e 4px, transparent 4px, transparent 6px)" }} />
            Convergence 90%
          </span>
        )}
      </div>

      {/* Explanation */}
      <div className="bg-zinc-900/80 backdrop-blur rounded-xl p-4 border border-zinc-800 text-sm text-zinc-400 space-y-2">
        <p>
          <strong className="text-zinc-200">Degrade de couleurs :</strong> Les trajectoires vont du
          rouge (pire resultat) au vert (meilleur). Cela permet de voir immediatement la dispersion
          des resultats possibles.
        </p>
        <p>
          <strong className="text-zinc-200">Zone de convergence :</strong> La ligne verte verticale
          marque le moment ou 90% des simulations sont en profit. Avant ce point, la variance domine.
          Apres, la loi des grands nombres prend le dessus.
        </p>
        <p>
          <strong className="text-zinc-200">Probabilite de ruine :</strong> Pourcentage de simulations
          qui touchent le seuil de ruine (-{ruinThreshold}u). Meme avec un EV positif, le risque de ruine
          reste reel si la bankroll est trop faible par rapport a la variance.
        </p>
        <p>
          <strong className="text-zinc-200">Histogramme :</strong> La distribution des profits finaux.
          Plus la cloche est resserree autour de l&apos;EV, plus la variance est maitrisee.
          Utilisez le zoom (barre sous le graphe) pour explorer une zone specifique.
        </p>
      </div>
    </div>
  );
}
