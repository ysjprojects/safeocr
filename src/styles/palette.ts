/**
 * The one place colours are defined; `theme.extend.colors` in tailwind.config.ts reads `colors`.
 *
 * Surfaces are a deep plum (950 inset → 900 page → 800 panels → 700/600 borders), the accent is a
 * candy pink used for primary actions and progress, and `cream` is the body text colour. Status
 * colours (emerald ok, amber warning, rose failure) are Tailwind's defaults.
 */

export const plum = {
  950: '#0d0517',
  900: '#150826',
  800: '#1f0d38',
  700: '#2b144d',
  600: '#3a1d68',
  500: '#4f2a8c',
  400: '#7a4fc7',
  300: '#a78bfa',
  200: '#d6c6f5',
} as const;

export const candy = {
  200: '#ffd4ee',
  300: '#ffb0dc',
  400: '#ff7ac8',
  500: '#ff3fa6',
  600: '#e6208c',
  700: '#b8146d',
} as const;

export const cream = '#fbf6ff';

export const colors = {plum, candy, cream} as const;
