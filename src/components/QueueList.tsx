import {type FC, memo, useCallback} from 'react';

import {type DocJob, type PageJob, pageLabel} from '@/lib/jobs';

import {formatSeconds, STATE_CLASS, STATE_LABEL} from './paneShared';

interface Props {
  onSelect(pageId: string): void;
  onRemoveDoc(docId: string): void;
  onRetry(pageId: string): void;
  docs: DocJob[];
  selected: string | null;
}

const QueueList: FC<Props> = memo(({docs, selected, onSelect, onRemoveDoc, onRetry}) => (
  <ul className="flex flex-col gap-2">
    {docs.map(doc => (
      <li className="border-plum-600/60 bg-plum-900/50 rounded-xl border" key={doc.id}>
        <div className="flex items-center gap-2 px-3 py-2">
          <span className="text-cream truncate text-[12px] font-semibold" title={doc.name}>
            {doc.name}
          </span>
          <span className="font-code text-plum-300 shrink-0 text-[10px]">
            {doc.kind === 'pdf' ? `PDF · ${doc.pages.length} page${doc.pages.length === 1 ? '' : 's'}` : 'image'}
          </span>
          <RemoveButton docId={doc.id} onRemove={onRemoveDoc} />
        </div>
        {doc.error !== null ? <p className="font-code px-3 pb-2 text-[10.5px] text-rose-300">{doc.error}</p> : null}
        {doc.pages.length === 0 && doc.error === null ? (
          <p className="text-plum-300 px-3 pb-2 text-[11px]">opening…</p>
        ) : null}
        {doc.pages.length > 0 ? (
          <ul className="border-plum-700/60 flex flex-col border-t">
            {doc.pages.map(page => (
              <PageRow
                doc={doc}
                key={page.id}
                onRetry={onRetry}
                onSelect={onSelect}
                page={page}
                selected={page.id === selected}
              />
            ))}
          </ul>
        ) : null}
      </li>
    ))}
  </ul>
));
QueueList.displayName = 'QueueList';

const RemoveButton: FC<{onRemove(docId: string): void; docId: string}> = memo(({docId, onRemove}) => {
  const remove = useCallback(() => onRemove(docId), [docId, onRemove]);
  return (
    <button
      aria-label="remove"
      className="text-plum-300 hover:bg-plum-800 ml-auto shrink-0 rounded px-1.5 text-[14px] leading-none transition hover:text-white"
      onClick={remove}
      title="Remove"
      type="button">
      ×
    </button>
  );
});
RemoveButton.displayName = 'RemoveButton';

const PageRow: FC<{
  onSelect(pageId: string): void;
  onRetry(pageId: string): void;
  doc: DocJob;
  page: PageJob;
  selected: boolean;
}> = memo(({doc, page, selected, onSelect, onRetry}) => {
  const select = useCallback(() => onSelect(page.id), [onSelect, page.id]);
  const retry = useCallback(() => onRetry(page.id), [onRetry, page.id]);
  return (
    <li
      className={`flex items-center gap-2 px-3 py-1.5 text-[11.5px] transition ${
        selected ? 'bg-candy-500/10' : 'hover:bg-plum-800/50'
      }`}>
      <button className="flex min-w-0 flex-1 items-center gap-2 text-left" onClick={select} type="button">
        {page.previewUrl !== null ? (
          // Plain <img>: the preview is a local blob URL and the site-wide image rules fit it fine.
          <img alt="" className="h-8 w-8 shrink-0 rounded object-cover" src={page.previewUrl} />
        ) : (
          <span className="bg-plum-800 h-8 w-8 shrink-0 rounded" />
        )}
        <span className="text-plum-100 truncate">
          {doc.kind === 'pdf' ? `page ${page.index + 1}` : pageLabel(doc, page)}
        </span>
        <span
          className={`ml-auto shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-semibold ${
            STATE_CLASS[page.state]
          }`}>
          {STATE_LABEL[page.state]}
        </span>
        {page.state === 'done' && page.ms !== null ? (
          <span className="font-code text-plum-300 shrink-0 text-[10px]">{formatSeconds(page.ms)}</span>
        ) : null}
      </button>
      {page.state === 'error' || page.state === 'cancelled' ? (
        <button
          className="text-candy-300 hover:bg-plum-800 shrink-0 rounded px-1.5 py-0.5 text-[10.5px] font-semibold"
          onClick={retry}
          type="button">
          retry
        </button>
      ) : null}
    </li>
  );
});
PageRow.displayName = 'PageRow';

export default QueueList;
