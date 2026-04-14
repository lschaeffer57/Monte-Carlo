"use client";

import { useState, useMemo, useCallback } from "react";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
  ReferenceLine,
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

interface SimResult {
  betNumber: number;
  [key: string]: number;
}

function runSimulations(
  numSims: number,
  numBets: number,
  avgOdds: number,
  ev: number
): { data: SimResult[]; stats: { profitable: number; maxDrawdown: number; avgFinal: number } } {
  // EV% means: on average, each bet returns (1 + ev/100) of the stake
  // With odds o and EV%, the implied win probability is: p = (1 + ev/100) / o
  const winProb = (1 + ev / 100) / avgOdds;
  const clampedProb = Math.max(0.001, Math.min(0.999, winProb));

  // Sample points to display (max 200 points on x-axis for performance)
  const step = Math.max(1, Math.floor(numBets / 200));
  const samplePoints: number[] = [];
  for (let b = 0; b <= numBets; b += step) samplePoints.push(b);
  if (samplePoints[samplePoints.length - 1] !== numBets) samplePoints.push(numBets);

  const data: SimResult[] = samplePoints.map((b) => ({ betNumber: b }));

  let profitable = 0;
  let totalFinal = 0;
  let worstDrawdown = 0;

  for (let s = 0; s < numSims; s++) {
    const rng = mulberry32(s * 31337 + 42);
    let bankroll = 0;
    let peak = 0;
    let sampleIdx = 0;

    // Set starting point
    data[0][`sim${s}`] = 0;
    sampleIdx = 1;

    for (let b = 1; b <= numBets; b++) {
      const won = rng() < clampedProb;
      if (won) {
        bankroll += (avgOdds - 1); // net profit per unit staked
      } else {
        bankroll -= 1; // lose the stake
      }

      if (bankroll > peak) peak = bankroll;
      const dd = peak - bankroll;
      if (dd > worstDrawdown) worstDrawdown = dd;

      if (sampleIdx < samplePoints.length && b === samplePoints[sampleIdx]) {
        data[sampleIdx][`sim${s}`] = parseFloat(bankroll.toFixed(2));
        sampleIdx++;
      }
    }

    if (bankroll > 0) profitable++;
    totalFinal += bankroll;
  }

  // Add EV line (theoretical expected profit)
  const evPerBet = ev / 100; // expected profit per unit staked
  for (let i = 0; i < data.length; i++) {
    data[i].ev = parseFloat((samplePoints[i] * evPerBet).toFixed(2));
  }

  return {
    data,
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

function Slider({
  label,
  value,
  onChange,
  min,
  max,
  step,
  unit,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  min: number;
  max: number;
  step: number;
  unit?: string;
}) {
  return (
    <div className="flex flex-col gap-1">
      <div className="flex justify-between text-sm">
        <span className="text-zinc-400">{label}</span>
        <span className="font-mono font-bold text-blue-400">
          {value}
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

export default function Home() {
  const [numSims, setNumSims] = useState(10);
  const [ev, setEv] = useState(3);
  const [numBets, setNumBets] = useState(500);
  const [avgOdds, setAvgOdds] = useState(2.0);

  const { data, stats } = useMemo(
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
          value={numSims}
          onChange={setNumSims}
          min={1}
          max={20}
          step={1}
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
          max={5000}
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

      {/* Stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatCard
          label="Probabilite de gain"
          value={`${winProb}%`}
          sub="par pari"
        />
        <StatCard
          label="Simulations rentables"
          value={`${stats.profitable.toFixed(0)}%`}
          sub={`sur ${numSims} simus`}
          color={stats.profitable >= 50 ? "text-green-400" : "text-red-400"}
        />
        <StatCard
          label="Profit moyen final"
          value={`${stats.avgFinal > 0 ? "+" : ""}${stats.avgFinal}u`}
          sub={`apres ${numBets} paris`}
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
          <LineChart data={data}>
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
            />
            <ReferenceLine y={0} stroke="#52525b" strokeWidth={2} />
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
            {/* Simulation lines */}
            {Array.from({ length: numSims }, (_, i) => (
              <Line
                key={i}
                type="monotone"
                dataKey={`sim${i}`}
                stroke={COLORS[i % COLORS.length]}
                strokeWidth={1.5}
                dot={false}
                name={`Simulation ${i + 1}`}
                opacity={0.7}
              />
            ))}
          </LineChart>
        </ResponsiveContainer>
      </div>

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
          <strong className="text-zinc-200">Astuce :</strong> Augmentez les cotes pour
          voir plus de variance. Augmentez le nombre de paris pour voir la convergence.
          Un EV negatif montre pourquoi les bookmakers gagnent toujours.
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
