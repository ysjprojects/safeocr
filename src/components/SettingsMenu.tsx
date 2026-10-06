import {type ChangeEvent, type FC, memo, useCallback, useEffect, useRef, useState} from 'react';

import {storageUsage} from '@/lib/assets';
import {type Engine, ENGINE_LABEL} from '@/lib/protocol';
import {type Settings, type ThemeSetting, DEFAULT_SETTINGS, THEME_SETTINGS} from '@/lib/settings';

import ConfirmDialog from './ConfirmDialog';
import Icon from './icons';
import {formatBytes, ghostButtonClass, iconButtonClass, secondaryButtonClass} from './paneShared';

interface Props {
  onChange(patch: Partial<Settings>): void;
  /** Removes the downloaded models from the browser and unloads the engines. */
  onDeleteModels(): Promise<void>;
  settings: Settings;
  /** The engine in effect, which "load on open" refers to. */
  engine: Engine;
}

const THEME_LABEL: Record<ThemeSetting, string> = {system: 'System', light: 'Light', dark: 'Dark'};

/** The per-user settings behind the gear: theme, engine preloading, and what the app stores on this device. */
const SettingsMenu: FC<Props> = memo(({settings, engine, onChange, onDeleteModels}) => {
  const [open, setOpen] = useState(false);
  const [usage, setUsage] = useState<number | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const root = useRef<HTMLDivElement | null>(null);

  const toggle = useCallback(() => setOpen(v => !v), []);
  const close = useCallback(() => setOpen(false), []);

  // Outside click or Escape closes the panel.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (root.current !== null && !root.current.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  // The storage figure is read when the panel opens and again after a deletion.
  useEffect(() => {
    if (!open || deleting) return;
    let live = true;
    storageUsage().then(bytes => {
      if (live) setUsage(bytes);
    });
    return () => {
      live = false;
    };
  }, [open, deleting]);

  const onAutoLoad = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => onChange({autoLoad: event.target.checked}),
    [onChange],
  );
  const onKeepSession = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => onChange({keepSession: event.target.checked}),
    [onChange],
  );
  const reset = useCallback(() => onChange(DEFAULT_SETTINGS), [onChange]);
  const askDelete = useCallback(() => setConfirmDelete(true), []);
  const cancelDelete = useCallback(() => setConfirmDelete(false), []);
  const confirmDeletion = useCallback(async () => {
    setConfirmDelete(false);
    setDeleting(true);
    try {
      await onDeleteModels();
    } finally {
      setDeleting(false);
    }
  }, [onDeleteModels]);

  return (
    <div className="relative" ref={root}>
      <button
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label="Settings"
        className={`${iconButtonClass} ${open ? 'bg-surface0 text-text' : ''}`}
        onClick={toggle}
        title="Settings"
        type="button">
        <Icon name="settings" />
      </button>
      {open ? (
        <div
          aria-label="Settings"
          className="border-surface1 bg-base absolute right-0 top-full z-40 mt-2 flex w-[min(20rem,calc(100vw-2rem))] flex-col gap-4 rounded-xl border p-4 shadow-xl"
          role="dialog">
          <div className="flex items-center justify-between">
            <span className="text-text text-sm font-semibold">Settings</span>
            <button aria-label="Close" className={iconButtonClass} onClick={close} type="button">
              <Icon className="h-3.5 w-3.5" name="x" />
            </button>
          </div>

          <div className="flex flex-col gap-1.5">
            <span className="text-subtext0 text-xs">Theme</span>
            <div
              aria-label="Theme"
              className="border-surface1 bg-mantle flex rounded-md border p-0.5"
              role="radiogroup">
              {THEME_SETTINGS.map(t => (
                <ThemeOption key={t} onChange={onChange} selected={settings.theme === t} value={t} />
              ))}
            </div>
          </div>

          <label className="flex cursor-pointer items-start gap-2.5">
            <input
              checked={settings.autoLoad}
              className="border-surface2 text-blue focus:ring-blue/40 bg-mantle mt-0.5 h-4 w-4 rounded"
              onChange={onAutoLoad}
              type="checkbox"
            />
            <span className="flex flex-col gap-0.5">
              <span className="text-text text-xs font-medium">Load {ENGINE_LABEL[engine]} when SafeOCR opens</span>
              <span className="text-subtext0 text-[11px] leading-relaxed">
                Skips the wait before the first run on later visits. The first time still downloads the model.
              </span>
            </span>
          </label>

          <label className="flex cursor-pointer items-start gap-2.5">
            <input
              checked={settings.keepSession}
              className="border-surface2 text-blue focus:ring-blue/40 bg-mantle mt-0.5 h-4 w-4 rounded"
              onChange={onKeepSession}
              type="checkbox"
            />
            <span className="flex flex-col gap-0.5">
              <span className="text-text text-xs font-medium">Keep my files and results between visits</span>
              <span className="text-subtext0 text-[11px] leading-relaxed">
                Saved in this browser only, so a reload can pick up where you left off. Switching it off removes what is
                saved.
              </span>
            </span>
          </label>

          <div className="flex flex-col gap-1.5">
            <span className="text-subtext0 text-xs">On this device</span>
            <div className="border-surface0 bg-mantle flex items-center justify-between gap-2 rounded-lg border px-3 py-2">
              <span className="text-subtext1 text-xs">
                {usage === null ? 'Storage use unknown' : `≈ ${formatBytes(usage)} stored`}
                <span className="text-subtext0 block text-[11px]">downloaded models, settings</span>
              </span>
              <button className={secondaryButtonClass} disabled={deleting} onClick={askDelete} type="button">
                {deleting ? 'Deleting…' : 'Delete models'}
              </button>
            </div>
          </div>

          <p className="text-subtext0 text-[11px] leading-relaxed">
            Engine, output and detail are remembered as you change them. Everything stays in this browser. Once opened,
            the app and any downloaded engine also work offline.
          </p>
          <div className="-mb-1 -ml-2">
            <button className={ghostButtonClass} onClick={reset} type="button">
              Reset to defaults
            </button>
          </div>
        </div>
      ) : null}

      <ConfirmDialog
        confirmLabel="Delete models"
        onCancel={cancelDelete}
        onConfirm={confirmDeletion}
        open={confirmDelete}
        title="Delete downloaded models?">
        The GLM-OCR and PP-OCR files are removed from this browser and the engines are unloaded. Any run in progress
        stops. The next run downloads what it needs again.
      </ConfirmDialog>
    </div>
  );
});
SettingsMenu.displayName = 'SettingsMenu';

const ThemeOption: FC<{onChange(patch: Partial<Settings>): void; value: ThemeSetting; selected: boolean}> = memo(
  ({value, selected, onChange}) => {
    const select = useCallback(() => onChange({theme: value}), [onChange, value]);
    return (
      <button
        aria-checked={selected}
        className={`flex-1 rounded px-2 py-1 text-xs font-semibold transition ${
          selected ? 'bg-surface0 text-text shadow-sm' : 'text-subtext0 hover:text-text'
        }`}
        onClick={select}
        role="radio"
        type="button">
        {THEME_LABEL[value]}
      </button>
    );
  },
);
ThemeOption.displayName = 'ThemeOption';

export default SettingsMenu;
