"use client";

import { useState, useMemo } from "react";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  ReferenceLine,
  Area,
  ComposedChart,
} from "recharts";

// Seed-based pseudo-random for reproducible simulations
function mulberry32(seed: number) {
  return function () {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

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
  [key: string]: number | [number, number];
}

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
  ev: number
) {
  const winProb = (1 + ev / 100) / avgOdds;
  const clampedProb = Math.max(0.001, Math.min(0.999, winProb));

  // Sample points for x-axis (max 200 for performance)
  const step = Math.max(1, Math.floor(numBets / 200));
  const samplePoints: number[] = [];
  for (let b = 0; b <= numBets; b += step) samplePoints.push(b);
  if (samplePoints[samplePoints.length - 1] !== numBets) samplePoints.push(numBets);

  const numPoints = samplePoints.length;

  // How many lines to actually draw on the chart
  const linesToDraw = Math.min(numSims, MAX_DRAWN_LINES);

  // Store bankroll at each sample point for ALL sims (for percentiles)
  // bankrollsAtPoint[pointIdx] = array of bankroll values across all sims
  const bankrollsAtPoint: number[][] = samplePoints.map(() => []);

  // Store drawn line data separately
  const drawnLines: number[][] = Array.from({ length: linesToDraw }, () =>
    new Array(numPoints).fill(0)
  );

  let profitable = 0;
  let totalFinal = 0;
  let worstDrawdown = 0;

  for (let s = 0; s < numSims; s++) {
    const rng = mulberry32(s * 31337 + 42);
    let bankroll = 0;
    let peak = 0;
    let sampleIdx = 0;

    // Starting point
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

      if (sampleIdx < numPoints && b === samplePoints[sampleIdx]) {
        bankrollsAtPoint[sampleIdx].push(bankroll);
        if (s < linesToDraw) {
          drawnLines[s][sampleIdx] = parseFloat(bankroll.toFixed(2));
        }
        sampleIdx++;
      }
    }

    if (bankroll > 0) profitable++;
    totalFinal += bankroll;
  }

  // Build chart data with percentile bands
  const evPerBet = ev / 100;
  const data: SimResult[] = samplePoints.map((betNum, i) => {
    const values = bankrollsAtPoint[i].slice().sort((a, b) => a - b);
    const p5 = parseFloat(percentile(values, 5).toFixed(2));
    const p25 = parseFloat(percentile(values, 25).toFixed(2));
    const med = parseFloat(percentile(values, 50).toFixed(2));
    const p75 = parseFloat(percentile(values, 75).toFixed(2));
    const p95 = parseFloat(percentile(values, 95).toFixed(2));

    const point: SimResult = {
      betNumber: betNum,
      ev: parseFloat((betNum * evPerBet).toFixed(2)),
      p5,
      p25,
      median: med,
      p75,
      p95,
      bandOuter: [p5, p95],
      bandInner: [p25, p75],
    };

    for (let s = 0; s < linesToDraw; s++) {
      point[`sim${s}`] = drawnLines[s][i];
    }

    return point;
  });

  return {
    data,
    linesToDraw,
    stats: {
      profitable: (profitable / numSims) * 100,
      maxDrawdown: parseFloat(worstDrawdown.toFixed(2)),
      avgFinal: parseFloat((totalFinal / numSims).toFixed(2)),
    },
  };
}

const COLORS = [
  "#ef4444", "#f97316", "#eab308", "#22c55e", "#06b6d4",
  "#3b82f6", "#8b5cf6", "#ec4899", "#f43f5e", "#14b8a6",
  "#a855f7", "#6366f1", "#d946ef", "#f59e0b", "#10b981",
  "#0ea5e9", "#e11d48", "#84cc16", "#7c3aed", "#fb923c",
];

// Logarithmic slider steps for simulations
const SIM_STEPS = [
  1, 2, 3, 5, 10, 20, 50, 100, 200, 500,
  1000, 2000, 5000, 10000, 20000, 50000,
];

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

function formatNum(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(n % 1000 === 0 ? 0 : 1)}k`;
  return `${n}`;
}

export default function Home() {
  const [simSlider, setSimSlider] = useState(4); // index into SIM_STEPS → 10
  const [ev, setEv] = useState(3);
  const [numBets, setNumBets] = useState(500);
  const [avgOdds, setAvgOdds] = useState(2.0);

  const numSims = SIM_STEPS[simSlider];
  const showBands = numSims > MAX_DRAWN_LINES;

  const { data, linesToDraw, stats } = useMemo(
    () => runSimulations(numSims, numBets, avgOdds, ev),
    [numSims, numBets, avgOdds, ev]
  );

  const winProb = ((1 + ev / 100) / avgOdds * 100).toFixed(1);

  return (
    <div className="flex flex-col min-h-screen p-4 md:p-8 gap-6 max-w-7xl mx-auto w-full">
      <header className="text-center">
        <h1 className="text-2xl md:text-3xl font-bold">
          Simulateur de Variance - Paris Sportifs
        </h1>
        <p className="text-zinc-500 mt-1 text-sm">
          Loi des grands nombres vs Variance : quand l&apos;EV s&apos;impose
        </p>
      </header>

      {/* Controls */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 bg-zinc-900 rounded-xl p-4 border border-zinc-800">
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
      </div>

      {/* Info banner when bands are shown */}
      {showBands && (
        <div className="bg-blue-950/50 border border-blue-800 rounded-lg px-4 py-2 text-sm text-blue-300 text-center">
          {formatNum(numSims)} simulations calculees — {linesToDraw} trajectoires affichees + bandes P5-P95 / P25-P75
        </div>
      )}

      {/* Stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatCard
          label="Probabilite de gain"
          value={`${winProb}%`}
          sub="par pari"
        />
        <StatCard
          label="Simulations rentables"
          value={`${stats.profitable.toFixed(1)}%`}
          sub={`sur ${formatNum(numSims)} simus`}
          color={stats.profitable >= 50 ? "text-green-400" : "text-red-400"}
        />
        <StatCard
          label="Profit moyen final"
          value={`${stats.avgFinal > 0 ? "+" : ""}${stats.avgFinal}u`}
          sub={`apres ${formatNum(numBets)} paris`}
          color={stats.avgFinal >= 0 ? "text-green-400" : "text-red-400"}
        />
        <StatCard
          label="Pire drawdown"
          value={`${stats.maxDrawdown}u`}
          sub="sur toutes les simus"
          color="text-orange-400"
        />
      </div>

      {/* Chart */}
      <div className="flex-1 bg-zinc-900 rounded-xl p-4 border border-zinc-800 min-h-[400px]">
        <ResponsiveContainer width="100%" height={450}>
          <ComposedChart data={data}>
            <CartesianGrid strokeDasharray="3 3" stroke="#27272a" />
            <XAxis
              dataKey="betNumber"
              stroke="#71717a"
              fontSize={12}
              label={{
                value: "Nombre de paris",
                position: "insideBottom",
                offset: -5,
                fill: "#71717a",
              }}
            />
            <YAxis
              stroke="#71717a"
              fontSize={12}
              label={{
                value: "Profit (unites)",
                angle: -90,
                position: "insideLeft",
                fill: "#71717a",
              }}
            />
            <Tooltip
              contentStyle={{
                backgroundColor: "#18181b",
                border: "1px solid #3f3f46",
                borderRadius: "8px",
                fontSize: "12px",
              }}
              labelFormatter={(v) => `Pari #${v}`}
              formatter={((value: number | [number, number], name: string) => {
                if (Array.isArray(value)) return [`${value[0]} → ${value[1]}`, name];
                return [typeof value === "number" ? value.toFixed(2) : value, name];
              }) as never}
            />
            <ReferenceLine y={0} stroke="#52525b" strokeWidth={2} />

            {/* Percentile bands (only when many sims) */}
            {showBands && (
              <Area
                type="monotone"
                dataKey="bandOuter"
                fill="#3b82f6"
                fillOpacity={0.08}
                stroke="none"
                name="P5-P95"
              />
            )}
            {showBands && (
              <Area
                type="monotone"
                dataKey="bandInner"
                fill="#3b82f6"
                fillOpacity={0.15}
                stroke="none"
                name="P25-P75"
              />
            )}

            {/* Median line when bands are shown */}
            {showBands && (
              <Line
                type="monotone"
                dataKey="median"
                stroke="#60a5fa"
                strokeWidth={2}
                dot={false}
                name="Mediane"
              />
            )}

            {/* EV line */}
            <Line
              type="monotone"
              dataKey="ev"
              stroke="#ffffff"
              strokeWidth={3}
              strokeDasharray="8 4"
              dot={false}
              name="EV theorique"
            />

            {/* Individual simulation lines */}
            {Array.from({ length: linesToDraw }, (_, i) => (
              <Line
                key={i}
                type="monotone"
                dataKey={`sim${i}`}
                stroke={COLORS[i % COLORS.length]}
                strokeWidth={showBands ? 1 : 1.5}
                dot={false}
                name={`Sim ${i + 1}`}
                opacity={showBands ? 0.4 : 0.7}
              />
            ))}
          </ComposedChart>
        </ResponsiveContainer>
      </div>

      {/* Legend for bands */}
      {showBands && (
        <div className="flex flex-wrap gap-4 justify-center text-xs text-zinc-500">
          <span className="flex items-center gap-1">
            <span className="w-3 h-3 rounded bg-blue-500/10 border border-blue-500/30" />
            Bande P5-P95 (90% des trajectoires)
          </span>
          <span className="flex items-center gap-1">
            <span className="w-3 h-3 rounded bg-blue-500/25 border border-blue-500/40" />
            Bande P25-P75 (50% des trajectoires)
          </span>
          <span className="flex items-center gap-1">
            <span className="w-4 h-0.5 bg-blue-400" />
            Mediane
          </span>
          <span className="flex items-center gap-1">
            <span className="w-4 h-0.5 bg-white border-dashed border-t-2 border-white" />
            EV theorique
          </span>
        </div>
      )}

      {/* Explanation */}
      <div className="bg-zinc-900 rounded-xl p-4 border border-zinc-800 text-sm text-zinc-400 space-y-2">
        <p>
          <strong className="text-zinc-200">Comment lire ce graphe :</strong> Chaque
          ligne coloree represente une simulation independante de votre parcours de
          parieur. La ligne blanche pointillee represente l&apos;esperance de gain
          theorique (EV).
        </p>
        <p>
          <strong className="text-zinc-200">Loi des grands nombres :</strong> Plus le
          nombre de paris augmente, plus les trajectoires individuelles convergent vers
          la ligne d&apos;EV. Avec un EV positif, la variance finit toujours par etre
          effacee sur le long terme.
        </p>
        <p>
          <strong className="text-zinc-200">Bandes de percentiles :</strong> A partir de 50+
          simulations, des bandes colorees montrent ou se situent 90% (P5-P95) et 50%
          (P25-P75) des trajectoires. Plus les bandes sont etroites, plus la convergence
          est forte.
        </p>
      </div>
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
    <div className="bg-zinc-900 rounded-lg p-3 border border-zinc-800">
      <div className="text-xs text-zinc-500">{label}</div>
      <div className={`text-xl font-bold font-mono ${color || "text-white"}`}>
        {value}
      </div>
      <div className="text-xs text-zinc-600">{sub}</div>
    </div>
  );
}
