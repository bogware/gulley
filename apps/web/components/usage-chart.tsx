'use client';

import type { UsageBucket } from '../lib/types';

type Metric = 'requests' | 'inputTokens' | 'outputTokens' | 'costMicroUsd';

/** Lightweight SVG bar chart of a usage metric over time (buckets summed across
 *  groups). No charting dependency — Platinum accent bars over a hairline baseline. */
export function UsageChart({
  buckets,
  metric = 'costMicroUsd',
}: {
  buckets: UsageBucket[];
  metric?: Metric;
}) {
  const byTime = new Map<string, number>();
  for (const b of buckets) byTime.set(b.bucketStart, (byTime.get(b.bucketStart) ?? 0) + b[metric]);
  const points = [...byTime.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));

  if (points.length === 0) {
    return <div className="py-10 text-center text-[11.5px] text-micro">No data in range.</div>;
  }

  const max = Math.max(1, ...points.map((p) => p[1]));
  const W = 720;
  const H = 180;
  const pad = 24;
  const bw = (W - pad * 2) / points.length;

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label="usage over time">
      {[0.25, 0.5, 0.75].map((g) => (
        <line
          key={g}
          x1={pad}
          y1={pad + (H - pad * 2) * g}
          x2={W - pad}
          y2={pad + (H - pad * 2) * g}
          stroke="#EDE9E0"
        />
      ))}
      <line x1={pad} y1={H - pad} x2={W - pad} y2={H - pad} stroke="#D8D2C6" />
      {points.map(([t, v], i) => {
        const h = (v / max) * (H - pad * 2);
        const x = pad + i * bw;
        const y = H - pad - h;
        return (
          <rect
            key={t}
            x={x + bw * 0.15}
            y={y}
            width={Math.max(1, bw * 0.7)}
            height={Math.max(1, h)}
            rx={1}
            fill="#2F5D8C"
            className="transition-opacity hover:opacity-75"
          >
            <title>{`${t}: ${v}`}</title>
          </rect>
        );
      })}
    </svg>
  );
}
