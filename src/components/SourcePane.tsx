import {
  type FC,
  type KeyboardEvent,
  type PointerEvent,
  type SyntheticEvent,
  memo,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from 'react';

import {type DocJob, type PageJob, pageLabel} from '@/lib/jobs';
import {type OcrSegment} from '@/lib/protocol';

import Icon from './icons';
import {CONFIDENCE_BOX, confidenceBand, ghostButtonClass, iconButtonClass, primaryButtonClass} from './paneShared';

interface Props {
  onPrev(): void;
  onNext(): void;
  onHide(): void;
  /** Rotate the page a quarter turn clockwise. */
  onRotate(): void;
  /** The user picked a rectangle (fractions 0–1 of the displayed, rotated page) to recognise on its own. */
  onRegion(rect: {x: number; y: number; width: number; height: number}): void;
  /** Pointer entered (line) or left (null) a segment box; mirrors the text pane. */
  onActiveLine(line: number | null): void;
  doc: DocJob;
  page: PageJob;
  position: number;
  total: number;
  /** Line highlighted from the text pane; its boxes are emphasised. */
  activeLine: number | null;
}

type Rect = Parameters<Props['onRegion']>[0];

interface Point {
  x: number;
  y: number;
}

/** Natural size of the loaded preview, tagged with its URL so a stale size is never applied to a new page. */
interface Natural {
  url: string;
  width: number;
  height: number;
}

/** A drag smaller than this (in fractions of the page) is a click, not a region. */
const MIN_REGION = 0.02;

/** Pointer position as fractions of the element's box, clamped to it. */
const fraction = (event: PointerEvent<HTMLDivElement>): Point => {
  const box = event.currentTarget.getBoundingClientRect();
  return {
    x: Math.min(1, Math.max(0, (event.clientX - box.left) / box.width)),
    y: Math.min(1, Math.max(0, (event.clientY - box.top) / box.height)),
  };
};

/** The rectangle with `a` and `b` as opposite corners. */
const spanning = (a: Point, b: Point): Rect => {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return {x, y, width: Math.max(a.x, b.x) - x, height: Math.max(a.y, b.y) - y};
};

/** Keeps a press on the floating toolbar from starting a new drag on the overlay beneath it. */
const stopPointer = (event: PointerEvent<HTMLDivElement>): void => event.stopPropagation();

const SegmentRect: FC<{onActiveLine(line: number | null): void; segment: OcrSegment; active: boolean}> = memo(
  ({active, onActiveLine, segment}) => {
    const enter = useCallback(() => onActiveLine(segment.line), [onActiveLine, segment.line]);
    const leave = useCallback(() => onActiveLine(null), [onActiveLine]);
    return (
      <rect
        className={CONFIDENCE_BOX[confidenceBand(segment.confidence)]}
        fill="currentColor"
        fillOpacity={active ? 0.3 : 0.08}
        height={segment.box.height}
        onPointerEnter={enter}
        onPointerLeave={leave}
        stroke="currentColor"
        strokeWidth={2}
        vectorEffect="non-scaling-stroke"
        width={segment.box.width}
        x={segment.box.x}
        y={segment.box.y}>
        <title>{`${segment.text} · ${Math.round(segment.confidence * 100)}%`}</title>
      </rect>
    );
  },
);
SegmentRect.displayName = 'SegmentRect';

/** The scanned page, to read the recognised text against. Fits the pane's width; 1:1 on demand. */
const SourcePane: FC<Props> = memo(
  ({activeLine, doc, page, position, total, onActiveLine, onHide, onNext, onPrev, onRegion, onRotate}) => {
    const [fit, setFit] = useState(true);
    const [showBoxes, setShowBoxes] = useState(true);
    const [natural, setNatural] = useState<Natural | null>(null);
    const [regionMode, setRegionMode] = useState(false);
    const [origin, setOrigin] = useState<Point | null>(null);
    const [rect, setRect] = useState<Rect | null>(null);

    const toggleFit = useCallback(() => setFit(v => !v), []);
    const toggleBoxes = useCallback(() => setShowBoxes(v => !v), []);

    const cancelRegion = useCallback(() => {
      setRegionMode(false);
      setOrigin(null);
      setRect(null);
    }, []);
    const toggleRegion = useCallback(() => {
      setRegionMode(v => !v);
      setOrigin(null);
      setRect(null);
    }, []);
    const recogniseRegion = useCallback(() => {
      if (rect !== null) onRegion(rect);
      cancelRegion();
    }, [cancelRegion, onRegion, rect]);

    // Leaving the page leaves its region selection behind.
    useEffect(() => {
      cancelRegion();
    }, [cancelRegion, page.id]);

    const previewUrl = page.previewUrl;
    const onLoad = useCallback(
      (event: SyntheticEvent<HTMLImageElement>) => {
        if (previewUrl === null) return;
        const {naturalHeight, naturalWidth} = event.currentTarget;
        setNatural({url: previewUrl, width: naturalWidth, height: naturalHeight});
      },
      [previewUrl],
    );

    const onPointerDown = useCallback((event: PointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) return;
      event.preventDefault();
      event.currentTarget.focus();
      event.currentTarget.setPointerCapture(event.pointerId);
      const point = fraction(event);
      setOrigin(point);
      setRect({...point, width: 0, height: 0});
    }, []);
    const onPointerMove = useCallback(
      (event: PointerEvent<HTMLDivElement>) => {
        if (origin !== null) setRect(spanning(origin, fraction(event)));
      },
      [origin],
    );
    const onPointerUp = useCallback(
      (event: PointerEvent<HTMLDivElement>) => {
        if (origin === null) return;
        const final = spanning(origin, fraction(event));
        setOrigin(null);
        setRect(final.width >= MIN_REGION && final.height >= MIN_REGION ? final : null);
      },
      [origin],
    );
    const onPointerCancel = useCallback(() => {
      setOrigin(null);
      setRect(null);
    }, []);

    const onKeyDown = useCallback(
      (event: KeyboardEvent<HTMLElement>) => {
        if (event.key !== 'Escape' || (!regionMode && rect === null)) return;
        event.stopPropagation();
        event.preventDefault();
        cancelRegion();
      },
      [cancelRegion, rect, regionMode],
    );

    const degrees = (page.rotation - page.previewRotation + 360) % 360;
    const turned = degrees === 90 || degrees === 270;
    const loaded = natural !== null && natural.url === page.previewUrl ? natural : null;
    const busy = page.state === 'running' || page.state === 'queued';
    const hasBoxes = page.segments !== null && page.segments.length > 0 && page.width !== null && page.height !== null;
    const regionDisabled = page.region !== null || page.previewUrl === null;

    // The wrapper is the displayed (rotated) page: full width when fitting, natural size at 1:1, height by aspect.
    // The box inside holds the unrotated preview; its width is the wrapper's cross dimension when turned.
    const wrapperStyle = useMemo(() => {
      if (loaded === null) return undefined;
      const {width, height} = loaded;
      return {
        aspectRatio: turned ? `${height} / ${width}` : `${width} / ${height}`,
        width: fit ? undefined : turned ? height : width,
      };
    }, [fit, loaded, turned]);
    const boxStyle = useMemo(() => {
      if (loaded === null) return undefined;
      const {width, height} = loaded;
      return {
        aspectRatio: `${width} / ${height}`,
        width: turned ? `${(width / height) * 100}%` : '100%',
        transform: `translate(-50%, -50%) rotate(${degrees}deg)`,
      };
    }, [degrees, loaded, turned]);

    const rectStyle = useMemo(
      () =>
        rect === null
          ? undefined
          : {
              left: `${rect.x * 100}%`,
              top: `${rect.y * 100}%`,
              width: `${rect.width * 100}%`,
              height: `${rect.height * 100}%`,
            },
      [rect],
    );
    const toolbarStyle = useMemo(
      () => (rect === null ? undefined : {left: `${rect.x * 100}%`, top: `${(rect.y + rect.height) * 100}%`}),
      [rect],
    );

    return (
      <section
        className="border-surface0 bg-crust flex shrink-0 flex-col border-b lg:min-h-0 lg:flex-1 lg:border-b-0 lg:border-r"
        onKeyDown={onKeyDown}>
        <div className="border-surface0 bg-mantle flex h-10 shrink-0 items-center gap-2 overflow-hidden border-b pl-4 pr-2">
          <span className="text-subtext0 text-xs font-semibold uppercase tracking-wider">Scan</span>
          {page.width !== null && page.height !== null ? (
            <span className="font-code text-subtext0 hidden whitespace-nowrap text-[11px] xl:inline">
              {page.width}×{page.height}
            </span>
          ) : null}
          {page.region !== null ? (
            <span className="text-subtext0 text-[11px]" title={`Region ${page.region.n} of page ${page.index + 1}`}>
              Region {page.region.n}
            </span>
          ) : null}
          <div className="ml-auto flex shrink-0 items-center gap-1">
            <button
              aria-label="Previous page"
              className={iconButtonClass}
              disabled={position === 0}
              onClick={onPrev}
              title="Previous page"
              type="button">
              <Icon name="chevronLeft" />
            </button>
            <span className="text-subtext1 whitespace-nowrap text-xs tabular-nums">
              {position + 1} / {total}
            </span>
            <button
              aria-label="Next page"
              className={iconButtonClass}
              disabled={position >= total - 1}
              onClick={onNext}
              title="Next page"
              type="button">
              <Icon name="chevronRight" />
            </button>
            <button
              aria-label="Rotate 90° clockwise"
              className={iconButtonClass}
              disabled={busy}
              onClick={onRotate}
              title="Rotate 90° clockwise"
              type="button">
              <Icon name="rotateCw" />
            </button>
            {hasBoxes ? (
              <button
                aria-label="Show/hide text boxes"
                aria-pressed={showBoxes}
                className={`${iconButtonClass} ${showBoxes ? 'bg-surface0 text-text' : ''}`}
                onClick={toggleBoxes}
                title="Show/hide text boxes"
                type="button">
                <Icon name="square" />
              </button>
            ) : null}
            <button
              aria-pressed={regionMode}
              className={`${ghostButtonClass} gap-1.5 ${regionMode ? 'bg-surface0 text-text' : ''}`}
              disabled={regionDisabled}
              onClick={toggleRegion}
              title={
                page.region !== null
                  ? 'This is already a region'
                  : regionMode
                  ? 'Leave region mode'
                  : 'Draw a rectangle to recognise on its own'
              }
              type="button">
              <Icon className="h-3.5 w-3.5" name="columns" />
              <span className="hidden 2xl:inline">Region</span>
            </button>
            <button
              className={ghostButtonClass}
              disabled={page.previewUrl === null}
              onClick={toggleFit}
              title={fit ? 'Show at the preview’s own size' : 'Fit to the pane'}
              type="button">
              {fit ? '1:1' : 'Fit'}
            </button>
            <button
              aria-label="Hide scan"
              className={iconButtonClass}
              onClick={onHide}
              title="Hide the scan"
              type="button">
              <Icon name="x" />
            </button>
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-auto p-4 lg:p-6">
          {page.previewUrl === null ? (
            <div className="text-subtext0 flex h-full min-h-40 flex-col items-center justify-center gap-2 text-center text-xs">
              <Icon className="h-6 w-6" name="image" />
              The page is rendered when it is processed.
            </div>
          ) : loaded === null ? (
            <img
              alt={pageLabel(doc, page)}
              className={`mx-auto h-auto max-w-full rounded shadow-md ${degrees === 0 ? '' : 'invisible'}`}
              onLoad={onLoad}
              src={page.previewUrl}
            />
          ) : (
            <div className={`relative mx-auto ${fit ? 'w-full' : 'max-w-none'}`} style={wrapperStyle}>
              <div className="absolute left-1/2 top-1/2" style={boxStyle}>
                <img
                  alt={pageLabel(doc, page)}
                  className="block h-auto w-full rounded shadow-md"
                  onLoad={onLoad}
                  src={page.previewUrl}
                />
                {hasBoxes && showBoxes ? (
                  <svg
                    aria-hidden="true"
                    className="absolute inset-0 h-full w-full"
                    preserveAspectRatio="none"
                    viewBox={`0 0 ${page.width} ${page.height}`}>
                    {page.segments?.map((segment, i) => (
                      <SegmentRect
                        active={segment.line === activeLine}
                        key={i}
                        onActiveLine={onActiveLine}
                        segment={segment}
                      />
                    ))}
                  </svg>
                ) : null}
              </div>
              {regionMode ? (
                <div
                  aria-label="Draw a region to recognise"
                  className="absolute inset-0 cursor-crosshair touch-none select-none outline-none"
                  onPointerCancel={onPointerCancel}
                  onPointerDown={onPointerDown}
                  onPointerMove={onPointerMove}
                  onPointerUp={onPointerUp}
                  role="application"
                  tabIndex={-1}>
                  {rect !== null ? (
                    <div
                      className="border-blue bg-blue/10 pointer-events-none absolute border-2 border-dashed"
                      style={rectStyle}
                    />
                  ) : null}
                  {rect !== null && origin === null ? (
                    <div
                      className="border-surface1 bg-base absolute z-10 mt-1.5 flex items-center gap-1 rounded-md border p-1 shadow-md"
                      onPointerDown={stopPointer}
                      style={toolbarStyle}>
                      <button className={primaryButtonClass} onClick={recogniseRegion} type="button">
                        Recognise region
                      </button>
                      <button className={ghostButtonClass} onClick={cancelRegion} type="button">
                        Cancel
                      </button>
                    </div>
                  ) : null}
                </div>
              ) : null}
            </div>
          )}
        </div>
      </section>
    );
  },
);
SourcePane.displayName = 'SourcePane';

export default SourcePane;
