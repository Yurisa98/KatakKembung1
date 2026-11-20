export const statuses = ['Not Started', 'In Progress', 'On Hold', 'Completed'] as const;
export type Status = typeof statuses[number];
export type Role = 'Owner' | 'Editor' | 'Viewer';
export const modules = ['Deliverables', 'Risks & Issues', 'Resources', 'Costs', 'Stakeholders'] as const;
export type Module = typeof modules[number];
export const scales = ['Week', 'Month', 'Quarter', 'Year'] as const;
export type Scale = typeof scales[number];
export type Table = 'Projects' | 'Tasks' | 'Members' | Module;
export const tables: Table[] = ['Projects', 'Tasks', ...modules, 'Members'];
export interface RecordData {
  id: string; version: number; title: string; projectId: string; phase: string; owner: string;
  plannedStart: string; plannedEnd: string; actualStart: string; actualEnd: string;
  status: Status; progress: number; dependencies: string[]; notes: string; code: string;
  fields: { [key: string]: string | number }; archived: boolean;
}
export type Data = Record<Table, RecordData[]>;
export interface Change { table: Table; record: RecordData; expectedVersion: number }
export interface ProjectSummary extends RecordData { tasks: number; done: number; overdue: number; planned: number }
export interface Filters { project: string; q: string; start: string; end: string; status: string; phase?: string }
export interface ScheduleRow { kind: 'project' | 'phase' | 'task'; key: string; record: RecordData; count?: number }
export const emptyData = () => Object.fromEntries(tables.map(table => [table, []])) as unknown as Data;
export const makeRecord = (overrides: Partial<RecordData> = {}): RecordData => ({
  id: globalThis.crypto.randomUUID(), version: 0, title: '', projectId: '', phase: '', owner: '',
  plannedStart: '', plannedEnd: '', actualStart: '', actualEnd: '', code: '',
  status: 'Not Started', progress: 0, dependencies: [], notes: '', fields: {}, archived: false, ...overrides,
});

const dayMs = 86_400_000;
export const day = (date: string) => Date.parse(`${date}T00:00:00Z`) / dayMs;
export const date = (ordinal: number) => new Date(ordinal * dayMs).toISOString().slice(0, 10);
export const addDays = (value: string, count: number) => date(day(value) + count);
export const today = () => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Kuala_Lumpur', dateStyle: 'short' }).format(new Date());
export const shortDate = (value: string) => value ? new Intl.DateTimeFormat('en-MY', { day: 'numeric', month: 'short', timeZone: 'UTC' }).format(new Date(day(value) * dayMs)) : '–';
const validDate = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(day(value)) && date(day(value)) === value;
export function addYears(value: string, years: number) {
  const y = String(Number(value.slice(0, 4)) + years).padStart(4, '0');
  const result = y + value.slice(4);
  return validDate(result) ? result : `${y}-02-28`;
}
export function periodStart(value: string, scale: Scale) {
  const [year, month] = value.split('-');
  if (scale === 'Week') return addDays(value, -((day(value) + 3) % 7 + 7) % 7);
  if (scale === 'Month') return `${year}-${month}-01`;
  if (scale === 'Quarter') return `${year}-${String(Math.floor((Number(month) - 1) / 3) * 3 + 1).padStart(2, '0')}-01`;
  return `${year}-01-01`;
}
export function nextPeriod(start: string, scale: Scale, amount = 1) {
  if (scale === 'Week') return addDays(start, amount * 7);
  const d = new Date(day(start) * dayMs);
  d.setUTCMonth(d.getUTCMonth() + (scale === 'Month' ? 1 : scale === 'Quarter' ? 3 : 12) * amount);
  return d.toISOString().slice(0, 10);
}
export function periods(from: string, end: string, scale: Scale) {
  const values: string[] = [];
  for (let start = periodStart(from, scale); start < end; start = nextPeriod(start, scale)) values.push(start);
  return values;
}
export function shift(record: RecordData, movement: number, edge: 'move' | 'start' | 'end') {
  const start = addDays(record.plannedStart, movement);
  const end = addDays(record.plannedEnd, movement);
  return { ...record,
    plannedStart: edge === 'end' ? record.plannedStart : edge === 'start' && start > record.plannedEnd ? record.plannedEnd : start,
    plannedEnd: edge === 'start' ? record.plannedEnd : edge === 'end' && end < record.plannedStart ? record.plannedStart : end,
  };
}
export const defaultProgress = (status: Status, current: number) => ({ 'Not Started': 0, 'In Progress': 50, Completed: 100, 'On Hold': current })[status];
export function taskWarnings(row: RecordData, tasks: Iterable<RecordData>): string[] {
  const warnings = [];
  if (row.status === 'Completed' && !row.actualEnd) warnings.push('Enter Actual End to record when the task finished.');
  if ((row.status === 'Completed' && row.progress !== 100) || (row.status === 'Not Started' && row.progress !== 0) || (row.status === 'In Progress' && (row.progress === 0 || row.progress === 100))) warnings.push('Completion percentage and task status differ.');
  for (const other of tasks) {
    if (other.id === row.id || other.archived) continue;
    if ((row.dependencies.includes(other.id) && other.plannedEnd >= row.plannedStart) || (other.dependencies.includes(row.id) && row.plannedEnd >= other.plannedStart)) warnings.push(`Check dependency timing with ${other.code || other.title}.`);
  }
  return warnings;
}

export class ValidationError extends Error {}
export class Conflict extends Error {
  constructor(public current: RecordData | undefined) { super('Another editor changed this record. Review the latest version before saving.'); }
}
const idPattern = /^[a-zA-Z0-9._-]{1,100}$/;
function validateRecord(table: Table, row: RecordData) {
  const fail = (message: string): never => { throw new ValidationError(message); };
  if (!row || typeof row.id !== 'string' || !idPattern.test(row.id) || typeof row.archived !== 'boolean') fail('Invalid record ID or archive state.');
  for (const key of ['title','code','phase','projectId','owner','notes','plannedStart','plannedEnd','actualStart','actualEnd'] as const) {
    if (typeof row[key] !== 'string' || row[key].length > (key === 'notes' ? 8000 : 300)) fail(`Invalid ${key}.`);
  }
  if (!row.title.trim()) fail('Enter a name.');
  if (!statuses.includes(row.status) || !Number.isInteger(row.progress) || row.progress < 0 || row.progress > 100) fail('Choose a status and a whole percentage from 0 to 100.');
  if (!Array.isArray(row.dependencies) || row.dependencies.length > 100 || row.dependencies.some(id => typeof id !== 'string' || !idPattern.test(id)) || new Set(row.dependencies).size !== row.dependencies.length) fail('Enter up to 100 unique dependency IDs.');
  if (!row.fields || Object.getPrototypeOf(row.fields) !== Object.prototype || Object.entries(row.fields).length > 40 || Object.entries(row.fields).some(([key, val]) => !/^[a-zA-Z][a-zA-Z0-9 ]{0,59}$/.test(key) || (typeof val === 'string' ? val.length > 2000 : typeof val !== 'number' || !Number.isFinite(val)))) fail('Invalid module details.');
  for (const value of [row.plannedStart, row.plannedEnd, row.actualStart, row.actualEnd]) if (value && !validDate(value)) fail('Enter a valid date.');
  if (table === 'Tasks' && (!row.plannedStart || !row.plannedEnd)) fail('Enter both planned dates.');
  if (row.plannedEnd && row.plannedStart && row.plannedEnd < row.plannedStart) fail('Planned end must be on or after planned start.');
  if (row.actualEnd && (!row.actualStart || row.actualEnd < row.actualStart)) fail('Actual end needs an actual start on or before it.');
  if (table === 'Members' && (!['Owner','Editor','Viewer'].includes(String(row.fields.role)) || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(row.title))) fail('Enter a Google account email and a role.');
}

export function applyChanges(data: Data, changes: Change[], preserveVersions = false) {
  if (!Array.isArray(changes) || !changes.length) throw new ValidationError('There are no changes to save.');
  const maps = Object.fromEntries(tables.map(table => [table, new Map(data[table].map(row => [row.id, row]))])) as Record<Table, Map<string, RecordData>>;
  const changed = new Set<string>();
  const audited = changes.map(change => {
    if (!change || !tables.includes(change.table)) throw new ValidationError('Unknown table.');
    const { table, record, expectedVersion } = change;
    validateRecord(table, record);
    const key = `${table}:${record.id}`;
    if (changed.has(key)) throw new ValidationError('A record appears twice in this save.');
    changed.add(key);
    const before = maps[table].get(record.id);
    if ((before?.version ?? 0) !== expectedVersion) throw new Conflict(before);
    const after = { ...record, title: record.title.trim(), version: preserveVersions ? Math.max(1, record.version) : expectedVersion + 1 };
    maps[table].set(record.id, after);
    return { table, before, after };
  });
  const activeProjects = [...maps.Projects.values()].filter(project => !project.archived);
  if (activeProjects.length > 500) throw new ValidationError('This workspace supports up to 500 active projects.');
  const activeTasks = [...maps.Tasks.values()].filter(task => !task.archived);
  if (activeTasks.length > 50000) throw new ValidationError('This workspace supports up to 50,000 active tasks.');
  const counts = new Map<string, { count: number; from: string; to: string }>();
  for (const project of activeProjects) {
    const dates = [project.plannedStart, project.plannedEnd, project.actualStart, project.actualEnd].filter(Boolean).sort();
    counts.set(project.id, { count: 0, from: dates[0] || '', to: dates.at(-1) || '' });
  }
  const codes = new Set<string>();
  const remaining = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const task of activeTasks) {
    const project = counts.get(task.projectId);
    if (!project) throw new ValidationError(`Choose an active project for ${task.title}.`);
    project.count++;
    const dates = [task.plannedStart, task.plannedEnd, task.actualStart, task.actualEnd].filter(Boolean).sort();
    if (!project.from || dates[0] < project.from) project.from = dates[0];
    if (!project.to || dates.at(-1)! > project.to) project.to = dates.at(-1)!;
    const code = `${task.projectId}:${task.code.toLowerCase()}`;
    if (task.code && codes.has(code)) throw new ValidationError(`Duplicate task code ${task.code} in the same project.`);
    codes.add(code);
    remaining.set(task.id, task.dependencies.length);
    for (const id of task.dependencies) {
      if (!maps.Tasks.has(id) || maps.Tasks.get(id)?.archived || id === task.id) throw new ValidationError(`Invalid dependency for ${task.title}.`);
      const refs = dependents.get(id) ?? [];
      refs.push(task.id);
      dependents.set(id, refs);
    }
  }
  const ready = activeTasks.filter(task => !task.dependencies.length).map(task => task.id);
  for (let position = 0; position < ready.length; position++) for (const id of dependents.get(ready[position]) ?? []) {
    const count = remaining.get(id)! - 1;
    remaining.set(id, count);
    if (count === 0) ready.push(id);
  }
  if (ready.length !== activeTasks.length) throw new ValidationError('These dependencies create a circular schedule.');
  for (const { count, from, to } of counts.values()) {
    if (count > 10000) throw new ValidationError('A project supports up to 10,000 active tasks.');
    if (from && to && to >= addYears(from, 10)) throw new ValidationError('The project schedule exceeds 10 years.');
  }
  for (const module of modules) for (const row of maps[module].values()) {
    if (!row.archived && row.projectId && !counts.has(row.projectId)) throw new ValidationError(`Choose an active project for ${row.title}.`);
  }
  return { data: Object.fromEntries(tables.map(table => [table, [...maps[table].values()]])) as Data, audited };
}

export function summaries(data: Data, asOf = today()): ProjectSummary[] {
  const map = new Map(data.Projects.filter(row => !row.archived).map(row => [row.id, {
    ...row, tasks: 0, done: 0, overdue: 0, planned: 0, progress: 0, weight: 0,
  }]));
  for (const task of data.Tasks) {
    const p = map.get(task.projectId);
    if (!p || task.archived) continue;
    p.tasks++;
    if (task.status === 'Completed') p.done++;
    else if (task.plannedEnd < asOf) p.overdue++;
    if (!p.plannedStart || task.plannedStart < p.plannedStart) p.plannedStart = task.plannedStart;
    if (task.plannedEnd > p.plannedEnd) p.plannedEnd = task.plannedEnd;
    if (task.actualStart && (!p.actualStart || task.actualStart < p.actualStart)) p.actualStart = task.actualStart;
    if (task.actualEnd > p.actualEnd) p.actualEnd = task.actualEnd;
    const duration = day(task.plannedEnd) - day(task.plannedStart) + 1;
    p.weight += duration;
    p.progress += task.progress * duration;
    p.planned += 100 * Math.max(0, Math.min(duration, day(asOf) - day(task.plannedStart) + 1));
  }
  return [...map.values()].map(({ weight, ...p }) => ({ ...p, progress: weight ? Math.round(p.progress / weight) : 0,
    planned: weight ? Math.round(p.planned / weight) : 0,
    status: !p.tasks ? p.status : p.tasks === p.done ? 'Completed' : p.status === 'On Hold' ? 'On Hold' : p.progress || p.actualStart ? 'In Progress' : 'Not Started',
  }));
}

export class ScheduleIndex {
  private byProject = new Map<string, RecordData[]>();
  private projects: ProjectSummary[];
  private matchKeys = new Map<string, string>();
  constructor(data: Data) {
    this.projects = summaries(data);
    for (const task of data.Tasks) {
      if (task.archived) continue;
      const group = this.byProject.get(task.projectId) ?? [];
      group.push(task);
      this.byProject.set(task.projectId, group);
      this.matchKeys.set(task.id, `${task.code} ${task.title} ${task.owner} ${task.phase}`.toLowerCase());
    }
  }
  view(filters: Filters): ScheduleRow[] {
    const q = filters.q.trim().toLowerCase();
    const currentDay = today();
    const rows: ScheduleRow[] = [];
    for (const project of this.projects) {
      if (filters.project && filters.project !== project.id) continue;
      const phases = new Map<string, RecordData[]>();
      let count = 0;
      for (const task of this.byProject.get(project.id) ?? []) {
        if (filters.status && task.status !== filters.status) continue;
        if (filters.phase && task.phase !== filters.phase) continue;
        if (q && !this.matchKeys.get(task.id)?.includes(q)) continue;
        const planned = task.plannedStart <= filters.end && task.plannedEnd >= filters.start;
        const actual = task.actualStart && task.actualStart <= filters.end && (task.actualEnd || currentDay) >= filters.start;
        if (!planned && !actual) continue;
        const group = phases.get(task.phase) ?? [];
        group.push(task);
        phases.set(task.phase, group);
        count++;
      }
      if (!count && (q || filters.status || filters.phase)) continue;
      rows.push({ kind: 'project', key: `project-${project.id}`, record: project, count });
      for (const [phase, tasks] of phases) {
        if (phase) rows.push({ kind: 'phase', key: `${project.id}:${phase}`, record: { ...project, title: phase, phase }, count: tasks.length });
        for (const task of tasks) rows.push({ kind: 'task', key: task.id, record: task });
      }
    }
    return rows;
  }
}
