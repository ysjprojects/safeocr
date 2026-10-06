import {type FC, memo} from 'react';

import type {EngineStatus} from '@/lib/client';
import type {GlmSupport} from '@/lib/device';
import {type Engine, ENGINES} from '@/lib/protocol';
import type {SessionSummary} from '@/lib/session';

import {DropHero} from './Dropzone';
import EngineCard from './EngineCard';
import Icon from './icons';
import {ghostButtonClass, primaryButtonClass} from './paneShared';

interface Props {
  onFiles(files: File[]): void;
  onEngine(engine: Engine): void;
  onLoad(engine: Engine): void;
  onRestoreSession(): void;
  onDiscardSession(): void;
  engine: Engine;
  status: Record<Engine, EngineStatus>;
  glm: GlmSupport;
  isolated: boolean;
  dragging: boolean;
  /** Work saved in this browser by an earlier visit, if any. */
  session: SessionSummary | null;
}

const STEPS = ['Add images or PDFs', 'Pick an engine', 'Run, then review each page beside its scan'];

/** The empty workspace: the drop target first, then the engine choice, then the privacy promise. */
const Welcome: FC<Props> = memo(
  ({
    onFiles,
    onEngine,
    onLoad,
    onRestoreSession,
    onDiscardSession,
    engine,
    status,
    glm,
    isolated,
    dragging,
    session,
  }) => (
    <div className="flex min-h-0 flex-1 flex-col items-center overflow-y-auto px-4 py-8 sm:px-8">
      <div className="flex w-full max-w-3xl flex-col gap-8">
        <ol className="text-subtext0 flex flex-wrap items-center justify-center gap-x-6 gap-y-1 text-xs">
          {STEPS.map((step, index) => (
            <li className="flex items-center gap-2" key={step}>
              <span className="bg-surface0 text-subtext1 flex h-5 w-5 items-center justify-center rounded-full text-[11px] font-semibold">
                {index + 1}
              </span>
              {step}
            </li>
          ))}
        </ol>
        {session !== null ? (
          <div className="border-blue/40 bg-blue/5 flex flex-wrap items-center gap-3 rounded-xl border px-4 py-3">
            <Icon className="text-blue h-4 w-4 shrink-0" name="refresh" />
            <span className="text-text min-w-0 flex-1 text-xs leading-relaxed">
              <span className="font-medium">Pick up where you left off?</span> {session.files} file
              {session.files === 1 ? '' : 's'} · {session.pages} page{session.pages === 1 ? '' : 's'} ·{' '}
              {session.recognised} recognised · saved {new Date(session.savedAt).toLocaleString()}, in this browser.
            </span>
            <div className="flex items-center gap-1">
              <button className={ghostButtonClass} onClick={onDiscardSession} type="button">
                Discard
              </button>
              <button className={primaryButtonClass} onClick={onRestoreSession} type="button">
                Restore
              </button>
            </div>
          </div>
        ) : null}
        <DropHero active={dragging} onFiles={onFiles} />
        <section className="flex flex-col gap-3">
          <h2 className="text-subtext0 text-xs font-semibold uppercase tracking-wider">Engine</h2>
          <div aria-label="Engine" className="grid gap-3 md:grid-cols-3" role="radiogroup">
            {ENGINES.map(id => (
              <EngineCard
                engine={id}
                glm={glm}
                key={id}
                onLoad={onLoad}
                onSelect={onEngine}
                selected={engine === id}
                status={status[id]}
              />
            ))}
          </div>
          {!isolated ? (
            <p className="border-yellow/40 bg-yellow/10 text-text flex items-start gap-2 rounded-lg border px-3 py-2 text-xs leading-relaxed">
              <Icon className="text-yellow mt-0.5 h-3.5 w-3.5 shrink-0" name="alert" />
              This page is not cross-origin isolated (the server did not send the COOP/COEP headers from
              next.config.js), so WebAssembly runs on one thread and PP-OCR is slower than it could be.
            </p>
          ) : null}
        </section>
        <p className="text-subtext0 flex items-start gap-2 text-xs leading-relaxed">
          <Icon className="mt-0.5 h-3.5 w-3.5 shrink-0" name="shield" />
          Nothing is uploaded. Models are downloaded once from huggingface.co and cached by your browser; every page is
          processed on your own machine, in this tab. GLM-OCR is MIT-licensed, PP-OCR Apache-2.0.
        </p>
      </div>
    </div>
  ),
);
Welcome.displayName = 'Welcome';

export default Welcome;
