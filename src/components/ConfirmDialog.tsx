import {type FC, type MouseEvent, type ReactNode, memo, useCallback, useEffect, useId, useRef} from 'react';

import {primaryButtonClass, secondaryButtonClass} from './paneShared';

interface Props {
  onConfirm(): void;
  onCancel(): void;
  open: boolean;
  title: string;
  confirmLabel: string;
  children: ReactNode;
}

/**
 * A modal yes/no prompt on the native <dialog>, which brings the focus trap, Escape and the
 * backdrop with it. Cancel is the first button so it takes the initial focus: Enter is safe.
 */
const ConfirmDialog: FC<Props> = memo(({open, title, confirmLabel, onConfirm, onCancel, children}) => {
  const ref = useRef<HTMLDialogElement | null>(null);
  const titleId = useId();

  useEffect(() => {
    const dialog = ref.current;
    if (dialog === null) return;
    if (open && !dialog.open) dialog.showModal();
    else if (!open && dialog.open) dialog.close();
  }, [open]);

  // A click on the backdrop lands on the dialog element itself; the panel inside swallows the rest.
  const onBackdropClick = useCallback(
    (event: MouseEvent<HTMLDialogElement>) => {
      if (event.target === event.currentTarget) onCancel();
    },
    [onCancel],
  );
  const onNativeCancel = useCallback(
    (event: {preventDefault(): void}) => {
      event.preventDefault();
      onCancel();
    },
    [onCancel],
  );

  return (
    <dialog
      aria-labelledby={titleId}
      className="bg-base text-text border-surface1 backdrop:bg-crust/70 w-[calc(100%-2rem)] max-w-md rounded-xl border p-0 shadow-2xl backdrop:backdrop-blur-sm"
      onCancel={onNativeCancel}
      onClick={onBackdropClick}
      ref={ref}>
      <div className="flex flex-col gap-3 p-5">
        <h2 className="text-text text-sm font-semibold" id={titleId}>
          {title}
        </h2>
        <div className="text-subtext1 text-xs leading-relaxed">{children}</div>
        <div className="mt-1 flex justify-end gap-2">
          <button className={secondaryButtonClass} onClick={onCancel} type="button">
            Cancel
          </button>
          <button className={primaryButtonClass} onClick={onConfirm} type="button">
            {confirmLabel}
          </button>
        </div>
      </div>
    </dialog>
  );
});
ConfirmDialog.displayName = 'ConfirmDialog';

export default ConfirmDialog;
