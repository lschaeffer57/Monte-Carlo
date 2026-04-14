"use client";

import { useState, useMemo } from "react";
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

type StakingMode = "flat" | "percent" | "kelly" | "kelly_fraction";

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

interface StakingConfig {
  mode: StakingMode;
  flatSize: number;       // flat: units per bet
  percentSize: number;    // percent: % of bankroll per bet
  kellyFraction: number;  // kelly_fraction: fraction of kelly (e.g. 0.25 = quarter kelly)
  startingBankroll: number;
}

// ─── SIMULATION ENGINE ──────────────────────────────────────
function percentile(sorted: number[], p: number): number {
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

function getStake(
  bankroll: number,
  config: StakingConfig,
  avgOdds: number,
  winProb: number
): number {
  switch (config.mode) {
    case "flat":
      return config.flatSize;
    case "percent":
      return Math.max(0.01, bankroll * (config.percentSize / 100));
    case "kelly": {
      // Kelly formula: f* = (bp - q) / b where b = odds-1, p = win prob, q = 1-p
      const b = avgOdds - 1;
      const f = (b * winProb - (1 - winProb)) / b;
      return Math.max(0.01, bankroll * Math.max(0, f));
    }
    case "kelly_fraction": {
      const b2 = avgOdds - 1;
      const f2 = (b2 * winProb - (1 - winProb)) / b2;
      return Math.max(0.01, bankroll * Math.max(0, f2) * config.kellyFraction);
    }
    default:
      return config.flatSize;
  }
}

function runSimulations(
  numSims: number,
  numBets: number,
  avgOdds: number,
  ev: number,
  ruinThreshold: number,
  staking: StakingConfig
) {
  const winProb = (1 + ev / 100) / avgOdds;
  const clampedProb = Math.max(0.001, Math.min(0.999, winProb));
  const isFlat = staking.mode === "flat";
  const startBR = staking.startingBankroll;

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
  let bustCount = 0; // bankroll reaches 0

  for (let s = 0; s < numSims; s++) {
    const rng = mulberry32(s * 31337 + 42);
    let bankroll = isFlat ? 0 : startBR;
    const startVal = bankroll;
    let peak = bankroll;
    let sampleIdx = 0;
    let ruined = false;
    let busted = false;

    bankrollsAtPoint[0].push(bankroll);
    if (s < linesToDraw) drawnLines[s][0] = bankroll;
    sampleIdx = 1;

    for (let b = 1; b <= numBets; b++) {
      // Calculate stake based on strategy
      const stake = isFlat
        ? staking.flatSize
        : getStake(bankroll, staking, avgOdds, clampedProb);

      // If bankroll can't cover the bet, skip (busted)
      if (!isFlat && bankroll < 0.01) {
        if (!busted) { busted = true; bustCount++; }
        // Record same bankroll
        if (sampleIdx < numPoints && b === samplePoints[sampleIdx]) {
          bankrollsAtPoint[sampleIdx].push(bankroll);
          if (bankroll > startVal) profitableAtPoint[sampleIdx]++;
          if (s < linesToDraw) drawnLines[s][sampleIdx] = parseFloat(bankroll.toFixed(2));
          sampleIdx++;
        }
        continue;
      }

      if (rng() < clampedProb) {
        bankroll += stake * (avgOdds - 1);
      } else {
        bankroll -= stake;
      }

      if (bankroll > peak) peak = bankroll;
      const dd = peak - bankroll;
      if (dd > worstDrawdown) worstDrawdown = dd;

      const ruinLevel = isFlat ? -ruinThreshold : startBR - ruinThreshold;
      if (!ruined && bankroll <= ruinLevel) {
        ruined = true;
        ruinCount++;
      }

      if (sampleIdx < numPoints && b === samplePoints[sampleIdx]) {
        bankrollsAtPoint[sampleIdx].push(bankroll);
        if (isFlat ? bankroll > 0 : bankroll > startVal) profitableAtPoint[sampleIdx]++;
        if (s < linesToDraw) {
          drawnLines[s][sampleIdx] = parseFloat(bankroll.toFixed(2));
        }
        sampleIdx++;
      }
    }

    const pnl = isFlat ? bankroll : bankroll - startBR;
    finalPnls.push(pnl);
    if (pnl > 0) profitable++;
    totalFinal += pnl;
  }

  // Convergence
  let convergenceBet: number | null = null;
  for (let i = 1; i < numPoints; i++) {
    if (profitableAtPoint[i] / numSims >= 0.9) {
      convergenceBet = samplePoints[i];
      break;
    }
  }

  // Build chart data — for non-flat modes, show bankroll directly
  const evPerBet = isFlat ? ev / 100 : (ev / 100) * staking.flatSize; // approximate EV line
  const data: SimResult[] = samplePoints.map((betNum, i) => {
    const values = bankrollsAtPoint[i].slice().sort((a, b) => a - b);
    const p5v = parseFloat(percentile(values, 5).toFixed(2));
    const p25v = parseFloat(percentile(values, 25).toFixed(2));
    const med = parseFloat(percentile(values, 50).toFixed(2));
    const p75v = parseFloat(percentile(values, 75).toFixed(2));
    const p95v = parseFloat(percentile(values, 95).toFixed(2));

    const evVal = isFlat
      ? parseFloat((betNum * (ev / 100)).toFixed(2))
      : parseFloat((startBR * Math.pow(1 + (ev / 100) * getTheoreticalStakeFraction(staking, avgOdds, clampedProb), betNum)).toFixed(2));

    const point: SimResult = {
      betNumber: betNum,
      ev: evVal,
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

  // Histogram
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

  // Line colors
  const lineColors: string[] = [];
  for (let s = 0; s < linesToDraw; s++) {
    const final_ = drawnLines[s][numPoints - 1];
    const allFinals = drawnLines.map((l) => l[numPoints - 1]);
    const minF = Math.min(...allFinals);
    const maxF = Math.max(...allFinals);
    const range = maxF - minF || 1;
    const t = (final_ - minF) / range;
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
      bustPct: parseFloat(((bustCount / numSims) * 100).toFixed(1)),
      medianFinal: parseFloat(percentile(sortedFinals, 50).toFixed(2)),
      stdDev: parseFloat(stddev(finalPnls).toFixed(2)),
    },
  };
}

// Theoretical stake fraction for EV line approximation in non-flat modes
function getTheoreticalStakeFraction(staking: StakingConfig, avgOdds: number, winProb: number): number {
  switch (staking.mode) {
    case "percent":
      return staking.percentSize / 100;
    case "kelly": {
      const b = avgOdds - 1;
      return Math.max(0, (b * winProb - (1 - winProb)) / b);
    }
    case "kelly_fraction": {
      const b = avgOdds - 1;
      return Math.max(0, ((b * winProb - (1 - winProb)) / b) * staking.kellyFraction);
    }
    default:
      return 0;
  }
}

function stddev(arr: number[]): number {
  const mean = arr.reduce((s, v) => s + v, 0) / arr.length;
  return Math.sqrt(arr.reduce((s, v) => s + (v - mean) ** 2, 0) / arr.length);
}

function interpolateColor(t: number): string {
  const r = t < 0.5 ? 239 : Math.round(239 - (239 - 34) * ((t - 0.5) * 2));
  const g = t < 0.5 ? Math.round(68 + (179 - 68) * (t * 2)) : Math.round(179 + (197 - 179) * ((t - 0.5) * 2));
  const b = t < 0.5 ? Math.round(68 + (8 - 68) * (t * 2)) : Math.round(8 + (94 - 8) * ((t - 0.5) * 2));
  return `rgb(${r},${g},${b})`;
}

// ─── CONSTANTS ───────────────────────────────────────────────
const SIM_STEPS = [
  1, 2, 3, 5, 10, 20, 50, 100, 200, 500,
  1000, 2000, 5000, 10000, 20000, 50000,
];

const STAKING_MODES: { value: StakingMode; label: string; desc: string }[] = [
  { value: "flat", label: "Flat", desc: "Mise fixe (unites)" },
  { value: "percent", label: "% Bankroll", desc: "% de la bankroll actuelle" },
  { value: "kelly", label: "Kelly", desc: "Critere de Kelly complet" },
  { value: "kelly_fraction", label: "Fraction Kelly", desc: "Fraction du Kelly" },
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
  if (Math.abs(n) >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
  if (Math.abs(n) >= 1000) return `${(n / 1000).toFixed(n % 1000 === 0 ? 0 : 1)}k`;
  return `${n}`;
}

function formatUnit(n: number, isFlat: boolean): string {
  if (isFlat) return `${n}u`;
  return `${n.toFixed(0)}$`;
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
          <span className="font-mono text-white font-bold">{Number(evLine.value).toFixed(2)}</span>
        </div>
      )}
      {medianLine && (
        <div className="flex justify-between gap-4">
          <span className="text-zinc-400">Mediane</span>
          <span className="font-mono text-blue-400">{Number(medianLine.value).toFixed(2)}</span>
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

  // Staking
  const [stakingMode, setStakingMode] = useState<StakingMode>("flat");
  const [flatSize, setFlatSize] = useState(1);
  const [percentSize, setPercentSize] = useState(2);
  const [kellyFraction, setKellyFraction] = useState(0.25);
  const [startingBankroll, setStartingBankroll] = useState(1000);

  const numSims = SIM_STEPS[simSlider];
  const showBands = numSims > MAX_DRAWN_LINES;
  const isFlat = stakingMode === "flat";

  const staking: StakingConfig = {
    mode: stakingMode,
    flatSize,
    percentSize,
    kellyFraction,
    startingBankroll,
  };

  const { data, linesToDraw, lineColors, histogram, convergenceBet, stats } = useMemo(
    () => runSimulations(numSims, numBets, avgOdds, ev, ruinThreshold, staking),
    [numSims, numBets, avgOdds, ev, ruinThreshold, stakingMode, flatSize, percentSize, kellyFraction, startingBankroll]
  );

  const winProb = ((1 + ev / 100) / avgOdds * 100).toFixed(1);

  // Kelly info
  const kellyPct = useMemo(() => {
    const b = avgOdds - 1;
    const p = Math.max(0.001, Math.min(0.999, (1 + ev / 100) / avgOdds));
    const f = (b * p - (1 - p)) / b;
    return Math.max(0, f * 100);
  }, [avgOdds, ev]);

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

      {/* Controls — row 1: main params */}
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
          max={500}
          step={5}
          unit={isFlat ? "u" : "$"}
        />
      </div>

      {/* Controls — row 2: staking strategy */}
      <div className="bg-zinc-900/80 backdrop-blur rounded-xl p-4 border border-zinc-800">
        <div className="flex items-center gap-2 mb-3">
          <h2 className="text-sm font-semibold text-zinc-300">Strategie de mise</h2>
          <span className="text-xs text-zinc-600">—</span>
          <span className="text-xs text-zinc-500">
            {STAKING_MODES.find((m) => m.value === stakingMode)?.desc}
          </span>
        </div>

        {/* Mode selector */}
        <div className="flex flex-wrap gap-2 mb-4">
          {STAKING_MODES.map((mode) => (
            <button
              key={mode.value}
              onClick={() => setStakingMode(mode.value)}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all duration-200 border ${
                stakingMode === mode.value
                  ? "bg-blue-600 border-blue-500 text-white shadow-lg shadow-blue-500/20"
                  : "bg-zinc-800 border-zinc-700 text-zinc-400 hover:border-zinc-500 hover:text-zinc-200"
              }`}
            >
              {mode.label}
            </button>
          ))}
        </div>

        {/* Mode-specific controls */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {stakingMode === "flat" && (
            <Slider
              label="Mise fixe"
              value={flatSize}
              onChange={setFlatSize}
              min={0.5}
              max={10}
              step={0.5}
              unit="u"
            />
          )}

          {stakingMode === "percent" && (
            <>
              <Slider
                label="Bankroll initiale"
                value={startingBankroll}
                onChange={setStartingBankroll}
                min={100}
                max={10000}
                step={100}
                unit="$"
              />
              <Slider
                label="Mise par pari"
                value={percentSize}
                onChange={setPercentSize}
                min={0.5}
                max={20}
                step={0.5}
                unit="%"
              />
            </>
          )}

          {stakingMode === "kelly" && (
            <>
              <Slider
                label="Bankroll initiale"
                value={startingBankroll}
                onChange={setStartingBankroll}
                min={100}
                max={10000}
                step={100}
                unit="$"
              />
              <div className="flex flex-col gap-1 justify-center">
                <span className="text-xs text-zinc-500">Kelly optimal</span>
                <span className="font-mono text-lg font-bold text-yellow-400">{kellyPct.toFixed(2)}%</span>
                <span className="text-xs text-zinc-600">de la bankroll par pari</span>
              </div>
            </>
          )}

          {stakingMode === "kelly_fraction" && (
            <>
              <Slider
                label="Bankroll initiale"
                value={startingBankroll}
                onChange={setStartingBankroll}
                min={100}
                max={10000}
                step={100}
                unit="$"
              />
              <Slider
                label="Fraction du Kelly"
                value={kellyFraction}
                onChange={setKellyFraction}
                min={0.05}
                max={1}
                step={0.05}
                formatValue={(v) => `${(v * 100).toFixed(0)}%`}
              />
              <div className="flex flex-col gap-1 justify-center">
                <span className="text-xs text-zinc-500">Mise effective</span>
                <span className="font-mono text-lg font-bold text-cyan-400">
                  {(kellyPct * kellyFraction).toFixed(2)}%
                </span>
                <span className="text-xs text-zinc-600">
                  ({kellyFraction * 100}% x {kellyPct.toFixed(2)}% Kelly)
                </span>
              </div>
            </>
          )}
        </div>

        {/* Kelly warning */}
        {stakingMode === "kelly" && (
          <div className="mt-3 bg-yellow-950/40 border border-yellow-800/50 rounded-lg px-3 py-2 text-xs text-yellow-300/80">
            Le Kelly complet est tres agressif et peut causer de fortes variations. Preferez le Fraction Kelly (25-50%) pour une approche plus stable.
          </div>
        )}
      </div>

      {/* Stats row */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-7 gap-3">
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
          value={`${stats.avgFinal > 0 ? "+" : ""}${formatNum(Math.round(stats.avgFinal))}`}
          sub={`median: ${stats.medianFinal > 0 ? "+" : ""}${formatNum(Math.round(stats.medianFinal))}`}
          color={stats.avgFinal >= 0 ? "text-green-400" : "text-red-400"}
        />
        <StatCard
          label="Ecart-type"
          value={formatNum(Math.round(stats.stdDev))}
          sub="volatilite finale"
          color="text-purple-400"
        />
        <StatCard
          label="Prob. de ruine"
          value={`${stats.ruinPct}%`}
          sub={`seuil: -${ruinThreshold}`}
          color={stats.ruinPct <= 5 ? "text-green-400" : stats.ruinPct <= 20 ? "text-yellow-400" : "text-red-400"}
        />
        {!isFlat && (
          <StatCard
            label="Faillite (BR=0)"
            value={`${stats.bustPct}%`}
            sub="bankroll epuisee"
            color={stats.bustPct <= 1 ? "text-green-400" : stats.bustPct <= 10 ? "text-yellow-400" : "text-red-400"}
          />
        )}
        <StatCard
          label="Pire drawdown"
          value={formatNum(Math.round(stats.maxDrawdown))}
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

      {/* Main chart + Histogram */}
      <div className="grid grid-cols-1 lg:grid-cols-[1fr_300px] gap-4">
        {/* Trajectory chart */}
        <div className="bg-zinc-900/80 backdrop-blur rounded-xl p-4 border border-zinc-800 min-h-[450px]">
          <div className="flex items-center justify-between mb-2">
            <h2 className="text-sm font-semibold text-zinc-300">
              {isFlat ? "Trajectoires P&L" : "Evolution de la bankroll"}
            </h2>
            <div className="flex items-center gap-3">
              {!isFlat && (
                <span className="text-xs text-zinc-500">
                  BR initiale: {startingBankroll}$
                </span>
              )}
              {showBands && (
                <span className="text-xs text-zinc-500">
                  {formatNum(numSims)} simus / {linesToDraw} tracees
                </span>
              )}
            </div>
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
                tickFormatter={(v) => isFlat ? `${v > 0 ? "+" : ""}${formatNum(v)}` : `${formatNum(v)}`}
              />
              <Tooltip content={<CustomTooltip />} />
              <ReferenceLine y={isFlat ? 0 : startingBankroll} stroke="#3f3f46" strokeWidth={1.5} />

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

              <Line type="monotone" dataKey="pctProfitable" stroke="none" dot={false} name="% En profit" />

              {showBands && (
                <Area type="monotone" dataKey="bandOuter" fill="url(#bandOuterGrad)" stroke="none" name="P5-P95" animationDuration={800} />
              )}
              {showBands && (
                <Area type="monotone" dataKey="bandInner" fill="url(#bandInnerGrad)" stroke="none" name="P25-P75" animationDuration={800} />
              )}
              {showBands && (
                <Line type="monotone" dataKey="median" stroke="#60a5fa" strokeWidth={2} dot={false} name="Mediane" animationDuration={600} />
              )}

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
                width={50}
                tickFormatter={(v) => `${v > 0 ? "+" : ""}${formatNum(v)}`}
              />
              <Tooltip
                contentStyle={{
                  backgroundColor: "#18181b",
                  border: "1px solid #3f3f46",
                  borderRadius: "8px",
                  fontSize: "11px",
                }}
                formatter={((value: number) => [`${value}%`, "Frequence"]) as never}
                labelFormatter={(v) => `~${v}`}
              />
              <ReferenceLine y={0} stroke="#52525b" strokeWidth={1} />
              <Bar dataKey="pct" radius={[0, 3, 3, 0]} animationDuration={600}>
                {histogram.map((bin, i) => (
                  <Cell
                    key={i}
                    fill={bin.center >= (isFlat ? 0 : startingBankroll) ? "#22c55e" : "#ef4444"}
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
          <strong className="text-zinc-200">Strategies de mise :</strong>
        </p>
        <ul className="list-disc list-inside space-y-1 ml-2">
          <li><strong className="text-zinc-300">Flat</strong> — Mise fixe a chaque pari. Simple et previsible. La bankroll evolue lineairement.</li>
          <li><strong className="text-zinc-300">% Bankroll</strong> — Mise proportionnelle a la bankroll actuelle. Protege contre la ruine totale (on ne peut jamais perdre 100%), mais les gains sont aussi proportionnels.</li>
          <li><strong className="text-zinc-300">Kelly</strong> — Mise optimale mathematiquement pour maximiser la croissance a long terme. Tres volatile a court terme. Formule : f* = (bp - q) / b.</li>
          <li><strong className="text-zinc-300">Fraction Kelly</strong> — Fraction du Kelly (ex: 25%). Reduit la volatilite tout en conservant une bonne croissance. Le sweet spot pour la plupart des parieurs.</li>
        </ul>
        <p className="mt-2">
          <strong className="text-zinc-200">Conseil :</strong> Comparez le Kelly complet vs le 25% Kelly avec 1000+ paris.
          Le Kelly complet a un meilleur rendement theorique mais une volatilite extreme. Le fractional Kelly offre un bien meilleur ratio rendement/risque.
        </p>
      </div>
    </div>
  );
}
