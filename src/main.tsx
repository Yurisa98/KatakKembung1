import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { addDays, addYears, Conflict, defaultProgress, makeRecord, modules, nextPeriod, periodStart, scales, shortDate, statuses, tables, today, type Change, type RecordData, type Scale, type Status, type Table } from '../shared/model';
import { apiUrl, googleClientId, localClient, readBackup, remoteClient, type Client, type Workspace } from './client';
import { demoAnchor } from './demo';
import { Gantt } from './Gantt';
import type { ImportPreview } from './importer';
import './style.css';

type Screen = 'Gantt' | 'Overview' | 'Settings' | typeof modules[number];
const screens: Screen[] = ['Overview', 'Gantt', ...modules, 'Settings'];
const glyphs = ['▦', '≡', '◇', '△', '◉', '◎', '○', '⚙'];
const formatNumber = new Intl.NumberFormat('en-MY');
const ringgit = new Intl.NumberFormat('en-MY', { style: 'currency', currency: 'MYR' });
const url = new URLSearchParams(location.hash.split('?')[1]);
const initialScreen = screens.find(screen => screen.toLowerCase() === location.hash.split('?')[0].slice(2)) || 'Gantt';
const initialScale = scales.find(scale => scale === url.get('scale')) || 'Week';
const fieldLabels: Partial<Record<Table, string[]>> = {
  Projects: ['Sponsor', 'Capex', 'Opex'], Tasks: ['Priority', 'Effort'], Deliverables: ['Approver', 'Link'],
  'Risks & Issues': ['Type', 'Likelihood', 'Impact', 'Mitigation'], Resources: ['Role', 'Department', 'Email', 'Phone', 'Rate', 'Allocation'],
  Costs: ['Category', 'Supplier', 'Planned amount', 'Actual amount', 'Paid', 'Terms', 'Purchase order', 'Invoice'],
  Stakeholders: ['Role', 'Influence', 'Interest', 'Communication'],
};
const numericFields = new Set(['Capex', 'Opex', 'Rate', 'Allocation', 'Planned amount', 'Actual amount']);
const opening = (scale: Scale) => periodStart(scale === 'Week' ? demoAnchor : today(), scale);
const initialPeriods: Record<Scale, number> = { Week: 10, Month: 10, Quarter: 8, Year: 10 };
function validAnchor(value: string | null) {
  return value && /^20\d{2}-\d{2}-\d{2}$/.test(value) && new Date(`${value}T00:00:00Z`).toString() !== 'Invalid Date' ? value : '';
}

function SheetDialog({ title, children, onClose, busy = false }: { title: string; children: ReactNode; onClose: () => void; busy?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { ref.current?.showModal(); }, []);
  return <dialog ref={ref} className="drawer" aria-labelledby="drawer-title" onCancel={event => { event.preventDefault(); if (!busy) onClose(); }}>
    <header><h2 id="drawer-title">{title}</h2><button className="icon-button" aria-label="Close panel" onClick={onClose} disabled={busy}>×</button></header>{children}
  </dialog>;
}

function Editor({ table, initial, projects, editable, close, save }: { table: Table; initial: RecordData; projects: RecordData[]; editable: boolean; close: () => void; save: (changes: Change[], operation?: string) => Promise<void> }) {
  const [record, setRecord] = useState(initial);
  const [dependencies, setDependencies] = useState(initial.dependencies.join(', '));
  const [error, setError] = useState('');
  const [conflict, setConflict] = useState<RecordData>();
  const [busy, setBusy] = useState(false);
  const retry = useRef<{ data: string; id: string } | undefined>(undefined);
  const dirty = JSON.stringify(record) !== JSON.stringify(initial) || dependencies !== initial.dependencies.join(', ');
  const formRef = useRef<HTMLFormElement>(null);
  function exit() { if (!dirty || confirm('Discard unsaved edits?')) close(); }
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true); setError(''); setConflict(undefined);
    const payload = { ...record, dependencies: dependencies.split(',').map(id => id.trim()).filter(Boolean), title: record.title.trim() };
    const hash = JSON.stringify(payload);
    if (retry.current?.data !== hash) retry.current = { data: hash, id: crypto.randomUUID() };
    try { await save([{ table, record: payload, expectedVersion: record.version }], retry.current.id); close(); }
    catch (err) {
      setError((err as Error).message);
      if (err instanceof Conflict) setConflict(err.current);
      requestAnimationFrame(() => formRef.current?.querySelector<HTMLElement>('.form-error')?.focus());
    } finally { setBusy(false); }
  }
  const label = table === 'Projects' ? 'project' : table === 'Tasks' ? 'task' : table === 'Members' ? 'member' : 'record';
  const entry = (name: string, key: keyof Pick<RecordData, 'title' | 'code' | 'owner' | 'phase' | 'plannedStart' | 'plannedEnd' | 'actualStart' | 'actualEnd'>, type = 'text', required = false) =>
    <label>{name}<input name={key} type={type} required={required} value={record[key]} maxLength={300} onChange={event => setRecord({ ...record, [key]: event.target.value })} /></label>;
  const warning = table === 'Tasks' && record.status === 'Completed' && !record.actualEnd;
  const percentWarning = table === 'Tasks' && ((record.status === 'Completed' && record.progress !== 100) || (record.status === 'Not Started' && record.progress !== 0) || (record.status === 'In Progress' && [0, 100].includes(record.progress)));

  return <SheetDialog title={record.version ? `${editable ? 'Edit' : 'View'} ${label}` : `New ${label}`} onClose={exit} busy={busy}>
    <form onSubmit={submit} autoComplete="off" ref={formRef}>
      {error && <div className="inline-warning form-error" tabIndex={-1} role="alert">{error}{conflict && <div><p>Latest: {conflict.title} · {conflict.status} · {conflict.progress}%<br />Planned {conflict.plannedStart || '–'} to {conflict.plannedEnd || '–'}</p><button type="button" onClick={() => { setRecord(conflict); setDependencies(conflict.dependencies.join(', ')); setConflict(undefined); setError(''); }}>Load latest version</button></div>}</div>}
      <fieldset disabled={!editable || busy}>
        {entry(table === 'Members' ? 'Google account email' : `${label[0].toUpperCase()}${label.slice(1)} name`, 'title', table === 'Members' ? 'email' : 'text', true)}
        {table === 'Members' ? <label>Role<select name="role" value={String(record.fields.role || 'Editor')} onChange={event => setRecord({ ...record, fields: { ...record.fields, role: event.target.value } })}><option>Editor</option><option>Viewer</option><option>Owner</option></select></label> : <>
          {table !== 'Projects' && <label>Project<select name="project" required={table === 'Tasks'} value={record.projectId} onChange={event => setRecord({ ...record, projectId: event.target.value })}><option value="">{table === 'Tasks' ? 'Choose a project' : 'No project'}</option>{projects.filter(row => !row.archived).map(row => <option key={row.id} value={row.id}>{row.title}</option>)}</select></label>}
          <div className="form-grid">{entry('Code', 'code')}{entry('Owner', 'owner')}{table === 'Tasks' && entry('Phase', 'phase')}</div>
          <div className="form-grid">
            {entry('Planned start', 'plannedStart', 'date', table === 'Tasks')}{entry('Planned end', 'plannedEnd', 'date', table === 'Tasks')}
            {entry('Actual start', 'actualStart', 'date')}{entry('Actual end', 'actualEnd', 'date')}
            <label>Status<select name="status" value={record.status} onChange={event => { const status = event.target.value as Status; setRecord({ ...record, status, progress: defaultProgress(status, record.progress) }); }}>{statuses.map(status => <option key={status}>{status}</option>)}</select></label>
            <label>% Complete<input name="progress" type="number" min="0" max="100" step="1" required value={record.progress} onChange={event => setRecord({ ...record, progress: Number(event.target.value) })} /></label>
          </div>
          {(warning || percentWarning) && <p className="inline-warning" role="status">{warning && 'Completed task is missing Actual End. '}{percentWarning && 'Completion percentage and status differ.'}</p>}
          {table === 'Tasks' && <label>Dependency IDs<input name="dependencies" value={dependencies} onChange={event => setDependencies(event.target.value)} aria-describedby="dependency-help" /><small id="dependency-help">Separate task IDs with commas. This task ID is <code>{record.id}</code>.</small></label>}
          <div className="form-grid">{fieldLabels[table]?.map(key => <label key={key}>{key}{table === 'Risks & Issues' && key === 'Type' ? <select name="type" value={String(record.fields.Type || 'Risk')} onChange={event => setRecord({ ...record, fields: { ...record.fields, Type: event.target.value } })}><option>Risk</option><option>Issue</option></select> : <input name={key} value={record.fields[key] ?? ''} inputMode={numericFields.has(key) ? 'decimal' : undefined} onChange={event => setRecord({ ...record, fields: { ...record.fields, [key]: numericFields.has(key) && event.target.value.trim() && Number.isFinite(Number(event.target.value)) ? Number(event.target.value) : event.target.value } })} />}</label>)}</div>
          <label>Notes<textarea name="notes" rows={4} maxLength={8000} value={record.notes} onChange={event => setRecord({ ...record, notes: event.target.value })} /></label>
        </>}
        {record.version > 0 && <label className="check"><input name="archived" type="checkbox" checked={record.archived} onChange={event => setRecord({ ...record, archived: event.target.checked })} />Archive {label}</label>}
      </fieldset>
      <footer><button type="button" onClick={exit} disabled={busy}>{editable ? 'Cancel' : 'Close'}</button>{editable && <button className="primary" disabled={busy} type="submit">{busy ? 'Saving…' : 'Save changes'}</button>}</footer>
    </form>
  </SheetDialog>;
}

function SignIn({ onLogin }: { onLogin: (token: string) => void }) {
  const button = useRef<HTMLDivElement>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    const script = document.createElement('script');
    script.src = 'https://accounts.google.com/gsi/client'; script.async = true;
    script.onload = () => {
      if (!active || !button.current) return;
      const google = (window as Window & { google?: { accounts: { id: { initialize: (options: object) => void; renderButton: (node: HTMLElement, options: object) => void } } } }).google;
      if (!google) { setError('Google Sign-In is unavailable. Refresh and try again.'); return; }
      google.accounts.id.initialize({ client_id: googleClientId, callback: ({ credential }: { credential: string }) => onLogin(credential) });
      google.accounts.id.renderButton(button.current, { theme: 'outline', text: 'signin_with', size: 'large' });
    };
    script.onerror = () => setError('Google Sign-In could not load. Check your connection.');
    document.head.append(script);
    return () => { active = false; script.remove(); };
  }, [onLogin]);
  return <div><div ref={button} />{error && <p role="alert">{error}</p>}</div>;
}

function App() {
  const [screen, setScreen] = useState<Screen>(initialScreen);
  const [scale, setScale] = useState<Scale>(initialScale);
  const [anchor, setAnchor] = useState(() => validAnchor(url.get('from')) || opening(initialScale));
  const [years, setYears] = useState(0);
  const [project, setProject] = useState(url.get('project') || '');
  const [status, setStatus] = useState(url.get('status') || '');
  const [q, setQ] = useState(url.get('q') || '');
  const [search, setSearch] = useState(q);
  const [phase, setPhase] = useState('');
  const [token, setToken] = useState('');
  const [demo, setDemo] = useState(!apiUrl);
  const client = useMemo(() => demo ? localClient() : token ? remoteClient(token) : null, [demo, token]);
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [connectionError, setConnectionError] = useState('');
  const [editor, setEditor] = useState<{ table: Table; row: RecordData }>();
  const [notice, setNotice] = useState({ kind: '', message: '' });
  const [busy, setBusy] = useState(false);
  const saving = useRef(false);
  const [failedMove, setFailedMove] = useState<{ row: RecordData; id: string; current?: RecordData }>();
  const [filePreview, setFilePreview] = useState<ImportPreview>();
  const [fileBusy, setFileBusy] = useState(false);
  const worker = useRef<Worker | null>(null);
  const bulkRequest = useRef<{ changes: Change[]; id: string } | null>(null);
  const start = periodStart(anchor, scale);
  const end = years ? addYears(start, years) : nextPeriod(start, scale, initialPeriods[scale]);
  const editable = !!workspace && workspace.role !== 'Viewer';
  const owner = workspace?.role === 'Owner';
  const filters = useMemo(() => ({ project, status, q, start, end: addDays(end, -1), phase }), [project, status, q, start, end, phase]);
  const query = useCallback((offset: number, limit: number) => client!.schedule(filters, offset, limit), [client, filters]);
  const revision = workspace?.revision || '';
  const viewKey = JSON.stringify([filters, revision]);

  useEffect(() => { const handle = setTimeout(() => setQ(search), 200); return () => clearTimeout(handle); }, [search]);
  useEffect(() => {
    const params = new URLSearchParams({ scale, from: start });
    if (q) params.set('q', q);
    if (project) params.set('project', project);
    if (status) params.set('status', status);
    history.replaceState(null, '', `#/${screen.toLowerCase()}?${params}`);
  }, [screen, scale, project, status, q, start]);
  useEffect(() => {
    let active = true;
    setWorkspace(null); setConnectionError('');
    if (!client) return;
    const refresh = () => client.workspace().then(value => {
      if (!active) return;
      setConnectionError('');
      setWorkspace(previous => previous?.revision === value.revision && previous?.role === value.role ? previous : value);
    }).catch(error => {
      if (!active) return;
      setConnectionError((error as Error).message);
      if (!demo) setWorkspace(null);
    });
    void refresh();
    const timer = window.setInterval(refresh, 12_000);
    return () => { active = false; clearInterval(timer); };
  }, [client, demo]);

  async function save(changes: Change[], id: string = crypto.randomUUID()) {
    if (!client || saving.current) throw new Error('Wait for the current save to finish.');
    saving.current = true; setBusy(true); setNotice({ kind: 'busy', message: 'Saving…' });
    try {
      const result = await client.save(changes, id);
      setNotice({ kind: result.warnings.length ? 'warn' : 'success', message: result.warnings.length ? `Saved. ${result.warnings.join(' ')}` : 'Saved' });
      void client.workspace().then(setWorkspace).catch(() => undefined);
    } catch (error) {
      setNotice({ kind: 'error', message: `Save failed. ${(error as Error).message}` });
      throw error;
    } finally { setBusy(false); saving.current = false; }
  }
  const login = useCallback((credential: string) => { setToken(credential); setDemo(false); }, []);
  async function move(row: RecordData, id: string = crypto.randomUUID()) {
    setFailedMove(undefined);
    try { await save([{ table: 'Tasks', record: row, expectedVersion: row.version }], id); }
    catch (err) { setFailedMove({ row, id, current: err instanceof Conflict ? err.current : undefined }); }
  }
  function addTask() {
    const selected = project || workspace?.projects.find(row => !row.archived)?.id;
    if (!selected) { setEditor({ table: 'Projects', row: makeRecord() }); return; }
    const selectedDay = today() >= start && today() < end ? today() : start;
    setEditor({ table: 'Tasks', row: makeRecord({ projectId: selected, phase, plannedStart: selectedDay, plannedEnd: selectedDay }) });
  }
  async function openFile(file: File | undefined) {
    if (!file || !owner) return;
    bulkRequest.current = null;
    if (file.size > 30_000_000) { setNotice({ kind: 'error', message: 'Choose a file smaller than 30 MB.' }); return; }
    setFileBusy(true);
    try {
      if (file.name.toLowerCase().endsWith('.json')) {
        setFilePreview({ file: file.name, data: readBackup(JSON.parse(await file.text())), errors: [], warnings: ['Restore adds records and updates matching IDs. It does not remove existing records or change team access.'] });
      } else {
        const task = new Worker(new URL('./import.worker.ts', import.meta.url), { type: 'module' });
        worker.current = task;
        task.onmessage = ({ data }) => { if (data.error) setNotice({ kind: 'error', message: data.error }); else setFilePreview(data.result); task.terminate(); worker.current = null; setFileBusy(false); };
        task.onerror = () => { setNotice({ kind: 'error', message: 'Could not read the Excel file.' }); task.terminate(); worker.current = null; setFileBusy(false); };
        const bytes = await file.arrayBuffer();
        if (worker.current === task) task.postMessage({ name: file.name, bytes }, [bytes]);
        return;
      }
    } catch (err) { setNotice({ kind: 'error', message: (err as Error).message }); }
    setFileBusy(false);
  }
  async function applyFile() {
    if (!filePreview || !client || !owner) return;
    try {
      if (!bulkRequest.current) {
        const existing = await client.backup();
        const changes = filePreview.file.toLowerCase().endsWith('.json') ? tables.filter(table => table !== 'Members').flatMap(table => {
          const versions = new Map(existing[table].map(row => [row.id, row.version]));
          return filePreview.data[table].map(record => ({ table, record, expectedVersion: versions.get(record.id) ?? 0 }));
        }) : (await import('./importer')).importChanges(filePreview.data, existing);
        bulkRequest.current = { changes, id: crypto.randomUUID() };
      }
      await save(bulkRequest.current.changes, bulkRequest.current.id);
      setFilePreview(undefined); bulkRequest.current = null;
    } catch (error) {
      setFilePreview(previous => previous && ({ ...previous, warnings: [...previous.warnings, (error as Error).message] }));
    }
  }
  async function download() {
    try {
      const value = await client!.backup();
      const href = URL.createObjectURL(new Blob([JSON.stringify({ schema: 1, data: value })], { type: 'application/json' }));
      const a = document.createElement('a'); a.href = href; a.download = `workspace-backup-${today()}.json`; a.click(); setTimeout(() => URL.revokeObjectURL(href), 1000);
    } catch (error) { setNotice({ kind: 'error', message: (error as Error).message }); }
  }
  const go = (next: Screen) => setScreen(next);
  const projects = workspace?.projects.filter(row => !row.archived) ?? [];
  const overview = (workspace?.summaries ?? []).filter(row => !project || row.id === project);

  return <div className="app-shell">
    <a className="skip" href="#main-content">Skip to main content</a>
    <aside className="sidebar"><div className="brand"><div className="brand-mark" aria-hidden="true"><i /><i /><i /></div><div><strong translate="no">KatakKembung1</strong><small>Project planner</small></div></div>
      <nav aria-label="Planner modules">{screens.map((item, i) => <a key={item} href={`#/${item.toLowerCase()}`} aria-current={screen === item ? 'page' : undefined} onClick={event => { event.preventDefault(); go(item); }}><span aria-hidden="true">{glyphs[i]}</span>{item}</a>)}</nav>
      <div className="sidebar-bottom"><span className={demo ? 'dot' : 'dot live'} />{demo ? 'Demo workspace' : 'Team workspace'}</div>
    </aside>
    <main id="main-content">
      <div className="topbar"><span>Project planner <b aria-hidden="true">/</b> {screen === 'Gantt' ? 'Schedule' : screen}</span><div className="top-actions">{demo && <span className="demo-label">Demo data</span>}{!demo && workspace && <span className="demo-label">{workspace.role}</span>}{apiUrl && (demo ? <button onClick={() => setDemo(false)}>Team sign-in</button> : token ? <button onClick={() => setToken('')}>Sign out</button> : null)}</div></div>
      {!client || (!demo && !workspace) ? <section className="login"><h1>Team workspace</h1><p>Sign in with the Google account your workspace owner added.</p>{connectionError && <p className="inline-warning" role="alert">{connectionError}</p>}{googleClientId ? <SignIn onLogin={login} /> : <p>Google Sign-In configuration is required.</p>}<button onClick={() => { setDemo(true); setToken(''); }}>Open demo workspace</button></section> : <>
        <section className="page-intro"><div><h1>{screen === 'Gantt' ? 'Project schedule' : screen === 'Overview' ? 'Portfolio overview' : screen}</h1><p>{screen === 'Gantt' ? 'Track planned dates, actual dates and completion across projects.' : screen === 'Settings' ? 'Manage team access, imports and backups.' : screen === 'Overview' ? 'Review progress across your projects.' : `Track ${screen.toLowerCase()} across your projects.`}</p></div>
          {editable && screen === 'Gantt' && <div className="top-actions"><button onClick={() => setEditor({ table: 'Projects', row: makeRecord() })}>New project</button><button className="primary" onClick={addTask}>+ Add task</button></div>}
        </section>
        {notice.message && <div className={`toast-strip ${notice.kind}`} role={notice.kind === 'error' ? 'alert' : 'status'}><span>{notice.message}</span>{failedMove && (failedMove.current ? <button onClick={() => { setEditor({ table: 'Tasks', row: failedMove.current! }); setFailedMove(undefined); }}>Review latest task</button> : <button onClick={() => void move(failedMove.row, failedMove.id)}>Retry move</button>)}<button className="icon-button" aria-label="Dismiss message" onClick={() => { setNotice({ kind: '', message: '' }); setFailedMove(undefined); }}>×</button></div>}
        {screen === 'Gantt' && <section className="workbench" aria-label="Project schedule">
          <div className="controls"><div className="filters"><label className="search"><span aria-hidden="true">⌕</span><input name="search" aria-label="Find tasks" placeholder="Find tasks…" value={search} onChange={event => setSearch(event.target.value)} /></label>
            <label><span className="sr-only">Filter by project</span><select name="project-filter" value={project} onChange={event => { setProject(event.target.value); setPhase(''); }}><option value="">All projects</option>{projects.map(row => <option key={row.id} value={row.id}>{row.title}</option>)}</select></label>
            <label><span className="sr-only">Filter by status</span><select name="status-filter" value={status} onChange={event => setStatus(event.target.value)}><option value="">All statuses</option>{statuses.map(item => <option key={item}>{item}</option>)}</select></label>
            <label className="phase-filter"><span className="sr-only">Filter by phase</span><input name="phase-filter" placeholder="Phase name…" value={phase} onChange={event => setPhase(event.target.value)} /></label>
          </div><div className="segmented" aria-label="Timeline scale">{scales.map(item => <button key={item} aria-pressed={item === scale} onClick={() => { setScale(item); setYears(0); }}>{item}</button>)}</div></div>
          <div className="timeline-toolbar"><div className="timeline-nav"><button className="icon-button" aria-label="Previous timeline window" onClick={() => setAnchor(years ? addYears(start, -years) : nextPeriod(start, scale, -initialPeriods[scale]))}>‹</button><button onClick={() => setAnchor(opening(scale))}>Today</button><button className="icon-button" aria-label="Next timeline window" onClick={() => setAnchor(end)}>›</button><span className="date-range">{shortDate(start)} {start.slice(0, 4)} <span aria-hidden="true">–</span> {shortDate(addDays(end, -1))} {addDays(end, -1).slice(0, 4)}</span>
            <input aria-label="Jump to date" name="anchor-date" type="date" value={anchor} onChange={event => { if (validAnchor(event.target.value)) setAnchor(event.target.value); }} />
            <select aria-label="Timeline duration" name="duration" value={years} onChange={event => setYears(Number(event.target.value))}><option value={0}>Default range</option><option value={1}>1 year</option><option value={3}>3 years</option><option value={5}>5 years</option><option value={10}>10 years</option></select>
          </div><div className="legend"><span><i className="legend-plan" />Planned</span><span><i className="legend-actual" />Actual</span><span><i className="legend-today" />Today</span></div></div>
          <Gantt start={start} end={end} scale={scale} editable={editable && !busy} viewKey={viewKey} page={query} loading={!workspace} error={connectionError}
            onEdit={row => setEditor({ table: 'Tasks', row })} onProject={id => { setProject(project === id ? '' : id); setPhase(''); }} onMove={row => void move(row)} onAdd={addTask} />
          <div className="workbench-foot"><span>{demo ? 'Demo changes stay in this browser.' : 'Shared schedule · Saved to Google Sheets'}</span><span>Drag planned bars to reschedule. Select a task to edit.</span></div>
        </section>}
        {screen === 'Overview' && <section className="overview">
          <div className="portfolio-metrics">{[['Projects', overview.length], ['Tasks', overview.reduce((n, row) => n + row.tasks, 0)], ['Completed', overview.reduce((n, row) => n + row.done, 0)], ['Overdue', overview.reduce((n, row) => n + row.overdue, 0)]].map(([name, count]) => <div key={name}><span>{name}</span><strong>{formatNumber.format(Number(count))}</strong></div>)}</div>
          <div className="table-wrap"><table><thead><tr><th>Project</th><th>Planned range</th><th>Planned progress</th><th>Actual progress</th><th>Overdue</th></tr></thead><tbody>{overview.map(row => <tr key={row.id}><td><button className="text-button" onClick={() => { setProject(row.id); setPhase(''); go('Gantt'); }}>{row.title}</button></td><td>{shortDate(row.plannedStart)} to {shortDate(row.plannedEnd)}</td><td>{row.planned}%</td><td>{row.progress}%</td><td>{row.overdue}</td></tr>)}</tbody></table>{!overview.length && <p className="schedule-empty">Create a project to see its progress.</p>}</div>
          <ModuleList client={client} table="Costs" project={project} revision={revision} editable={false} onEdit={row => setEditor({ table: 'Costs', row })} compact />
        </section>}
        {modules.includes(screen as typeof modules[number]) && <ModuleList key={screen} client={client} table={screen as Table} project={project} revision={revision} editable={editable} onEdit={row => setEditor({ table: screen as Table, row })} />}
        {screen === 'Settings' && <section className="settings">
          <div className="settings-panel"><h2>Storage</h2><p>{demo ? 'This demo stores changes in this browser.' : 'Team data is stored in the private Google spreadsheet. Notion receives project summaries when configured by the owner.'}</p>
            {owner && <div className="settings-actions">{fileBusy ? <button onClick={() => { worker.current?.terminate(); worker.current = null; setFileBusy(false); }}>Cancel file preview</button> : <label className="button upload">Import Excel or restore JSON<input type="file" accept=".xlsx,.json" onChange={event => { void openFile(event.target.files?.[0]); event.target.value = ''; }} /></label>}<button onClick={() => void download()}>Download backup</button></div>}
          </div>
          <ModuleList client={client} table="Projects" project="" revision={revision} editable={editable} onEdit={row => setEditor({ table: 'Projects', row })} />
          {owner && <ModuleList client={client} table="Members" project="" revision={revision} editable onEdit={row => setEditor({ table: 'Members', row })} />}
        </section>}
      </>}
    </main>
    {editor && <Editor key={editor.row.id} table={editor.table} initial={editor.row} projects={projects} editable={editor.table === 'Members' ? !!owner : editable} close={() => setEditor(undefined)} save={save} />}
    {filePreview && <SheetDialog title="Review import" busy={busy} onClose={() => { setFilePreview(undefined); bulkRequest.current = null; }}><div className="import-preview"><p>{filePreview.file}</p><dl>{tables.filter(table => table !== 'Members').map(table => <div key={table}><dt>{table}</dt><dd>{filePreview.data[table].length}</dd></div>)}</dl>{filePreview.errors.length > 0 && <ul className="inline-warning" aria-label="Import errors">{filePreview.errors.map((error, i) => <li key={i}>{error}</li>)}</ul>}{filePreview.warnings.length > 0 && <ul aria-label="Import warnings">{filePreview.warnings.map((warning, i) => <li key={i}>{warning}</li>)}</ul>}<button className="primary" disabled={busy || !!filePreview.errors.length} onClick={() => void applyFile()}>{busy ? 'Saving…' : 'Confirm import'}</button></div></SheetDialog>}
  </div>;
}

function ModuleList({ client, table, project, revision, editable, onEdit, compact = false }: { client: Client; table: Table; project: string; revision: string; editable: boolean; onEdit: (row: RecordData) => void; compact?: boolean }) {
  const [page, setPage] = useState({ rows: [] as RecordData[], total: 0 });
  const [offset, setOffset] = useState(0);
  const [info, setInfo] = useState('Loading records…');
  useEffect(() => {
    let alive = true;
    void client.list(table, project, offset).then(value => { if (alive) { setPage(value); setInfo(''); } }).catch(error => { if (alive) setInfo((error as Error).message); });
    return () => { alive = false; };
  }, [client, table, project, offset, revision]);
  const addLabel = table === 'Members' ? 'Add member' : table === 'Projects' ? 'New project' : 'Add record';
  const field = table === 'Costs' ? 'Planned / actual' : table === 'Members' ? 'Role' : 'Owner';
  return <section className="module-panel"><header><h2>{table === 'Members' ? 'Team members' : table}</h2>{editable && <button className="primary" onClick={() => onEdit(makeRecord({ projectId: project, fields: table === 'Members' ? { role: 'Editor' } : table === 'Risks & Issues' ? { Type: 'Risk' } : {} }))}>{addLabel}</button>}</header>
    <div className="table-wrap"><table><thead><tr><th>Name</th><th>{field}</th>{table !== 'Members' && <><th>Due</th><th>Status</th></>}</tr></thead><tbody>{(compact ? page.rows.slice(0, 5) : page.rows).map(row => <tr key={row.id}><td><button className="text-button" onClick={() => onEdit(row)}>{row.title}</button></td><td>{table === 'Costs' ? `${ringgit.format(Number(row.fields['Planned amount']) || 0)} / ${ringgit.format(Number(row.fields['Actual amount']) || 0)}` : table === 'Members' ? row.fields.role : row.owner || '–'}</td>{table !== 'Members' && <><td>{shortDate(row.plannedEnd)}</td><td>{row.status}</td></>}</tr>)}</tbody></table></div>
    {(info || !page.rows.length) && <p className="schedule-empty" role="status">{info || 'No records yet.'}</p>}
    {!compact && page.total > 100 && <div className="pagination"><button disabled={!offset} onClick={() => setOffset(offset - 100)}>Previous</button><span>{offset + 1}–{Math.min(offset + 100, page.total)} of {page.total}</span><button disabled={offset + 100 >= page.total} onClick={() => setOffset(offset + 100)}>Next</button></div>}
  </section>;
}

createRoot(document.getElementById('root')!).render(<App />);
