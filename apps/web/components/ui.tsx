'use client';

import {
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  useState,
} from 'react';

export function cx(...parts: Array<string | false | undefined>): string {
  return parts.filter(Boolean).join(' ');
}

/* ------------------------------------------------------------------ surfaces */

/** A raised panel: platinum surface, hairline card border, 4px radius, top-light
 *  bevel. The base container for every card in the console. */
export function Panel({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cx('rounded-card border border-line-card bg-panel shadow-raise', className)}>
      {children}
    </div>
  );
}

/** A panel's header strip: title on the left, optional meta/actions on the right. */
export function PanelHeader({
  title,
  meta,
  right,
  className,
}: {
  title?: ReactNode;
  meta?: ReactNode;
  right?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cx(
        'flex items-center justify-between gap-3 border-b border-line px-3 py-2.5',
        className,
      )}
    >
      <div className="flex min-w-0 items-baseline gap-2">
        {title ? <div className="truncate text-[12px] font-medium text-ink">{title}</div> : null}
        {meta ? <div className="truncate font-mono text-2xs text-secondary">{meta}</div> : null}
      </div>
      {right ? <div className="flex shrink-0 items-center gap-2">{right}</div> : null}
    </div>
  );
}

/** Back-compat alias — existing pages import `Card`. */
export function Card({ children, className }: { children: ReactNode; className?: string }) {
  return <Panel className={className}>{children}</Panel>;
}

/* -------------------------------------------------------------------- header */

export function PageHeader({
  title,
  subtitle,
  actions,
}: {
  title: string;
  subtitle?: string;
  actions?: ReactNode;
}) {
  return (
    <div className="-mx-5 -mt-4 mb-4 flex items-center justify-between gap-4 border-b border-line bg-header px-5 py-3.5">
      <div className="min-w-0">
        <h1 className="text-[19px] font-semibold tracking-[-0.015em] text-ink">{title}</h1>
        {subtitle ? <p className="mt-0.5 text-[11.5px] text-secondary">{subtitle}</p> : null}
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
    </div>
  );
}

export function MicroLabel({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cx('text-[9px] font-medium uppercase tracking-[0.14em] text-micro', className)}>
      {children}
    </div>
  );
}

/* ------------------------------------------------------------------- controls */

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary' | 'danger' | 'ghost';
};

export function Button({ variant = 'secondary', className, ...props }: ButtonProps) {
  const styles: Record<string, string> = {
    // Primary = solid ink; secondary = bevelled platinum; danger; ghost.
    primary: 'bg-ink text-[#F6F3EC] hover:bg-[#33302A]',
    secondary:
      'border border-line-control bg-gradient-to-b from-panel to-[#EDE9E0] text-body hover:to-[#E4DFD3]',
    danger: 'border border-err-border bg-err-bg text-err-text hover:brightness-[.98]',
    ghost: 'text-secondary hover:bg-rail',
  };
  return (
    <button
      {...props}
      className={cx(
        'inline-flex items-center gap-1.5 rounded-control px-[11px] py-[5px] text-[11.5px] font-medium transition-colors duration-[120ms] ease-out disabled:cursor-not-allowed disabled:opacity-50',
        styles[variant],
        className,
      )}
    />
  );
}

const FIELD =
  'w-full rounded-control border border-line-control bg-[#FDFCF9] px-2.5 py-[5px] text-[11.5px] text-ink shadow-field outline-none placeholder:text-secondary/70';

export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={cx(FIELD, 'font-mono', className)} />;
}

export function Select({
  className,
  children,
  ...props
}: SelectHTMLAttributes<HTMLSelectElement> & { children: ReactNode }) {
  return (
    <select {...props} className={cx(FIELD, 'w-auto cursor-pointer pr-6 font-mono', className)}>
      {children}
    </select>
  );
}

/** A labelled field wrapper (micro-label above a control). */
export function Field({
  label,
  children,
  className,
}: {
  label: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <label className={cx('flex flex-col gap-1', className)}>
      <MicroLabel>{label}</MicroLabel>
      {children}
    </label>
  );
}

/** Segmented control: one bordered rail, active cell filled ink. */
export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  className,
}: {
  options: ReadonlyArray<{ value: T; label: string }>;
  value: T;
  onChange: (v: T) => void;
  className?: string;
}) {
  return (
    <div
      className={cx(
        'inline-flex overflow-hidden rounded-control border border-line-control bg-panel',
        className,
      )}
    >
      {options.map((o, i) => {
        const active = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            onClick={() => onChange(o.value)}
            className={cx(
              'px-2.5 py-[4px] text-[11px] font-medium transition-colors duration-[120ms]',
              i > 0 && 'border-l border-line-control',
              active ? 'bg-ink text-[#F6F3EC]' : 'text-secondary hover:bg-rail',
            )}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

/* -------------------------------------------------------------------- status */

type Tone = 'neutral' | 'green' | 'red' | 'amber' | 'blue';

const CHIP_TONES: Record<Tone, string> = {
  neutral: 'bg-rail text-secondary border-line-control',
  green: 'bg-ok-bg text-ok-text border-ok-border',
  red: 'bg-err-bg text-err-text border-err-border',
  amber: 'bg-warn-bg text-warn-text border-warn-border',
  blue: 'bg-accent-tint text-accent-ink border-accent-soft',
};

/** Rectangular status chip (2px radius, mono) — the Platinum replacement for a pill. */
export function StatusChip({ children, tone = 'neutral' }: { children: ReactNode; tone?: Tone }) {
  return (
    <span
      className={cx(
        'inline-flex items-center rounded-chip border px-1.5 py-[1px] font-mono text-[10px] font-medium',
        CHIP_TONES[tone],
      )}
    >
      {children}
    </span>
  );
}

/** Back-compat: existing pages import `Badge`. Same tones, chip shape now. */
export function Badge({ children, tone = 'neutral' }: { children: ReactNode; tone?: Tone }) {
  return <StatusChip tone={tone}>{children}</StatusChip>;
}

export function StatusPill({ status, code }: { status?: string; code?: number }) {
  const ok = status === 'ok' || (code !== undefined && code < 400);
  const aborted = status === 'aborted';
  return (
    <StatusChip tone={ok ? 'green' : aborted ? 'amber' : 'red'}>{code ?? status ?? '—'}</StatusChip>
  );
}

/** A status dot; `halo` adds a soft ring for the "degraded" state. */
export function Dot({
  tone = 'green',
  halo,
}: {
  tone?: 'green' | 'amber' | 'red';
  halo?: boolean;
}) {
  const color = tone === 'green' ? '#4B7A4E' : tone === 'amber' ? '#C67A28' : '#A0392E';
  return (
    <span
      className="inline-block h-[7px] w-[7px] shrink-0 rounded-full"
      style={{ background: color, boxShadow: halo ? `0 0 0 2px ${color}33` : undefined }}
    />
  );
}

/* --------------------------------------------------------------------- data */

export function StatTile({
  label,
  value,
  hint,
  delta,
}: {
  label: string;
  value: ReactNode;
  hint?: string;
  delta?: { dir: 'up' | 'down'; text: string; good?: boolean };
}) {
  return (
    <Panel className="px-3 py-2.5">
      <MicroLabel>{label}</MicroLabel>
      <div className="mt-1.5 font-mono text-[25px] font-medium tabular-nums tracking-[-0.02em] text-ink">
        {value}
      </div>
      {delta ? (
        <div className="mt-1 flex items-center gap-1 text-[10.5px]">
          <span style={{ color: delta.good ? '#3D6B42' : '#A0392E' }}>
            {delta.dir === 'up' ? '▲' : '▼'}
          </span>
          <span className="text-secondary">{delta.text}</span>
        </div>
      ) : hint ? (
        <div className="mt-1 text-[10.5px] text-secondary">{hint}</div>
      ) : null}
    </Panel>
  );
}

/** Inset progress meter; `over` switches to the hatched over-cap fill. */
export function Meter({ ratio, over }: { ratio: number; over?: boolean }) {
  const pct = Math.max(0, Math.min(1, ratio)) * 100;
  return (
    <div className="h-2 w-full overflow-hidden rounded-[2px] bg-inset shadow-field">
      <div
        className="h-full rounded-[2px]"
        style={{
          width: `${pct}%`,
          background: over
            ? 'repeating-linear-gradient(135deg,#A0392E 0 4px,#8E2E22 4px 8px)'
            : 'linear-gradient(#4E80B4,#2F5D8C)',
        }}
      />
    </div>
  );
}

/* -------------------------------------------------------------------- states */

export function Spinner() {
  return (
    <div className="flex items-center gap-2 py-8 text-[11.5px] text-secondary">
      <span className="h-3 w-3 animate-spin rounded-full border-2 border-line-card border-t-accent" />
      Loading…
    </div>
  );
}

export function EmptyState({ message }: { message: string }) {
  return <div className="py-10 text-center text-[11.5px] text-micro">{message}</div>;
}

export function ErrorNote({ error }: { error: string }) {
  return (
    <div className="rounded-control border border-err-border bg-err-bg px-3 py-2 text-[11.5px] text-err-text">
      {error}
    </div>
  );
}

/* ---------------------------------------------------------------- grid table */

/** A CSS-grid table row on fixed px tracks + one 1fr — the dense Platinum table
 *  shape (single-line cells). `cols` is a grid-template-columns string. */
export function GridRow({
  cols,
  header,
  selected,
  onClick,
  className,
  children,
}: {
  cols: string;
  header?: boolean;
  selected?: boolean;
  onClick?: () => void;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div
      onClick={onClick}
      style={{ gridTemplateColumns: cols }}
      className={cx(
        'grid items-center gap-2 px-3',
        header
          ? 'border-b border-line bg-rail py-1.5 text-[9px] font-medium uppercase tracking-[0.14em] text-micro'
          : 'border-b border-line-soft py-[7px] text-[11.5px] last:border-0',
        !header && selected && 'bg-accent-tint shadow-selrow',
        !header && !selected && onClick && 'cursor-pointer transition-colors hover:bg-[#F3F0E8]',
        className,
      )}
    >
      {children}
    </div>
  );
}

/** A single-line cell for {@link GridRow}. */
export function Cell({
  children,
  align = 'left',
  mono,
  tone = 'body',
  className,
}: {
  children?: ReactNode;
  align?: 'left' | 'right';
  mono?: boolean;
  tone?: 'ink' | 'body' | 'secondary';
  className?: string;
}) {
  return (
    <div
      className={cx(
        'truncate',
        align === 'right' && 'text-right tabular-nums',
        mono && 'font-mono',
        tone === 'ink' && 'text-ink',
        tone === 'body' && 'text-body',
        tone === 'secondary' && 'text-secondary',
        className,
      )}
    >
      {children}
    </div>
  );
}

/* --------------------------------------------------------------------- table */

export function Table({ children }: { children: ReactNode }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-[11.5px]">{children}</table>
    </div>
  );
}
export function Th({ children, className }: { children?: ReactNode; className?: string }) {
  return (
    <th
      className={cx(
        'border-b border-line bg-rail px-3 py-2 text-left text-[9px] font-medium uppercase tracking-[0.14em] text-micro',
        className,
      )}
    >
      {children}
    </th>
  );
}
export function Td({ children, className }: { children?: ReactNode; className?: string }) {
  return (
    <td className={cx('border-b border-line-soft px-3 py-2 text-body', className)}>{children}</td>
  );
}

/* --------------------------------------------------------------- extras (parity) */

/** 34×16 platinum toggle (design_handoff): on = blue gradient, knob right. */
export function Toggle({
  checked,
  onChange,
  disabled,
  label,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
  label?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cx(
        'relative inline-flex h-4 w-[34px] shrink-0 items-center rounded-full transition-colors duration-[120ms] disabled:opacity-50',
        checked ? 'bg-gradient-to-b from-[#3F6F9E] to-accent' : 'bg-inset shadow-field',
      )}
    >
      <span
        className="absolute h-3 w-3 rounded-full bg-gradient-to-b from-white to-[#DCD6C9] transition-all duration-[120ms]"
        style={{ left: checked ? '18px' : '2px' }}
      />
    </button>
  );
}

/** Underlined tab bar. Keys are the tab ids; active gets the accent underline. */
export function Tabs<T extends string>({
  tabs,
  value,
  onChange,
}: {
  tabs: ReadonlyArray<{ value: T; label: string }>;
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <div className="flex items-center gap-1 border-b border-line">
      {tabs.map((t) => {
        const active = t.value === value;
        return (
          <button
            key={t.value}
            type="button"
            onClick={() => onChange(t.value)}
            className={cx(
              '-mb-px border-b-2 px-2.5 py-2 text-[11.5px] font-medium transition-colors',
              active
                ? 'border-accent text-ink'
                : 'border-transparent text-secondary hover:text-ink',
            )}
          >
            {t.label}
          </button>
        );
      })}
    </div>
  );
}

/** Copy-to-clipboard button with a transient "copied" state. */
export function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <Button
      onClick={() => {
        void navigator.clipboard?.writeText(text);
        setDone(true);
        window.setTimeout(() => setDone(false), 1200);
      }}
    >
      {done ? 'Copied ✓' : label}
    </Button>
  );
}

/** Monospace code / JSON block on the inset surface (optionally the terminal palette). */
export function CodeBlock({
  children,
  terminal,
  className,
}: {
  children: ReactNode;
  terminal?: boolean;
  className?: string;
}) {
  return (
    <pre
      className={cx(
        'overflow-x-auto rounded-control border px-3 py-2.5 font-mono text-[10.5px] leading-[1.6]',
        terminal
          ? 'border-term-border bg-term-bg text-term-text'
          : 'border-line-soft bg-inset text-body',
        className,
      )}
    >
      {children}
    </pre>
  );
}

/** A pretty-printed JSON viewer. */
export function JsonBlock({ value, terminal }: { value: unknown; terminal?: boolean }) {
  return <CodeBlock terminal={terminal}>{JSON.stringify(value, null, 2)}</CodeBlock>;
}

/** An inline result strip (success / error / info) — never a toast. */
export function InlineResult({
  tone,
  children,
}: {
  tone: 'ok' | 'err' | 'info';
  children: ReactNode;
}) {
  const styles =
    tone === 'ok'
      ? 'border-ok-border bg-ok-bg text-ok-text'
      : tone === 'err'
        ? 'border-err-border bg-err-bg text-err-text'
        : 'border-accent-soft bg-accent-tint text-accent-ink';
  return (
    <div
      className={cx(
        'flex items-center gap-2 rounded-control border px-2.5 py-1.5 text-[11px]',
        styles,
      )}
    >
      <Dot tone={tone === 'ok' ? 'green' : tone === 'err' ? 'red' : 'green'} />
      {children}
    </div>
  );
}

/** A labelled key/value row (mono value) for detail lists. */
export function KV({
  label,
  value,
  mono = true,
}: {
  label: ReactNode;
  value: ReactNode;
  mono?: boolean;
}) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-line-soft py-1.5 last:border-0">
      <span className="text-[10.5px] text-micro">{label}</span>
      <span
        className={cx(
          'break-all text-right text-[11px] text-ink',
          mono && 'font-mono text-[10.5px]',
        )}
      >
        {value}
      </span>
    </div>
  );
}
