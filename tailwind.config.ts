import forms from '@tailwindcss/forms';
import typography from '@tailwindcss/typography';
import type {Config} from 'tailwindcss';

import {colors} from './src/styles/palette';

export default {
  content: ['./src/**/*.{ts,tsx,scss}'],
  theme: {
    extend: {
      colors,
      fontFamily: {
        code: ['var(--font-code)', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
      screens: {
        touch: {raw: 'only screen and (pointer: coarse)'},
      },
    },
  },
  plugins: [forms, typography],
} satisfies Config;
