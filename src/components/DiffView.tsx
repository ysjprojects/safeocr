import {type FC, memo, useMemo} from 'react';

import {type DiffOp, diffWords} from '@/lib/diff';

interface Props {
  base: string;
  other: string;
  baseLabel: string;
  otherLabel: string;
}

const DELETE_CLASS = 'bg-red/20 text-red line-through rounded-sm';
const INSERT_CLASS = 'bg-green/20 text-green rounded-sm';
const OP_CLASS: Record<DiffOp['kind'], string | undefined> = {
  delete: DELETE_CLASS,
  insert: INSERT_CLASS,
  equal: undefined,
};

/** Word-level diff of two engine outputs: deletions mark text only in `base`, insertions text only in `other`. */
const DiffView: FC<Props> = memo(({base, other, baseLabel, otherLabel}) => {
  const {ops, hunks} = useMemo(() => {
    const ops = diffWords(base, other);
    // A hunk is a maximal run of change ops; the delete-before-insert order makes the insert the continuation.
    let hunks = 0;
    for (let i = 0; i < ops.length; i++) {
      if (ops[i].kind !== 'equal' && (i === 0 || ops[i - 1].kind === 'equal')) hunks++;
    }
    return {ops, hunks};
  }, [base, other]);

  return (
    <div className="flex flex-col gap-2">
      <div className="text-subtext0 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px]">
        <span className="flex items-center gap-1">
          <span className={`${DELETE_CLASS} px-1`}>{baseLabel}</span>
          only in {baseLabel}
        </span>
        <span className="flex items-center gap-1">
          <span className={`${INSERT_CLASS} px-1`}>{otherLabel}</span>
          only in {otherLabel}
        </span>
        <span>
          {hunks} {hunks === 1 ? 'difference' : 'differences'}
        </span>
      </div>
      {hunks === 0 ? (
        <p className="text-subtext0 text-xs">The two engines agree.</p>
      ) : (
        <pre className="font-code text-text whitespace-pre-wrap break-words text-xs leading-relaxed">
          {ops.map((op, i) => (
            <span className={OP_CLASS[op.kind]} key={i}>
              {op.text}
            </span>
          ))}
        </pre>
      )}
    </div>
  );
});
DiffView.displayName = 'DiffView';

export default DiffView;
