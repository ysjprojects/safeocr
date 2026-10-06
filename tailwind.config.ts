import forms from '@tailwindcss/forms';
import typography from '@tailwindcss/typography';
import type {Config} from 'tailwindcss';
import defaultTheme from 'tailwindcss/defaultTheme';
import plugin from 'tailwindcss/plugin';

import {colors, cssVariables, latte, mocha} from './src/styles/palette';

/** A palette shade as a plain `rgb()` for places that cannot take Tailwind's `<alpha-value>`. */
const ctp = (shade: keyof typeof colors): string => `rgb(var(--ctp-${shade}))`;

// The palette has a `base` colour, so Tailwind's `text-base` would set both a 16px size and that
// colour (the colour wins: text painted in the background). The 16px step is `text-md` here, which
// leaves `text-base` meaning the colour only.
const {base: md, ...fontSize} = defaultTheme.fontSize;

export default {
  content: ['./src/**/*.{ts,tsx,scss}'],
  darkMode: 'class',
  theme: {
    fontSize: {...fontSize, md},
    extend: {
      colors,
      // The variables come from next/font on the app wrapper. A `var()` without a fallback makes the
      // whole declaration invalid when the variable is absent (preflight sets this on <html>, outside
      // the wrapper), which lands on the browser's serif default: the fallbacks keep it sans/mono.
      fontFamily: {
        sans: ['var(--font-sans, system-ui)', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        code: ['var(--font-code, ui-monospace)', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
      screens: {
        touch: {raw: 'only screen and (pointer: coarse)'},
      },
      // `prose-ctp`: rendered OCR output in palette colours; the variables flip with the theme, so
      // there is no separate inverted set.
      typography: {
        ctp: {
          css: {
            '--tw-prose-body': ctp('text'),
            '--tw-prose-headings': ctp('text'),
            '--tw-prose-lead': ctp('subtext1'),
            '--tw-prose-links': ctp('blue'),
            '--tw-prose-bold': ctp('text'),
            '--tw-prose-counters': ctp('subtext0'),
            '--tw-prose-bullets': ctp('overlay1'),
            '--tw-prose-hr': ctp('surface1'),
            '--tw-prose-quotes': ctp('subtext1'),
            '--tw-prose-quote-borders': ctp('surface2'),
            '--tw-prose-captions': ctp('subtext0'),
            '--tw-prose-kbd': ctp('text'),
            '--tw-prose-kbd-shadows': 'rgb(var(--ctp-text) / 0.1)',
            '--tw-prose-code': ctp('text'),
            '--tw-prose-pre-code': ctp('text'),
            '--tw-prose-pre-bg': ctp('mantle'),
            '--tw-prose-th-borders': ctp('surface2'),
            '--tw-prose-td-borders': ctp('surface1'),
          },
        },
      },
    },
  },
  plugins: [
    forms,
    typography,
    // The two Catppuccin flavours as custom properties; `color-scheme` keeps native controls and
    // scrollbars in step.
    plugin(({addBase}) => {
      addBase({
        ':root': {colorScheme: 'light', ...cssVariables(latte)},
        '.dark': {colorScheme: 'dark', ...cssVariables(mocha)},
      });
    }),
  ],
} satisfies Config;
