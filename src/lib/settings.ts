/**
 * Per-user settings, kept in this browser's localStorage under one key: everything a visitor would
 * otherwise have to redo on each visit. Reads are validated field by field, so a stale or hand-
 * edited value falls back to its default instead of breaking the page; nothing is written until
 * the user changes something.
 */
import {useCallback, useEffect, useRef, useState} from 'react';

import {type Detail, type Engine, type Mode, DETAILS, MODES} from './protocol';

export type ThemeSetting = 'system' | 'light' | 'dark';

export const THEME_SETTINGS: ThemeSetting[] = ['system', 'light', 'dark'];

export interface Settings {
  theme: ThemeSetting;
  /** `null` until the user picks one; the app then chooses by WebGPU support. */
  engine: Engine | null;
  mode: Mode;
  detail: Detail;
  /** Whether the scan is shown beside the recognised text. */
  sourceShown: boolean;
  /** Load the engine as soon as the page opens, so the first run does not wait for it. */
  autoLoad: boolean;
  /** Keep files and results in this browser (IndexedDB) so a reload can pick up where it left off. */
  keepSession: boolean;
}

export const SETTINGS_KEY = 'safeocr-settings';

export const DEFAULT_SETTINGS: Settings = {
  theme: 'system',
  engine: null,
  mode: 'text',
  detail: 'standard',
  sourceShown: true,
  autoLoad: false,
  keepSession: true,
};

const oneOf = <T extends string>(allowed: readonly T[], value: unknown, fallback: T): T =>
  allowed.includes(value as T) ? (value as T) : fallback;

export function readSettings(): Settings {
  let stored: unknown = null;
  try {
    stored = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? 'null');
  } catch {
    // No storage, or not JSON: defaults.
  }
  const s: Record<string, unknown> =
    typeof stored === 'object' && stored !== null ? (stored as Record<string, unknown>) : {};
  return {
    theme: oneOf(THEME_SETTINGS, s.theme, DEFAULT_SETTINGS.theme),
    engine: s.engine === 'glm' || s.engine === 'paddle6' || s.engine === 'paddle' ? s.engine : DEFAULT_SETTINGS.engine,
    mode: oneOf(MODES, s.mode, DEFAULT_SETTINGS.mode),
    detail: oneOf(DETAILS, s.detail, DEFAULT_SETTINGS.detail),
    sourceShown: typeof s.sourceShown === 'boolean' ? s.sourceShown : DEFAULT_SETTINGS.sourceShown,
    autoLoad: typeof s.autoLoad === 'boolean' ? s.autoLoad : DEFAULT_SETTINGS.autoLoad,
    keepSession: typeof s.keepSession === 'boolean' ? s.keepSession : DEFAULT_SETTINGS.keepSession,
  };
}

export function useSettings(): [Settings, (patch: Partial<Settings>) => void] {
  const [settings, setSettings] = useState(readSettings);
  const changed = useRef(false);

  useEffect(() => {
    if (!changed.current) return;
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    } catch {
      // Storage unavailable (private mode, quota): the settings still hold for this page.
    }
  }, [settings]);

  const update = useCallback((patch: Partial<Settings>) => {
    changed.current = true;
    setSettings(s => ({...s, ...patch}));
  }, []);

  return [settings, update];
}
