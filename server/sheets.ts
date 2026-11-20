import { GoogleAuth } from 'google-auth-library';
import { applyChanges, emptyData, ScheduleIndex, summaries, tables, taskWarnings, today, ValidationError, type Change, type Data, type Filters, type RecordData, type ScheduleRow, type Table } from '../shared/model';

const columns = ['ID', 'Version', 'Name', 'Project ID', 'Phase', 'Owner', 'Planned Start', 'Planned End', 'Actual Start', 'Actual End', 'Status', '% Complete', 'Dependency IDs', 'Notes', 'Code', 'Module fields', 'Archived'];
const ledger = ['Operations', 'History'] as const;
type Ledger = typeof ledger[number];
type Sheet = Table | Ledger;
type Cell = string | number | boolean;
export interface Environment { spreadsheetId: string; lockBucket: string }
const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/spreadsheets', 'https://www.googleapis.com/auth/devstorage.read_write'] });
const q = (title: string) => `'${title}'`;
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
function encode(row: RecordData): Cell[] {
  return [row.id, row.version, row.title, row.projectId, row.phase, row.owner, row.plannedStart, row.plannedEnd, row.actualStart, row.actualEnd, row.status, row.progress, JSON.stringify(row.dependencies), row.notes, row.code, JSON.stringify(row.fields), row.archived];
}
function decode(values: Cell[]): RecordData {
  const [id, version, title, projectId, phase, owner, plannedStart, plannedEnd, actualStart, actualEnd, status, progress, dependencies, notes, code, fields, archived] = values;
  return { id: String(id), version: Number(version), title: String(title || ''), projectId: String(projectId || ''), phase: String(phase || ''), owner: String(owner || ''), plannedStart: String(plannedStart || ''), plannedEnd: String(plannedEnd || ''), actualStart: String(actualStart || ''), actualEnd: String(actualEnd || ''), status: status as RecordData['status'], progress: Number(progress) || 0, dependencies: JSON.parse(String(dependencies || '[]')), notes: String(notes || ''), code: String(code || ''), fields: JSON.parse(String(fields || '{}')), archived: archived === true };
}
function rowData(values: Cell[]) {
  return { values: values.map(value => ({ userEnteredValue: typeof value === 'string' ? { stringValue: value } : typeof value === 'number' ? { numberValue: value } : { boolValue: value } })) };
}

interface Snapshot { data: Data; rows: Record<Table, Map<string, number>>; counts: Record<Sheet, number>; operations: Cell[][]; ids: Record<Sheet, number>; grids: Record<Sheet, number>; revision: string }
export interface SaveResult { warnings: string[] }

export class SheetsStore {
  private loaded: Snapshot | undefined;
  private checkedAt = 0;
  private pending: Promise<Snapshot> | null = null;
  private index?: ScheduleIndex;
  private viewCache = new Map<string, ScheduleRow[]>();
  private summaryCache?: ReturnType<typeof summaries>;
  private day = '';
  private serial: Promise<unknown> = Promise.resolve();
  constructor(readonly env: Environment) {}
  private root = () => `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(this.env.spreadsheetId)}`;
  private async request<T>(url: string, method = 'GET', data?: unknown): Promise<T> {
    return (await (await auth.getClient()).request<T>({ url, method, data, retry: method === 'GET' })).data;
  }
  private async read(range: string) {
    const result = await this.request<{ values?: Cell[][] }>(`${this.root()}/values/${encodeURIComponent(range)}?valueRenderOption=UNFORMATTED_VALUE`);
    return result.values ?? [];
  }
  private batch(requests: unknown[]) { return this.request(`${this.root()}:batchUpdate`, 'POST', { requests }); }

  async initialise() {
    const result = await this.request<{ sheets: { properties: { title: string; sheetId: number } }[] }>(`${this.root()}?fields=sheets.properties(title,sheetId)`);
    const existing = new Set(result.sheets.map(sheet => sheet.properties.title));
    const missing = [...tables, ...ledger].filter(name => !existing.has(name));
    if (missing.length) await this.batch(missing.map(title => ({ addSheet: { properties: { title, gridProperties: { rowCount: 1000, columnCount: 17, frozenRowCount: 1 } } } })));
    const headers: Record<Ledger, Cell[]> = { Operations: ['Operation ID', 'Actor', 'Fingerprint', 'Committed', 'Warnings'], History: ['Operation ID', 'Timestamp', 'Actor', 'Table', 'Record ID', 'Version', 'Before', 'After'] };
    for (const title of [...tables, ...ledger]) {
      if ((await this.read(`${q(title)}!A1:A1`)).length) continue;
      const range = `${q(title)}!A1`;
      await this.request(`${this.root()}/values/${encodeURIComponent(range)}?valueInputOption=RAW`, 'PUT', { range, values: [[...(ledger.includes(title as Ledger) ? headers[title as Ledger] : columns)]] });
    }
  }

  async snapshot(force = false): Promise<Snapshot> {
    if (!force && this.loaded && Date.now() - this.checkedAt < 4000) return this.loaded;
    if (this.pending) { const result = await this.pending; return force ? this.snapshot(true) : result; }
    const pending = this.readSnapshot();
    this.pending = pending;
    try { return await pending; } finally { if (this.pending === pending) this.pending = null; }
  }
  private async readSnapshot(): Promise<Snapshot> {
    // The history sheet is append-only. The Operations row count is the shared revision.
    const opIds = await this.read("'Operations'!A2:A");
    const revision = `${opIds.length}:${opIds.at(-1)?.[0] ?? 'initial'}`;
    if (this.loaded?.revision === revision) { this.checkedAt = Date.now(); return this.loaded; }
    const metadata = await this.request<{ sheets: { properties: { title: Sheet; sheetId: number; gridProperties: { rowCount: number } } }[] }>(`${this.root()}?fields=sheets.properties(title,sheetId,gridProperties(rowCount))`);
    const ids = Object.fromEntries(metadata.sheets.map(sheet => [sheet.properties.title, sheet.properties.sheetId])) as Snapshot['ids'];
    const grids = Object.fromEntries(metadata.sheets.map(sheet => [sheet.properties.title, sheet.properties.gridProperties.rowCount])) as Snapshot['grids'];
    if ([...tables, ...ledger].some(title => ids[title] === undefined)) throw new Error('Set up the planner spreadsheet before connecting the team.');
    const data = emptyData();
    const rows = {} as Snapshot['rows'];
    const counts = {} as Snapshot['counts'];
    for (const title of tables) {
      rows[title] = new Map();
      const list = await this.read(`${q(title)}!A2:A`);
      counts[title] = list.length + 1;
      for (let first = 2; first <= counts[title]; first += 2500) {
        const block = await this.read(`${q(title)}!A${first}:Q${Math.min(first + 2499, counts[title])}`);
        block.forEach((line, offset) => {
          if (!line[0]) return;
          const row = decode(line);
          if (rows[title].has(row.id)) throw new Error('Duplicate IDs found in the spreadsheet.');
          rows[title].set(row.id, first + offset - 1);
          data[title].push(row);
        });
      }
    }
    const operations = await this.read("'Operations'!A2:E");
    counts.Operations = operations.length + 1;
    counts.History = (await this.read("'History'!A2:A")).length + 1;
    const check = await this.read("'Operations'!A2:A");
    if (revision !== `${check.length}:${check.at(-1)?.[0] ?? 'initial'}`) throw new Error('The workspace changed during refresh. Try again.');
    this.loaded = { data, rows, operations, counts, ids, grids, revision };
    this.checkedAt = Date.now();
    this.index = undefined;
    this.summaryCache = undefined;
    this.viewCache.clear();
    return this.loaded;
  }

  private resetDateCache() {
    const date = today();
    if (date === this.day) return;
    this.day = date; this.index = undefined; this.summaryCache = undefined; this.viewCache.clear();
  }
  async projectSummaries() {
    const state = await this.snapshot();
    this.resetDateCache();
    return this.summaryCache ??= summaries(state.data, this.day);
  }
  async schedule(filters: Filters) {
    const state = await this.snapshot();
    this.resetDateCache();
    const key = JSON.stringify(filters);
    if (this.viewCache.has(key)) return this.viewCache.get(key)!;
    const result = (this.index ??= new ScheduleIndex(state.data)).view(filters);
    if (this.viewCache.size >= 12) this.viewCache.delete(this.viewCache.keys().next().value!);
    this.viewCache.set(key, result);
    return result;
  }

  save(actor: string, operationId: string, fingerprint: string, changes: Change[], allow: (data: Data) => void): Promise<SaveResult> {
    const work = this.serial.then(() => this.withLock('writer', () => this.commit(actor, operationId, fingerprint, changes, allow)));
    this.serial = work.catch(() => undefined);
    return work;
  }

  private async commit(actor: string, operationId: string, fingerprint: string, changes: Change[], allow: (data: Data) => void) {
    const state = await this.snapshot(true);
    allow(state.data);
    const committed = state.operations.find(row => row[0] === operationId);
    if (committed) {
      if (committed[1] !== actor || committed[2] !== fingerprint) throw new ValidationError('This operation ID belongs to a different edit.');
      return { warnings: JSON.parse(String(committed[4] || '[]')) as string[] };
    }
    const next = applyChanges(state.data, changes);
    const when = new Date().toISOString();
    const warnings = changes.length === 1 && changes[0].table === 'Tasks' ? taskWarnings(changes[0].record, next.data.Tasks).slice(0, 10) : [];
    const counts = { ...state.counts };
    const grids = { ...state.grids };
    const requests: unknown[] = [];
    const updates = new Map<Sheet, { index: number; value: Cell[] }[]>();
    const append = (title: Sheet, value: Cell[], index?: number) => {
      const entries = updates.get(title) ?? [];
      if (index === undefined) index = counts[title]++;
      entries.push({ index, value });
      updates.set(title, entries);
    };
    for (const { table, before, after } of next.audited) {
      append(table, encode(after), state.rows[table].get(after.id));
      append('History', [operationId, when, actor, table, after.id, after.version, before ? JSON.stringify(before) : '', JSON.stringify(after)]);
    }
    append('Operations', [operationId, actor, fingerprint, when, JSON.stringify(warnings)]);
    for (const [title, entries] of updates) {
      const sheetId = state.ids[title];
      if (counts[title] > grids[title]) {
        requests.push({ appendDimension: { sheetId, dimension: 'ROWS', length: counts[title] - grids[title] + 250 } });
        grids[title] = counts[title] + 250;
      }
      entries.sort((a, b) => a.index - b.index);
      for (let start = 0; start < entries.length;) {
        let end = start + 1;
        while (end < entries.length && entries[end].index === entries[end - 1].index + 1) end++;
        requests.push({ updateCells: { start: { sheetId, rowIndex: entries[start].index, columnIndex: 0 }, rows: entries.slice(start, end).map(entry => rowData(entry.value)), fields: 'userEnteredValue' } });
        start = end;
      }
    }
    if (Buffer.byteLength(JSON.stringify(requests)) > 5_000_000) throw new ValidationError('This import is too large for one save. Import smaller project batches.');
    try { await this.batch(requests); }
    catch (error) {
      const status = (error as { response?: { status: number } }).response?.status;
      if ((!status || status >= 500) && (await this.read(`'Operations'!A${counts.Operations}:E${counts.Operations}`).catch(() => []))[0]?.[0] === operationId) {
        this.checkedAt = 0;
        return { warnings };
      }
      // A missing/5xx response can arrive while Sheets still has the write in flight.
      // Hold the lease for Google's 180s request deadline before another writer may proceed.
      if (!status || status >= 500) await delay(185_000);
      const recovered = (!status || status >= 500) && (await this.read(`'Operations'!A${counts.Operations}:E${counts.Operations}`).catch(() => []))[0]?.[0] === operationId;
      this.checkedAt = 0;
      if (recovered) return { warnings };
      throw error;
    }
    const rows = { ...state.rows };
    for (const table of tables) if (updates.has(table)) {
      rows[table] = new Map(rows[table]);
      for (const { value, index } of updates.get(table)!) rows[table].set(String(value[0]), index);
    }
    this.loaded = { data: next.data, rows, counts, grids, ids: state.ids, operations: [...state.operations, [operationId, actor, fingerprint, when, JSON.stringify(warnings)]], revision: `${counts.Operations - 1}:${operationId}` };
    this.checkedAt = Date.now();
    this.index = undefined; this.summaryCache = undefined; this.viewCache.clear();
    return { warnings };
  }

  // The generation precondition keeps this lock exclusive across Cloud Run instances and revisions.
  async withLock<T>(purpose: string, transaction: () => Promise<T>): Promise<T> {
    const name = `katakkembung1-${this.env.spreadsheetId}-${purpose}.lock`;
    const bucket = encodeURIComponent(this.env.lockBucket);
    const object = encodeURIComponent(name);
    const endpoint = `https://storage.googleapis.com/storage/v1/b/${bucket}/o/${object}`;
    const upload = `https://storage.googleapis.com/upload/storage/v1/b/${bucket}/o?uploadType=media&name=${object}&ifGenerationMatch=0`;
    let generation = '';
    for (let attempt = 0; attempt < 50; attempt++) {
      try {
        generation = (await this.request<{ generation: string }>(upload, 'POST', new Date().toISOString())).generation;
        break;
      } catch (error) {
        if ((error as { response?: { status: number } }).response?.status !== 412) throw error;
        await delay(250 + Math.round(Math.random() * 150));
      }
    }
    if (!generation) throw new Error('The workspace is saving another change. Retry in a moment.');
    try { return await transaction(); }
    finally { await this.request(`${endpoint}?ifGenerationMatch=${generation}`, 'DELETE').catch(error => console.error('Could not release workspace lock', (error as Error).message.slice(0, 120))); }
  }
}
