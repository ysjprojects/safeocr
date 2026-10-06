/**
 * Light / dark theme. The palette (styles/palette.ts) is Catppuccin Latte by default and Mocha when
 * `<html>` carries the `dark` class. The `theme` setting (lib/settings.ts) is `system`, `light` or
 * `dark`; `system` tracks the OS preference live.
 */
import {useEffect} from 'react';

import {type ThemeSetting, SETTINGS_KEY} from './settings';

const DARK_QUERY = '(prefers-color-scheme: dark)';

/**
 * Inline script for `_document.tsx`: sets the class before the first paint so a dark-mode visitor
 * never sees a light flash. Self-contained on purpose: it runs before any module does.
 */
export const THEME_BOOT_SCRIPT =
  `(function(){try{var t=JSON.parse(localStorage.getItem('${SETTINGS_KEY}')||'{}').theme;` +
  `if(t!=='light'&&t!=='dark')t=matchMedia('${DARK_QUERY}').matches?'dark':'light';` +
  `if(t==='dark')document.documentElement.classList.add('dark')}catch(e){}})()`;

/** Keeps `<html class="dark">` in step with the setting (and with the OS while it is `system`). */
export function useTheme(setting: ThemeSetting): void {
  useEffect(() => {
    const query = matchMedia(DARK_QUERY);
    const apply = () => {
      document.documentElement.classList.toggle('dark', setting === 'dark' || (setting === 'system' && query.matches));
    };
    apply();
    if (setting !== 'system') return;
    query.addEventListener('change', apply);
    return () => query.removeEventListener('change', apply);
  }, [setting]);
}
