import {type ChangeEvent, type DragEvent, type FC, memo, useCallback, useEffect, useRef, useState} from 'react';

import {ACCEPT} from '@/lib/inputs';

interface Props {
  onFiles(files: File[]): void;
  compact: boolean;
}

/**
 * Drag-and-drop, click-to-browse (multiple files) and paste (images from the clipboard, e.g. a
 * screenshot). Everything stays in this tab: nothing is uploaded anywhere.
 */
const Dropzone: FC<Props> = memo(({onFiles, compact}) => {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [over, setOver] = useState(false);

  const browse = useCallback(() => inputRef.current?.click(), []);
  const onChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(event.target.files ?? []);
      event.target.value = '';
      if (files.length > 0) onFiles(files);
    },
    [onFiles],
  );
  const onDragOver = useCallback((event: DragEvent) => {
    event.preventDefault();
    setOver(true);
  }, []);
  const onDragLeave = useCallback(() => setOver(false), []);
  const onDrop = useCallback(
    (event: DragEvent) => {
      event.preventDefault();
      setOver(false);
      const files = Array.from(event.dataTransfer.files);
      if (files.length > 0) onFiles(files);
    },
    [onFiles],
  );

  useEffect(() => {
    const onPaste = (event: ClipboardEvent) => {
      const items = Array.from(event.clipboardData?.items ?? []);
      const files: File[] = [];
      for (const item of items) {
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

  return (
    <div
      className={`flex flex-col items-center justify-center rounded-xl border-2 border-dashed text-center transition ${
        compact ? 'gap-1 px-3 py-3' : 'gap-2 px-4 py-8'
      } ${over ? 'border-candy-400 bg-candy-500/10' : 'border-plum-500/70 bg-plum-950/40 hover:border-candy-500/60'}`}
      onDragLeave={onDragLeave}
      onDragOver={onDragOver}
      onDrop={onDrop}>
      <input accept={ACCEPT} className="hidden" multiple onChange={onChange} ref={inputRef} type="file" />
      <p className={`text-cream font-semibold ${compact ? 'text-[12px]' : 'text-[14px]'}`}>
        Drop images or PDFs here,{' '}
        <button
          className="text-candy-300 decoration-candy-500/50 hover:text-candy-200 underline"
          onClick={browse}
          type="button">
          browse
        </button>
        , or paste a screenshot
      </p>
      <p className="text-plum-300 text-[11px]">
        PNG, JPEG, WebP, GIF, BMP, AVIF (plus whatever your browser decodes) and multi-page PDF. One file or a whole
        batch. Files never leave this tab.
      </p>
    </div>
  );
});
Dropzone.displayName = 'Dropzone';

export default Dropzone;
