import {
  type ChangeEvent,
  type DragEvent,
  type FC,
  type ReactNode,
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import {ACCEPT} from '@/lib/inputs';

import Icon from './icons';

type OnFiles = (files: File[]) => void;

/**
 * Drag-and-drop over the whole app and paste (images from the clipboard, e.g. a screenshot).
 * Spread `handlers` on the root element; `dragging` is true while files hover over it.
 * Everything stays in this tab: nothing is uploaded anywhere.
 */
export function useFileDrop(onFiles: OnFiles) {
  const [dragging, setDragging] = useState(false);
  // dragenter/dragleave fire for every child crossed; the overlay shows while the depth is > 0.
  const depth = useRef(0);

  const onDragEnter = useCallback((event: DragEvent) => {
    if (!event.dataTransfer.types.includes('Files')) return;
    event.preventDefault();
    depth.current += 1;
    setDragging(true);
  }, []);
  const onDragOver = useCallback((event: DragEvent) => {
    if (!event.dataTransfer.types.includes('Files')) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
  }, []);
  const onDragLeave = useCallback(() => {
    depth.current = Math.max(0, depth.current - 1);
    if (depth.current === 0) setDragging(false);
  }, []);
  const onDrop = useCallback(
    (event: DragEvent) => {
      event.preventDefault();
      depth.current = 0;
      setDragging(false);
      const files = Array.from(event.dataTransfer.files);
      if (files.length > 0) onFiles(files);
    },
    [onFiles],
  );

  useEffect(() => {
    const onPaste = (event: ClipboardEvent) => {
      const files: File[] = [];
      for (const item of Array.from(event.clipboardData?.items ?? [])) {
        if (item.kind !== 'file') continue;
        const file = item.getAsFile();
        if (file === null) continue;
        // Clipboard images arrive as "image.png"; give each a distinct, dated name.
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        files.push(
          file.name && file.name !== 'image.png' ? file : new File([file], `clipboard-${stamp}.png`, {type: file.type}),
        );
      }
      if (files.length === 0) return;
      event.preventDefault();
      onFiles(files);
    };
    document.addEventListener('paste', onPaste);
    return () => document.removeEventListener('paste', onPaste);
  }, [onFiles]);

  const handlers = useMemo(
    () => ({onDragEnter, onDragOver, onDragLeave, onDrop}),
    [onDragEnter, onDragOver, onDragLeave, onDrop],
  );
  return {dragging, handlers};
}

/** A button that opens the file picker (multiple files; images and PDFs). */
export const FilePicker: FC<{onFiles: OnFiles; className: string; title?: string; children: ReactNode}> = memo(
  ({onFiles, className, title, children}) => {
    const inputRef = useRef<HTMLInputElement | null>(null);
    const browse = useCallback(() => inputRef.current?.click(), []);
    const onChange = useCallback(
      (event: ChangeEvent<HTMLInputElement>) => {
        const files = Array.from(event.target.files ?? []);
        event.target.value = '';
        if (files.length > 0) onFiles(files);
      },
      [onFiles],
    );
    return (
      <>
        <input accept={ACCEPT} className="hidden" multiple onChange={onChange} ref={inputRef} type="file" />
        <button className={className} onClick={browse} title={title} type="button">
          {children}
        </button>
      </>
    );
  },
);
FilePicker.displayName = 'FilePicker';

/** The empty-state hero: a large target that explains the three ways in. */
export const DropHero: FC<{onFiles: OnFiles; active: boolean}> = memo(({onFiles, active}) => (
  <FilePicker
    className={`flex w-full flex-col items-center gap-3 rounded-2xl border-2 border-dashed px-6 py-12 text-center transition ${
      active ? 'border-blue bg-blue/10' : 'border-surface2 bg-mantle hover:border-blue/60 hover:bg-surface0/40'
    }`}
    onFiles={onFiles}>
    <span className="bg-blue/10 text-blue flex h-14 w-14 items-center justify-center rounded-full">
      <Icon className="h-7 w-7" name="upload" />
    </span>
    <span className="text-text text-lg font-semibold">Drop images or PDFs here</span>
    <span className="text-subtext0 text-sm">
      <span className="touch:hidden">or </span>
      <span className="text-blue font-medium underline underline-offset-2">
        <span className="touch:hidden">browse your files</span>
        <span className="touch:inline hidden">Choose photos or files</span>
      </span>
      <span className="touch:hidden">, or paste a screenshot with ⌘V / Ctrl+V</span>
    </span>
    <span className="text-subtext0 text-xs">
      PNG, JPEG, WebP, GIF, BMP, AVIF and multi-page PDF · one file or a whole batch · nothing leaves this tab
    </span>
  </FilePicker>
));
DropHero.displayName = 'DropHero';

/** Full-window cue while files are dragged over the app. */
export const DropOverlay: FC<{active: boolean}> = memo(({active}) =>
  active ? (
    <div className="bg-base/80 pointer-events-none fixed inset-0 z-50 flex items-center justify-center p-6 backdrop-blur-sm">
      <div className="border-blue bg-blue/10 text-blue flex flex-col items-center gap-2 rounded-2xl border-2 border-dashed px-12 py-10">
        <Icon className="h-8 w-8" name="upload" />
        <span className="text-md font-semibold">Drop to add files</span>
      </div>
    </div>
  ) : null,
);
DropOverlay.displayName = 'DropOverlay';
