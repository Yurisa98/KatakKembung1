import { useEffect, useRef, useState, type CSSProperties, type PointerEvent } from 'react';
import { addDays, day, nextPeriod, periods, shift, shortDate, today, type RecordData, type Scale, type ScheduleRow } from '../shared/model';
import type { Page } from './client';

const rowHeight = 53;
const headerHeight = 46;
const pageSize = 100;
const monthName = new Intl.DateTimeFormat('en-MY', { month: 'long', year: 'numeric', timeZone: 'UTC' });
const pxForScale = { Week: 17, Month: 4.1, Quarter: 1.5, Year: 0.46 };
type Edge = 'move' | 'start' | 'end';
interface Drag { record: RecordData; edge: Edge; pointer: number; x: number; moved: boolean; next: RecordData }
interface Props {
  start: string; end: string; scale: Scale; editable: boolean; viewKey: string; loading: boolean; error: string;
  page: (offset: number, limit: number) => Promise<Page<ScheduleRow>>;
  onEdit: (row: RecordData) => void; onProject: (id: string) => void;
  onMove: (row: RecordData) => void; onAdd: () => void;
}

function label(start: string, scale: Scale) {
  if (scale === 'Week') return shortDate(start);
  if (scale === 'Month') return monthName.format(new Date(`${start}T00:00:00Z`));
  if (scale === 'Quarter') return `Q${Math.ceil(Number(start.slice(5, 7)) / 3)} ${start.slice(0, 4)}`;
  return start.slice(0, 4);
}

export function Gantt(props: Props) {
  const { start, end, scale, viewKey, page, editable, onEdit, onMove } = props;
  const ref = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);
  const suppress = useRef(false);
  const [preview, setPreview] = useState<RecordData | null>(null);
  const [viewport, setViewport] = useState({ top: 0, left: 0, height: 480, width: 1000 });
  const [pages, setPages] = useState<Record<number, ScheduleRow[]>>({});
  const [total, setTotal] = useState<number | null>(null);
  const [error, setError] = useState('');
  const epoch = useRef(0);
  const inFlight = useRef(new Set<number>());
  const px = pxForScale[scale];
  const from = day(start);
  const lineWidth = Math.max(0, (day(end) - from) * px);
  const currentDate = today();
  const x = (value: string) => (day(value) - from) * px;
  const first = Math.max(0, Math.floor((viewport.top - headerHeight) / rowHeight) - 7);
  const last = Math.min(total ?? 50, first + Math.ceil(viewport.height / rowHeight) + 14);
  const displayed = Array.from({ length: Math.max(0, last - first) }, (_, i) => first + i);

  useEffect(() => {
    const el = ref.current!;
    const measure = () => setViewport({ top: el.scrollTop, left: el.scrollLeft, height: el.clientHeight, width: el.clientWidth });
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    el.addEventListener('scroll', measure, { passive: true });
    measure();
    return () => { observer.disconnect(); el.removeEventListener('scroll', measure); };
  }, []);

  useEffect(() => {
    epoch.current++;
    inFlight.current = new Set();
    setPages({});
    setError('');
  }, [viewKey]);

  useEffect(() => {
    const revision = epoch.current;
    const offsets = new Set([0, Math.floor(first / pageSize) * pageSize, Math.floor(Math.max(first, last - 1) / pageSize) * pageSize]);
    for (const offset of offsets) {
      if (Object.hasOwn(pages, offset) || inFlight.current.has(offset)) continue;
      inFlight.current.add(offset);
      page(offset, pageSize).then(result => {
        if (epoch.current !== revision) return;
        setPages(previous => ({ ...previous, [offset]: result.rows }));
        setTotal(result.total);
      }).catch((err: Error) => { if (epoch.current === revision) setError(err.message); });
    }
  }, [viewKey, page, first, last, pages]);

  const columns = periods(start, end, scale).map(column => {
    const next = nextPeriod(column, scale);
    const left = Math.max(0, x(column));
    return { column, left, width: Math.min(lineWidth, x(next)) - left };
  }).filter(({ left, width }) => left + width >= viewport.left - 150 && left <= viewport.left + viewport.width + 150);

  function begin(event: PointerEvent<HTMLElement>, row: RecordData, edge: Edge) {
    if (!editable || event.button !== 0 || event.pointerType === 'touch') return;
    drag.current = { record: row, edge, pointer: event.pointerId, x: event.clientX + (ref.current?.scrollLeft ?? 0), moved: false, next: row };
    suppress.current = false;
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function move(event: PointerEvent<HTMLElement>) {
    const active = drag.current;
    if (!active || active.pointer !== event.pointerId) return;
    const delta = event.clientX + (ref.current?.scrollLeft ?? 0) - active.x;
    if (!active.moved && Math.abs(delta) < 4) return;
    active.moved = true;
    active.next = shift(active.record, Math.round(delta / px), active.edge);
    setPreview(active.next);
  }

  function finish(event: PointerEvent<HTMLElement>, cancel = false) {
    const active = drag.current;
    if (!active || active.pointer !== event.pointerId) return;
    drag.current = null;
    setPreview(null);
    suppress.current = active.moved;
    if (!cancel && active.moved && (active.next.plannedStart !== active.record.plannedStart || active.next.plannedEnd !== active.record.plannedEnd)) onMove(active.next);
  }

  function shape(beginDate: string, endDate: string) {
    if (!beginDate || !endDate || x(addDays(endDate, 1)) <= 0 || x(beginDate) >= lineWidth) return null;
    const left = Math.max(0, x(beginDate));
    return { left, width: Math.min(lineWidth - left, Math.max(6, Math.min(lineWidth, x(addDays(endDate, 1))) - left)) };
  }

  return <>
    {(error || props.error) && <div className="inline-warning" role="alert">{error || props.error} <button onClick={() => { setError(''); inFlight.current.clear(); setPages({}); }}>Retry</button></div>}
    <div className={`gantt-scroll${preview ? ' dragging' : ''}`} ref={ref} tabIndex={0} aria-label="Scrollable project schedule">
      <div className="gantt-sheet" style={{ '--axis-width': `${lineWidth}px`, minHeight: headerHeight + (total || 0) * rowHeight } as CSSProperties}>
        <div className="schedule-head"><div className="frozen grid-head"><span>Project / task</span><span>Owner</span><span>Done</span></div><div className="axis-head" aria-hidden="true">{columns.map(column => <div key={column.column} style={{ left: column.left, width: column.width }}>{label(column.column, scale)}</div>)}</div></div>
        <div className="grid-rails" aria-hidden="true">{columns.map(column => <i key={column.column} style={{ left: column.left }} />)}{x(currentDate) >= 0 && x(currentDate) < lineWidth && <i className="today-rail" style={{ left: x(currentDate) }} />}</div>
        {displayed.map(index => {
          const item = pages[Math.floor(index / pageSize) * pageSize]?.[index % pageSize];
          if (!item) return null;
          const { record: original, key, kind, count } = item;
          const record = preview?.id === original.id && kind === 'task' ? preview : original;
          const planned = shape(record.plannedStart, record.plannedEnd);
          const actual = shape(record.actualStart, record.actualEnd || currentDate);
          const late = record.plannedEnd < currentDate && record.status !== 'Completed';
          const activeDates = `${shortDate(record.plannedStart)} to ${shortDate(record.plannedEnd)}`;
          return <div className={`schedule-row ${kind}`} style={{ top: headerHeight + index * rowHeight }} key={key}>
            <div className="frozen task-cell">
              <div className="task-title">
                {kind === 'task' ? <><button className="text-button" onClick={() => onEdit(original)} title={record.title}>{record.title}</button><small>{[record.code, late && 'Overdue'].filter(Boolean).join(' / ')}</small></>
                  : kind === 'project' ? <><button className="text-button" title={record.title} onClick={() => props.onProject(record.id)}>{record.title}</button><small>{record.code} · {count} tasks</small></>
                    : <span title={record.title}>{record.title}</span>}
              </div>
              <span className="owner-cell" title={record.owner}>{kind !== 'phase' ? record.owner || '–' : ''}</span>
              {kind !== 'phase' && <span className={`percent${record.progress === 100 ? ' complete' : ''}`}>{record.progress}%</span>}
            </div>
            <div className="row-track">
              {kind === 'task' && planned && <div className={`bar-shell${late ? ' late' : ''}`} style={planned}>
                <button className={`planned-bar${record.plannedStart === record.plannedEnd && planned.width <= 17 ? ' milestone' : ''}`} title={`${record.title} · Planned ${activeDates}`} aria-label={`Edit ${record.title}. Planned ${activeDates}. ${record.progress}% complete.`}
                  onPointerDown={event => begin(event, original, 'move')} onPointerMove={move} onPointerUp={finishPointer} onPointerCancel={event => finish(event, true)}
                  onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') suppress.current = false; }}
                  onClick={() => { if (!suppress.current) onEdit(original); suppress.current = false; }} />
                {editable && planned.width >= 22 && (['start', 'end'] as const).map(edge => <span key={edge} className={`resize-handle ${edge}`} aria-hidden="true" onPointerDown={event => begin(event, original, edge)} onPointerMove={move} onPointerUp={finishPointer} onPointerCancel={event => finish(event, true)} />)}
              </div>}
              {kind === 'project' && planned && <span className="summary-bar" style={planned} aria-hidden="true" />}
              {kind === 'task' && actual && <span className="actual-bar" style={actual} title={`Actual ${shortDate(record.actualStart)} to ${record.actualEnd ? shortDate(record.actualEnd) : 'today'}`}><span style={{ width: `${record.progress}%` }} /></span>}
              {preview?.id === original.id && kind === 'task' && <span className="drag-label" style={{ left: Math.max(0, planned?.left ?? 0) }}>{activeDates}</span>}
            </div>
          </div>;
        })}
      </div>
    </div>
    {total === null && !error && <p className="schedule-empty" role="status">Loading schedule…</p>}
    {total === 0 && <div className="schedule-empty"><p>No tasks match this schedule window.</p>{editable && <button onClick={props.onAdd}>Add task</button>}</div>}
  </>;

  function finishPointer(event: PointerEvent<HTMLElement>) { finish(event); }
}
