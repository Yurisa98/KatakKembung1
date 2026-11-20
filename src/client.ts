import { applyChanges, Conflict, emptyData, ScheduleIndex, summaries, tables, taskWarnings, type Change, type Data, type Filters, type ProjectSummary, type RecordData, type Role, type ScheduleRow, type Table } from '../shared/model';
import { demoData } from './demo';

export interface Workspace { role: Role; projects: RecordData[]; summaries: ProjectSummary[]; revision: string }
export interface Page<T> { rows: T[]; total: number }
export interface Client {
  workspace(): Promise<Workspace>;
  schedule(filters: Filters, offset: number, limit: number): Promise<Page<ScheduleRow>>;
  list(table: Table, project: string, offset: number): Promise<Page<RecordData>>;
  save(changes: Change[], operationId: string): Promise<{ warnings: string[] }>;
  backup(): Promise<Data>;
}
export const apiUrl = import.meta.env.VITE_API_URL?.replace(/\/$/, '') || '';
export const googleClientId = import.meta.env.VITE_GOOGLE_CLIENT_ID || '';
const demoKey = 'katakkembung1-demo-v1';

export function localClient(): Client {
  let data: Data;
  try { data = JSON.parse(localStorage.getItem(demoKey) || 'null') || demoData(); }
  catch { data = demoData(); }
  let revision = crypto.randomUUID();
  let index = new ScheduleIndex(data);
  const operations = new Set<string>();
  return {
    async workspace() { return { role: 'Owner', projects: data.Projects, summaries: summaries(data), revision }; },
    async schedule(filters, offset, limit) { const rows = index.view(filters); return { rows: rows.slice(offset, offset + limit), total: rows.length }; },
    async list(table, project, offset) {
      const rows = data[table].filter(row => !row.archived && (!project || row.projectId === project));
      return { rows: rows.slice(offset, offset + 100), total: rows.length };
    },
    async save(changes, operationId) {
      if (operations.has(operationId)) return { warnings: [] };
      if (changes.some(change => change.table === 'Members') && changes.length > 1) throw new Error('Save member changes individually.');
      const candidate = applyChanges(data, changes);
      localStorage.setItem(demoKey, JSON.stringify(candidate.data));
      data = candidate.data;
      revision = crypto.randomUUID();
      index = new ScheduleIndex(data);
      operations.add(operationId);
      return { warnings: changes.filter(change => change.table === 'Tasks' && changes.length === 1).flatMap(change => taskWarnings(change.record, data.Tasks)) };
    },
    async backup() { return structuredClone(data); },
  };
}

export function remoteClient(token: string): Client {
  async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
    const response = await fetch(`${apiUrl}${path}`, { ...options, headers: { Authorization: `Bearer ${token}`, ...(options.body ? { 'Content-Type': 'application/json' } : {}) } });
    const value = await response.json();
    if (response.status === 409) throw new Conflict(value.current);
    if (!response.ok) throw new Error(value.error || 'The team server did not respond.');
    return value as T;
  }
  return {
    workspace: () => request('/workspace'),
    schedule: (filters, offset, limit) => request(`/schedule?${new URLSearchParams({ ...filters, offset: String(offset), limit: String(limit) })}`),
    list: (table, project, offset) => request(`/records?${new URLSearchParams({ table, project, offset: String(offset) })}`),
    save: (changes, operationId) => request('/save', { method: 'POST', body: JSON.stringify({ changes, operationId }) }),
    backup: () => request('/backup'),
  };
}

export function readBackup(value: unknown): Data {
  if (!value || typeof value !== 'object' || !('schema' in value) || value.schema !== 1 || !('data' in value) || !value.data || typeof value.data !== 'object') throw new Error('Choose a KatakKembung1 schema 1 JSON backup.');
  const raw = value.data as Data;
  const base = emptyData();
  for (const table of tables) if (!Array.isArray(raw[table])) throw new Error(`Backup is missing ${table}.`);
  const changes = tables.flatMap(table => raw[table].map(record => ({ table, record, expectedVersion: 0 })));
  return changes.length ? applyChanges(base, changes, true).data : base;
}
