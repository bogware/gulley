import type { Config } from 'tailwindcss';

/**
 * The "Platinum" design system — a dense early-Apple/Snow-White industrial palette:
 * warm platinum greys, hairline 1px borders, 3–4px radii, IBM Plex type. Light-only by
 * intent (`darkMode: 'class'` with no `.dark` root ever added neutralises legacy `dark:`
 * variants). Tokens are lifted verbatim from design_handoff_gulley_console.
 */
export default {
  content: ['./app/**/*.{ts,tsx}', './components/**/*.{ts,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        canvas: '#F5F3EE',
        panel: '#FCFBF8',
        sidebar: '#E1DCD1',
        inset: '#F7F5EF',
        rail: '#EFEBE2',
        header: '#FAF8F3',
        ink: '#1B1A17',
        body: '#3E3A32',
        secondary: '#5F594D',
        micro: '#615B4F',
        line: {
          DEFAULT: '#E2DCD1',
          soft: '#F0ECE4',
          card: '#C9C2B4',
          control: '#B4AD9E',
        },
        accent: {
          DEFAULT: '#2F5D8C',
          soft: '#7FA2C4',
          tint: '#E7EEF5',
          ink: '#1B3F63',
        },
        ok: { text: '#2F5A34', bg: '#E3EFE1', border: '#A8C3A6', dot: '#4B7A4E' },
        warn: { text: '#8A5E17', bg: '#F7EDD8', border: '#DCC08A', dot: '#C67A28' },
        err: { text: '#8E2E22', bg: '#F6E4E0', border: '#D2A79F', dot: '#A0392E' },
        term: {
          bg: '#1B1A17',
          head: '#22201C',
          border: '#4B463C',
          text: '#C9C2B4',
          label: '#A29A88',
        },
        series: {
          anthropic: '#2F5D8C',
          openai: '#7FA2C4',
          bedrock: '#4B7A4E',
          vertex: '#C67A28',
          azure: '#6B4A7A',
        },
      },
      fontFamily: {
        sans: ['var(--font-plex-sans)', '"Helvetica Neue"', 'Arial', 'sans-serif'],
        mono: ['var(--font-plex-mono)', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
      fontSize: {
        // NB: no `micro` key here — `micro` is a color token, and a same-named fontSize
        // would make `text-micro` ambiguous. Use `text-[9px]` for the micro-label size.
        '2xs': ['10px', { lineHeight: '1.35' }],
        xs2: ['10.5px', { lineHeight: '1.4' }],
        data: ['11.5px', { lineHeight: '1.45' }],
      },
      borderRadius: {
        card: '4px',
        control: '3px',
        chip: '2px',
        win: '7px',
      },
      boxShadow: {
        raise: 'inset 0 1px 0 #ffffff',
        field: 'inset 0 1px 2px rgba(27,26,23,0.12)',
        drawer: '-8px 0 18px -14px rgba(40,36,28,0.4)',
        selrow: 'inset 3px 0 0 #2F5D8C',
      },
    },
  },
  plugins: [],
} satisfies Config;
