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
  p5: number; p25: number; median: number; p75: number; p95: number;
  bandOuter: [number, number];
  bandInner: [number, number];
  pctProfitable: number;
  [key: string]: number | [number, number];
}

interface HistoBin { range: string; center: number; count: number; pct: number; }

interface StakingConfig {
  mode: StakingMode;
  flatSize: number;
  percentSize: number;
  kellyFraction: number;
  startingBankroll: number;
}

// ─── ENGINE ──────────────────────────────────────────────────
function pct(sorted: number[], p: number): number {
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx), hi = Math.ceil(idx);
  return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

function getStake(br: number, cfg: StakingConfig, odds: number, wp: number): number {
  const b = odds - 1;
  const kelly = Math.max(0, (b * wp - (1 - wp)) / b);
  switch (cfg.mode) {
    case "flat": return cfg.flatSize;
    case "percent": return Math.max(0.01, br * cfg.percentSize / 100);
    case "kelly": return Math.max(0.01, br * kelly);
    case "kelly_fraction": return Math.max(0.01, br * kelly * cfg.kellyFraction);
  }
}

function theoreticalFrac(cfg: StakingConfig, odds: number, wp: number): number {
  const b = odds - 1;
  const kelly = Math.max(0, (b * wp - (1 - wp)) / b);
  switch (cfg.mode) {
    case "percent": return cfg.percentSize / 100;
    case "kelly": return kelly;
    case "kelly_fraction": return kelly * cfg.kellyFraction;
    default: return 0;
  }
}

function run(numSims: number, numBets: number, odds: number, ev: number, ruinTh: number, stk: StakingConfig) {
  const wp = Math.max(0.001, Math.min(0.999, (1 + ev / 100) / odds));
  const flat = stk.mode === "flat";
  const br0 = stk.startingBankroll;

  const step = Math.max(1, Math.floor(numBets / 200));
  const pts: number[] = [];
  for (let b = 0; b <= numBets; b += step) pts.push(b);
  if (pts[pts.length - 1] !== numBets) pts.push(numBets);
  const np = pts.length;

  const lines = Math.min(numSims, MAX_DRAWN_LINES);
  const brsAt: number[][] = pts.map(() => []);
  const profAt: number[] = new Array(np).fill(0);
  const drawn: number[][] = Array.from({ length: lines }, () => new Array(np).fill(0));
  const finals: number[] = [];

  let prof = 0, totF = 0, worstDD = 0, ruinN = 0, bustN = 0;

  for (let s = 0; s < numSims; s++) {
    const rng = mulberry32(s * 31337 + 42);
    let br = flat ? 0 : br0, pk = br, si = 1;
    let ruined = false, busted = false;

    brsAt[0].push(br);
    if (s < lines) drawn[s][0] = br;

    for (let b = 1; b <= numBets; b++) {
      const stake = flat ? stk.flatSize : getStake(br, stk, odds, wp);
      if (!flat && br < 0.01) {
        if (!busted) { busted = true; bustN++; }
        if (si < np && b === pts[si]) { brsAt[si].push(br); if (br > (flat ? 0 : br0)) profAt[si]++; if (s < lines) drawn[s][si] = +br.toFixed(2); si++; }
        continue;
      }
      br += rng() < wp ? stake * (odds - 1) : -stake;
      if (br > pk) pk = br;
      const dd = pk - br;
      if (dd > worstDD) worstDD = dd;
      if (!ruined && br <= (flat ? -ruinTh : br0 - ruinTh)) { ruined = true; ruinN++; }
      if (si < np && b === pts[si]) {
        brsAt[si].push(br);
        if (flat ? br > 0 : br > br0) profAt[si]++;
        if (s < lines) drawn[s][si] = +br.toFixed(2);
        si++;
      }
    }
    const pnl = flat ? br : br - br0;
    finals.push(pnl);
    if (pnl > 0) prof++;
    totF += pnl;
  }

  let conv: number | null = null;
  for (let i = 1; i < np; i++) if (profAt[i] / numSims >= 0.9) { conv = pts[i]; break; }

  const data: SimResult[] = pts.map((bn, i) => {
    const v = brsAt[i].slice().sort((a, b) => a - b);
    const p5 = +pct(v, 5).toFixed(2), p25 = +pct(v, 25).toFixed(2), med = +pct(v, 50).toFixed(2), p75 = +pct(v, 75).toFixed(2), p95 = +pct(v, 95).toFixed(2);
    const evV = flat ? +(bn * ev / 100).toFixed(2) : +(br0 * Math.pow(1 + ev / 100 * theoreticalFrac(stk, odds, wp), bn)).toFixed(2);
    const pt: SimResult = { betNumber: bn, ev: evV, p5, p25, median: med, p75, p95, bandOuter: [p5, p95], bandInner: [p25, p75], pctProfitable: i === 0 ? 0 : +((profAt[i] / numSims) * 100).toFixed(1) };
    for (let s = 0; s < lines; s++) pt[`sim${s}`] = drawn[s][i];
    return pt;
  });

  const sf = finals.slice().sort((a, b) => a - b);
  const hMin = sf[0], hMax = sf[sf.length - 1];
  const bc = Math.min(25, Math.max(8, Math.ceil(Math.sqrt(numSims))));
  const bw = (hMax - hMin) / bc || 1;
  const histo: HistoBin[] = [];
  for (let i = 0; i < bc; i++) {
    const lo = hMin + i * bw, hi = lo + bw, c = (lo + hi) / 2;
    const cnt = finals.filter((x) => x >= lo && (i === bc - 1 ? x <= hi : x < hi)).length;
    histo.push({ range: `${lo.toFixed(0)}→${hi.toFixed(0)}`, center: +c.toFixed(1), count: cnt, pct: +((cnt / numSims) * 100).toFixed(1) });
  }

  const lc: string[] = [];
  for (let s = 0; s < lines; s++) {
    const f = drawn[s][np - 1], all = drawn.map((l) => l[np - 1]);
    const mn = Math.min(...all), mx = Math.max(...all), rng = mx - mn || 1;
    lc.push(interp((f - mn) / rng));
  }

  const mean = finals.reduce((s, v) => s + v, 0) / finals.length;
  const sd = Math.sqrt(finals.reduce((s, v) => s + (v - mean) ** 2, 0) / finals.length);

  return { data, lines, lc, histo, conv, stats: { prof: (prof / numSims) * 100, dd: +worstDD.toFixed(2), avg: +(totF / numSims).toFixed(2), ruin: +((ruinN / numSims) * 100).toFixed(1), bust: +((bustN / numSims) * 100).toFixed(1), med: +pct(sf, 50).toFixed(2), sd: +sd.toFixed(2) } };
}

function interp(t: number): string {
  const r = t < 0.5 ? 239 : Math.round(239 - (239 - 34) * (t - 0.5) * 2);
  const g = t < 0.5 ? Math.round(68 + (179 - 68) * t * 2) : Math.round(179 + (197 - 179) * (t - 0.5) * 2);
  const b = t < 0.5 ? Math.round(68 + (8 - 68) * t * 2) : Math.round(8 + (94 - 8) * (t - 0.5) * 2);
  return `rgb(${r},${g},${b})`;
}

const SIM_STEPS = [1, 2, 3, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000, 50000];
const MODES: { v: StakingMode; l: string }[] = [
  { v: "flat", l: "Flat" }, { v: "percent", l: "% BR" }, { v: "kelly", l: "Kelly" }, { v: "kelly_fraction", l: "½ Kelly" },
];

function fmt(n: number): string {
  if (Math.abs(n) >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (Math.abs(n) >= 1e3) return `${(n / 1e3).toFixed(n % 1e3 === 0 ? 0 : 1)}k`;
  return `${n}`;
}

// ─── COMPACT SLIDER ─────────────────────────────────────────
function S({ label, value, onChange, min, max, step, unit, fv }: {
  label: string; value: number; onChange: (v: number) => void;
  min: number; max: number; step: number; unit?: string; fv?: (v: number) => string;
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <div className="flex justify-between items-baseline">
        <span className="text-[10px] text-zinc-500 uppercase tracking-wider">{label}</span>
        <span className="font-mono text-xs font-semibold text-zinc-200">{fv ? fv(value) : value}{unit || ""}</span>
      </div>
      <input type="range" min={min} max={max} step={step} value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))} className="w-full" />
    </div>
  );
}

// ─── STAT PILL ──────────────────────────────────────────────
function Pill({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div className="flex items-center gap-1.5 px-2 py-1 rounded-md bg-zinc-900/60 border border-zinc-800/50">
      <span className="text-[10px] text-zinc-500">{label}</span>
      <span className={`font-mono text-xs font-bold ${color || "text-zinc-200"}`}>{value}</span>
    </div>
  );
}

// ─── TOOLTIP ────────────────────────────────────────────────
function Tip({ active, payload, label }: { active?: boolean; payload?: Array<{ dataKey: string; value: number | [number, number] }>; label?: number }) {
  if (!active || !payload || !label) return null;
  const ev = payload.find((p) => p.dataKey === "ev");
  const med = payload.find((p) => p.dataKey === "median");
  const pp = payload.find((p) => p.dataKey === "pctProfitable");
  return (
    <div className="bg-zinc-950/95 border border-zinc-800 rounded-md px-2.5 py-1.5 shadow-xl text-[10px] space-y-0.5">
      <div className="font-semibold text-zinc-300 text-xs">#{label}</div>
      {ev && <div className="flex justify-between gap-3"><span className="text-zinc-500">EV</span><span className="font-mono text-white">{Number(ev.value).toFixed(1)}</span></div>}
      {med && <div className="flex justify-between gap-3"><span className="text-zinc-500">Med</span><span className="font-mono text-blue-400">{Number(med.value).toFixed(1)}</span></div>}
      {pp && <div className="flex justify-between gap-3"><span className="text-zinc-500">Profit</span><span className={`font-mono font-bold ${(pp.value as number) >= 50 ? "text-green-400" : "text-red-400"}`}>{(pp.value as number).toFixed(0)}%</span></div>}
    </div>
  );
}

// ─── PAGE ───────────────────────────────────────────────────
export default function Home() {
  const [si, setSi] = useState(4);
  const [ev, setEv] = useState(3);
  const [nb, setNb] = useState(500);
  const [odds, setOdds] = useState(2.0);
  const [ruin, setRuin] = useState(50);
  const [mode, setMode] = useState<StakingMode>("flat");
  const [flat, setFlat] = useState(1);
  const [pctS, setPctS] = useState(2);
  const [kf, setKf] = useState(0.25);
  const [br0, setBr0] = useState(1000);

  const ns = SIM_STEPS[si];
  const bands = ns > MAX_DRAWN_LINES;
  const isFlat = mode === "flat";
  const stk: StakingConfig = { mode, flatSize: flat, percentSize: pctS, kellyFraction: kf, startingBankroll: br0 };

  const { data, lines, lc, histo, conv, stats } = useMemo(
    () => run(ns, nb, odds, ev, ruin, stk),
    [ns, nb, odds, ev, ruin, mode, flat, pctS, kf, br0]
  );

  const wp = ((1 + ev / 100) / odds * 100).toFixed(1);
  const kellyPct = useMemo(() => {
    const b = odds - 1, p = Math.max(0.001, Math.min(0.999, (1 + ev / 100) / odds));
    return Math.max(0, (b * p - (1 - p)) / b * 100);
  }, [odds, ev]);

  return (
    <div className="h-screen flex flex-col overflow-hidden">
      {/* Top bar */}
      <div className="flex items-center justify-between px-4 py-2 border-b border-zinc-800/50">
        <h1 className="text-sm font-bold tracking-tight text-zinc-200">Monte Carlo <span className="text-zinc-500 font-normal">/ paris sportifs</span></h1>
        <div className="flex flex-wrap gap-1.5">
          <Pill label="Win%" value={`${wp}%`} />
          <Pill label="Rentable" value={`${stats.prof.toFixed(0)}%`} color={stats.prof >= 50 ? "text-green-400" : "text-red-400"} />
          <Pill label="Avg" value={`${stats.avg > 0 ? "+" : ""}${fmt(Math.round(stats.avg))}`} color={stats.avg >= 0 ? "text-green-400" : "text-red-400"} />
          <Pill label="Med" value={`${stats.med > 0 ? "+" : ""}${fmt(Math.round(stats.med))}`} color={stats.med >= 0 ? "text-green-400" : "text-red-400"} />
          <Pill label="σ" value={fmt(Math.round(stats.sd))} color="text-purple-400" />
          <Pill label="Ruine" value={`${stats.ruin}%`} color={stats.ruin <= 5 ? "text-green-400" : stats.ruin <= 20 ? "text-yellow-400" : "text-red-400"} />
          {!isFlat && <Pill label="Bust" value={`${stats.bust}%`} color={stats.bust <= 1 ? "text-green-400" : "text-red-400"} />}
          <Pill label="DD" value={fmt(Math.round(stats.dd))} color="text-orange-400" />
          {conv && <Pill label="Conv." value={`#${fmt(conv)}`} color="text-green-400" />}
        </div>
      </div>

      <div className="flex flex-1 overflow-hidden">
        {/* Sidebar */}
        <div className="w-56 shrink-0 border-r border-zinc-800/50 p-3 flex flex-col gap-3 overflow-y-auto">
          {/* Core params */}
          <div className="space-y-2.5">
            <S label="Simulations" value={si} onChange={(v) => setSi(Math.round(v))} min={0} max={SIM_STEPS.length - 1} step={1} fv={() => fmt(ns)} />
            <S label="EV" value={ev} onChange={setEv} min={-10} max={20} step={0.5} unit="%" />
            <S label="Paris" value={nb} onChange={setNb} min={50} max={10000} step={50} fv={(v) => fmt(v)} />
            <S label="Cote" value={odds} onChange={setOdds} min={1.2} max={5.0} step={0.1} />
            <S label="Ruine" value={ruin} onChange={setRuin} min={10} max={500} step={5} unit={isFlat ? "u" : "$"} />
          </div>

          <div className="h-px bg-zinc-800/50" />

          {/* Staking */}
          <div>
            <span className="text-[10px] text-zinc-500 uppercase tracking-wider">Mise</span>
            <div className="grid grid-cols-2 gap-1 mt-1.5">
              {MODES.map((m) => (
                <button key={m.v} onClick={() => setMode(m.v)}
                  className={`px-2 py-1 rounded text-[10px] font-medium transition-all border ${
                    mode === m.v ? "bg-blue-600/20 border-blue-500/50 text-blue-300" : "bg-transparent border-zinc-800 text-zinc-500 hover:text-zinc-300"
                  }`}>{m.l}</button>
              ))}
            </div>
          </div>

          <div className="space-y-2.5">
            {mode === "flat" && <S label="Taille" value={flat} onChange={setFlat} min={0.5} max={10} step={0.5} unit="u" />}
            {mode !== "flat" && <S label="Bankroll" value={br0} onChange={setBr0} min={100} max={10000} step={100} unit="$" />}
            {mode === "percent" && <S label="% / pari" value={pctS} onChange={setPctS} min={0.5} max={20} step={0.5} unit="%" />}
            {mode === "kelly_fraction" && <S label="Fraction" value={kf} onChange={setKf} min={0.05} max={1} step={0.05} fv={(v) => `${(v * 100).toFixed(0)}%`} />}
            {(mode === "kelly" || mode === "kelly_fraction") && (
              <div className="flex items-baseline justify-between">
                <span className="text-[10px] text-zinc-500">Kelly</span>
                <span className="font-mono text-xs font-bold text-yellow-400">{kellyPct.toFixed(1)}%</span>
              </div>
            )}
            {mode === "kelly_fraction" && (
              <div className="flex items-baseline justify-between">
                <span className="text-[10px] text-zinc-500">Effective</span>
                <span className="font-mono text-xs font-bold text-cyan-400">{(kellyPct * kf).toFixed(2)}%</span>
              </div>
            )}
          </div>

          {/* Legend — compact */}
          <div className="mt-auto pt-3 space-y-1.5 border-t border-zinc-800/50">
            <div className="flex items-center gap-1.5 text-[10px] text-zinc-600">
              <span className="w-4 h-px bg-white" style={{ backgroundImage: "repeating-linear-gradient(90deg,#fff 0,#fff 3px,transparent 3px,transparent 5px)" }} />
              EV
            </div>
            {bands && (
              <>
                <div className="flex items-center gap-1.5 text-[10px] text-zinc-600">
                  <span className="w-3 h-2.5 rounded-sm bg-blue-500/15 border border-blue-500/25" /> P5-P95
                </div>
                <div className="flex items-center gap-1.5 text-[10px] text-zinc-600">
                  <span className="w-4 h-px bg-blue-400" /> Mediane
                </div>
              </>
            )}
            <div className="flex items-center gap-1.5 text-[10px] text-zinc-600">
              <span className="w-4 h-1.5 rounded-sm" style={{ background: "linear-gradient(90deg,#ef4444,#eab308,#22c55e)" }} /> Sims
            </div>
            {conv && (
              <div className="flex items-center gap-1.5 text-[10px] text-zinc-600">
                <span className="w-4 h-px bg-green-500" style={{ backgroundImage: "repeating-linear-gradient(90deg,#22c55e 0,#22c55e 3px,transparent 3px,transparent 5px)" }} /> 90%
              </div>
            )}
          </div>
        </div>

        {/* Main area */}
        <div className="flex-1 flex flex-col overflow-hidden">
          {/* Chart */}
          <div className="flex-1 p-2 min-h-0">
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={data} margin={{ top: 8, right: 12, bottom: 4, left: 4 }}>
                <defs>
                  <linearGradient id="bo" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#3b82f6" stopOpacity={0.12} />
                    <stop offset="100%" stopColor="#3b82f6" stopOpacity={0.02} />
                  </linearGradient>
                  <linearGradient id="bi" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#3b82f6" stopOpacity={0.25} />
                    <stop offset="100%" stopColor="#3b82f6" stopOpacity={0.06} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="#18181b" />
                <XAxis dataKey="betNumber" stroke="#3f3f46" fontSize={10} tickFormatter={fmt} />
                <YAxis stroke="#3f3f46" fontSize={10} tickFormatter={(v) => isFlat ? `${v > 0 ? "+" : ""}${fmt(v)}` : fmt(v)} />
                <Tooltip content={<Tip />} />
                <ReferenceLine y={isFlat ? 0 : br0} stroke="#27272a" strokeWidth={1} />

                {conv && <ReferenceLine x={conv} stroke="#22c55e" strokeWidth={1.5} strokeDasharray="4 3" />}
                <Line type="monotone" dataKey="pctProfitable" stroke="none" dot={false} />

                {bands && <Area type="monotone" dataKey="bandOuter" fill="url(#bo)" stroke="none" animationDuration={500} />}
                {bands && <Area type="monotone" dataKey="bandInner" fill="url(#bi)" stroke="none" animationDuration={500} />}
                {bands && <Line type="monotone" dataKey="median" stroke="#60a5fa" strokeWidth={1.5} dot={false} animationDuration={400} />}

                <Line type="monotone" dataKey="ev" stroke="#fff" strokeWidth={2} strokeDasharray="6 3" dot={false} animationDuration={400} />

                {Array.from({ length: lines }, (_, i) => (
                  <Line key={i} type="monotone" dataKey={`sim${i}`} stroke={lc[i]}
                    strokeWidth={bands ? 0.8 : 1.2} dot={false} opacity={bands ? 0.3 : 0.7}
                    animationDuration={300 + i * 30} />
                ))}

                <Brush dataKey="betNumber" height={20} stroke="#27272a" fill="#0a0a0a" tickFormatter={fmt} />
              </ComposedChart>
            </ResponsiveContainer>
          </div>

          {/* Bottom histogram strip */}
          <div className="h-28 border-t border-zinc-800/50 px-2">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={histo} margin={{ top: 4, right: 8, bottom: 0, left: 8 }}>
                <XAxis dataKey="center" stroke="#3f3f46" fontSize={9} tickFormatter={(v) => `${v > 0 ? "+" : ""}${fmt(v)}`} />
                <YAxis stroke="#3f3f46" fontSize={9} tickFormatter={(v) => `${v}%`} width={30} />
                <Tooltip contentStyle={{ backgroundColor: "#0a0a0a", border: "1px solid #27272a", borderRadius: "4px", fontSize: "10px" }}
                  formatter={((v: number) => [`${v}%`]) as never} labelFormatter={(v) => `~${v}`} />
                <Bar dataKey="pct" radius={[2, 2, 0, 0]} animationDuration={400}>
                  {histo.map((b, i) => (
                    <Cell key={i} fill={b.center >= 0 ? "#22c55e" : "#ef4444"} fillOpacity={0.6} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      </div>
    </div>
  );
}
