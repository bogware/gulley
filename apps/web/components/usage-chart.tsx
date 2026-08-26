'use client';

import type { UsageBucket } from '../lib/types';

type Metric = 'requests' | 'inputTokens' | 'outputTokens' | 'costMicroUsd';

/** A lightweight, theme-aware SVG bar chart of a usage metric over time
 *  (buckets summed across groups). No charting dependency. */
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
    return <div className="py-10 text-center text-sm text-neutral-400">No data in range.</div>;
  }

  const max = Math.max(1, ...points.map((p) => p[1]));
  const W = 720;
  const H = 180;
  const pad = 28;
  const bw = (W - pad * 2) / points.length;

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label="usage over time">
      <line
        x1={pad}
        y1={H - pad}
        x2={W - pad}
        y2={H - pad}
        className="stroke-neutral-200 dark:stroke-neutral-700"
      />
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
            rx={2}
            className="fill-neutral-800 dark:fill-neutral-200"
          >
            <title>{`${t}: ${v}`}</title>
          </rect>
        );
      })}
    </svg>
  );
}
