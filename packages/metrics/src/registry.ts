/**
 * A tiny, dependency-free Prometheus registry — counters + histograms rendered
 * in the text exposition format (v0.0.4). Hand-rolled rather than pulling in
 * `prom-client`, matching the codebase's lean, zero-runtime-dep style. Keep
 * label sets LOW cardinality (provider/model/status), never per-request ids or
 * virtual keys, or the series count explodes.
 */
export type Labels = Record<string, string>;

function seriesKey(labels: Labels): string {
  return Object.keys(labels)
    .sort()
    .map((k) => `${k}=${labels[k]}`)
    .join(',');
}

function escapeLabelValue(v: string): string {
  return v.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"');
}

function renderLabels(labels: Labels, extra?: [string, string]): string {
  const entries = Object.entries(labels);
  if (extra) entries.push(extra);
  if (entries.length === 0) return '';
  entries.sort((a, b) => a[0].localeCompare(b[0]));
  return `{${entries.map(([k, v]) => `${k}="${escapeLabelValue(v)}"`).join(',')}}`;
}

export interface Metric {
  render(): string;
}

export class Counter implements Metric {
  private readonly series = new Map<string, { labels: Labels; value: number }>();

  constructor(
    readonly name: string,
    readonly help: string,
  ) {}

  inc(labels: Labels = {}, amount = 1): void {
    const key = seriesKey(labels);
    const s = this.series.get(key);
    if (s) s.value += amount;
    else this.series.set(key, { labels, value: amount });
  }

  render(): string {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} counter`];
    for (const s of this.series.values()) {
      lines.push(`${this.name}${renderLabels(s.labels)} ${s.value}`);
    }
    return lines.join('\n');
  }
}

interface HistogramSeries {
  labels: Labels;
  /** buckets[i] = count of observations ≤ bounds[i] (already cumulative). */
  buckets: number[];
  sum: number;
  count: number;
}

export class Histogram implements Metric {
  private readonly series = new Map<string, HistogramSeries>();

  constructor(
    readonly name: string,
    readonly help: string,
    readonly bounds: readonly number[],
  ) {}

  observe(labels: Labels, value: number): void {
    const key = seriesKey(labels);
    let s = this.series.get(key);
    if (!s) {
      s = { labels, buckets: new Array(this.bounds.length).fill(0), sum: 0, count: 0 };
      this.series.set(key, s);
    }
    s.sum += value;
    s.count += 1;
    // Increment every bucket whose upper bound is ≥ value → cumulative "le" counts.
    for (let i = 0; i < this.bounds.length; i++) {
      if (value <= (this.bounds[i] as number)) s.buckets[i] = (s.buckets[i] as number) + 1;
    }
  }

  render(): string {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} histogram`];
    for (const s of this.series.values()) {
      for (let i = 0; i < this.bounds.length; i++) {
        const le = String(this.bounds[i]);
        lines.push(`${this.name}_bucket${renderLabels(s.labels, ['le', le])} ${s.buckets[i]}`);
      }
      lines.push(`${this.name}_bucket${renderLabels(s.labels, ['le', '+Inf'])} ${s.count}`);
      lines.push(`${this.name}_sum${renderLabels(s.labels)} ${s.sum}`);
      lines.push(`${this.name}_count${renderLabels(s.labels)} ${s.count}`);
    }
    return lines.join('\n');
  }
}

export class Registry {
  private readonly metrics: Metric[] = [];

  counter(name: string, help: string): Counter {
    const c = new Counter(name, help);
    this.metrics.push(c);
    return c;
  }

  histogram(name: string, help: string, bounds: readonly number[]): Histogram {
    const h = new Histogram(name, help, bounds);
    this.metrics.push(h);
    return h;
  }

  /** Prometheus text exposition; always ends with a trailing newline. */
  render(): string {
    return `${this.metrics.map((m) => m.render()).join('\n\n')}\n`;
  }
}

export const PROMETHEUS_CONTENT_TYPE = 'text/plain; version=0.0.4; charset=utf-8';
