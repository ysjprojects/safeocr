/**
 * The one place colours are defined. `tailwind.config.ts` turns `latte` and `mocha` into CSS custom
 * properties (`:root` is light, `.dark` is dark) and exposes every shade as a Tailwind colour that
 * reads them, so one set of class names (`bg-base`, `text-subtext0`, `border-surface1`, `bg-blue/10`)
 * renders correctly in either theme. The `dark` class is managed by lib/theme.ts.
 *
 * The palettes are Catppuccin Latte (light) and Mocha (dark), verbatim from
 * https://github.com/catppuccin/palette (v1.8.0). Roles used by the UI:
 *
 * - `base` is the page, `mantle` the chrome (header, toolbar, rail, status bar), `crust` the image
 *   stage behind page previews.
 * - `surface0`–`surface2` are borders and hover fills, `overlay0`–`overlay2` muted marks (idle dots,
 *   placeholders), `subtext0`/`subtext1` secondary text, `text` body text.
 * - `blue` is the accent (primary actions, selection, running); `green` done, `red` failed,
 *   `yellow` warnings and stopped runs. The other accents are available but unused.
 */

export const SHADES = [
  'rosewater',
  'flamingo',
  'pink',
  'mauve',
  'red',
  'maroon',
  'peach',
  'yellow',
  'green',
  'teal',
  'sky',
  'sapphire',
  'blue',
  'lavender',
  'text',
  'subtext1',
  'subtext0',
  'overlay2',
  'overlay1',
  'overlay0',
  'surface2',
  'surface1',
  'surface0',
  'base',
  'mantle',
  'crust',
] as const;

export type Shade = (typeof SHADES)[number];

export type Flavor = Record<Shade, string>;

export const latte: Flavor = {
  rosewater: '#dc8a78',
  flamingo: '#dd7878',
  pink: '#ea76cb',
  mauve: '#8839ef',
  red: '#d20f39',
  maroon: '#e64553',
  peach: '#fe640b',
  yellow: '#df8e1d',
  green: '#40a02b',
  teal: '#179299',
  sky: '#04a5e5',
  sapphire: '#209fb5',
  blue: '#1e66f5',
  lavender: '#7287fd',
  text: '#4c4f69',
  subtext1: '#5c5f77',
  subtext0: '#6c6f85',
  overlay2: '#7c7f93',
  overlay1: '#8c8fa1',
  overlay0: '#9ca0b0',
  surface2: '#acb0be',
  surface1: '#bcc0cc',
  surface0: '#ccd0da',
  base: '#eff1f5',
  mantle: '#e6e9ef',
  crust: '#dce0e8',
};

export const mocha: Flavor = {
  rosewater: '#f5e0dc',
  flamingo: '#f2cdcd',
  pink: '#f5c2e7',
  mauve: '#cba6f7',
  red: '#f38ba8',
  maroon: '#eba0ac',
  peach: '#fab387',
  yellow: '#f9e2af',
  green: '#a6e3a1',
  teal: '#94e2d5',
  sky: '#89dceb',
  sapphire: '#74c7ec',
  blue: '#89b4fa',
  lavender: '#b4befe',
  text: '#cdd6f4',
  subtext1: '#bac2de',
  subtext0: '#a6adc8',
  overlay2: '#9399b2',
  overlay1: '#7f849c',
  overlay0: '#6c7086',
  surface2: '#585b70',
  surface1: '#45475a',
  surface0: '#313244',
  base: '#1e1e2e',
  mantle: '#181825',
  crust: '#11111b',
};

/** Tailwind colours: each shade reads its variable, with `<alpha-value>` so `bg-blue/10` keeps working. */
export const colors = Object.fromEntries(
  SHADES.map(shade => [shade, `rgb(var(--ctp-${shade}) / <alpha-value>)`]),
) as Record<Shade, string>;

/** The custom properties of one flavour: `--ctp-<shade>: r g b`, the form the colours above read. */
export function cssVariables(flavor: Flavor): Record<string, string> {
  const variables: Record<string, string> = {};
  for (const shade of SHADES) {
    const hex = flavor[shade];
    variables[`--ctp-${shade}`] = [1, 3, 5].map(at => parseInt(hex.slice(at, at + 2), 16)).join(' ');
  }
  return variables;
}
