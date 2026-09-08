import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Cell, GridRow, InlineResult, Meter, StatTile, StatusChip, StatusPill, Toggle } from './ui';

describe('ui primitives', () => {
  it('StatusChip renders its children and a tone border class', () => {
    const { container } = render(<StatusChip tone="green">healthy</StatusChip>);
    expect(screen.getByText('healthy')).toBeInTheDocument();
    expect(container.firstChild).toHaveClass('bg-ok-bg');
  });

  it('StatusPill maps a <400 code to green and an error to red', () => {
    const ok = render(<StatusPill status="ok" code={200} />);
    expect(ok.container.querySelector('.bg-ok-bg')).toBeTruthy();
    const err = render(<StatusPill status="error" code={500} />);
    expect(err.container.querySelector('.bg-err-bg')).toBeTruthy();
  });

  it('Toggle fires onChange with the negated value', () => {
    const onChange = vi.fn();
    render(<Toggle checked={false} onChange={onChange} label="mute" />);
    fireEvent.click(screen.getByRole('switch'));
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it('Meter clamps the fill width to [0,100]%', () => {
    const { container } = render(<Meter ratio={2} />);
    const fill = container.querySelector('.h-full') as HTMLElement;
    // jsdom's CSSOM drops gradient values, so assert on the raw style React wrote.
    expect(fill.getAttribute('style')).toContain('width: 100%');
  });

  it('Meter over-cap uses the hatched fill', () => {
    const { container } = render(<Meter ratio={1} over />);
    const fill = container.querySelector('.h-full') as HTMLElement;
    expect(fill.getAttribute('style')).toContain('repeating-linear-gradient');
  });

  it('StatTile shows label, value, and a delta arrow', () => {
    render(
      <StatTile label="Spend" value="$12.00" delta={{ dir: 'up', text: '5% up', good: false }} />,
    );
    expect(screen.getByText('Spend')).toBeInTheDocument();
    expect(screen.getByText('$12.00')).toBeInTheDocument();
    expect(screen.getByText('▲')).toBeInTheDocument();
  });

  it('GridRow + Cell render a header row with the right classes', () => {
    const { container } = render(
      <GridRow cols="1fr 1fr" header>
        <Cell>A</Cell>
        <Cell align="right">B</Cell>
      </GridRow>,
    );
    expect(container.firstChild).toHaveClass('bg-rail');
    expect(screen.getByText('B')).toHaveClass('text-right');
  });

  it('InlineResult renders the tone-appropriate strip', () => {
    const { container } = render(<InlineResult tone="err">nope</InlineResult>);
    expect(container.firstChild).toHaveClass('bg-err-bg');
    expect(screen.getByText('nope')).toBeInTheDocument();
  });
});
