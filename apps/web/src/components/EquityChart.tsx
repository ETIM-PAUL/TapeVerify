export function EquityChart({
  points,
  base,
}: {
  points: Array<{ t: number; equity: number }>;
  base: number;
}) {
  if (points.length < 2) return <p className="muted small">Not enough data for a chart yet.</p>;
  const ys = points.map((p) => p.equity);
  const lo = Math.min(base, ...ys);
  const hi = Math.max(base, ...ys);
  const W = 640;
  const H = 150;
  const x = (i: number) => (i / (points.length - 1)) * W;
  const y = (v: number) => H - ((v - lo) / (hi - lo || 1)) * (H - 10) - 5;
  const path = points
    .map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(p.equity).toFixed(1)}`)
    .join(" ");
  const up = (points[points.length - 1]?.equity ?? base) >= base;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="curve" role="img" aria-label="Equity curve">
      <line x1="0" x2={W} y1={y(base)} y2={y(base)} stroke="var(--line)" strokeDasharray="4 4" />
      <path d={path} fill="none" stroke={up ? "var(--ok)" : "var(--err)"} strokeWidth="2" />
    </svg>
  );
}
