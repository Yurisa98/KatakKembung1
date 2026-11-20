import ExcelJS from 'exceljs';
import { addDays, applyChanges, defaultProgress, emptyData, makeRecord, statuses, tables, type Change, type Data, type Module, type RecordData, type Status } from '../shared/model';

export interface ImportPreview { file: string; data: Data; warnings: string[]; errors: string[] }
type Cell = ExcelJS.CellValue;
const unwrap = (value: Cell): unknown => {
  if (value && typeof value === 'object') {
    if ('result' in value) return value.result;
    if ('text' in value) return value.text;
    if ('richText' in value) return value.richText.map(part => part.text).join('');
  }
  return value;
};
const str = (value: Cell) => { const v = unwrap(value); return typeof v === 'string' || typeof v === 'number' ? String(v).trim() : ''; };
const scalar = (value: Cell) => { const v = unwrap(value); return typeof v === 'number' && Number.isFinite(v) ? v : str(value); };
const dateCell = (value: Cell, date1904: boolean) => {
  const v = unwrap(value);
  if (v instanceof Date) return Number.isFinite(v.valueOf()) ? v.toISOString().slice(0, 10) : '';
  if (typeof v === 'number' && v > 0 && v < 2_958_466) return addDays(date1904 ? '1904-01-01' : '1899-12-30', Math.floor(v));
  return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v.trim()) ? v.trim() : '';
};

export async function importWorkbook(file: string, buffer: ArrayBuffer): Promise<ImportPreview> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  const data = emptyData();
  const warnings: string[] = [];
  const errors: string[] = [];
  const projects = new Map<string, RecordData>();
  const origin = crypto.randomUUID();
  const status = (text: string): Status => statuses.find(value => value.toLowerCase() === text.toLowerCase()) ?? 'Not Started';
  const dateOf = (row: ExcelJS.Row, i: number) => dateCell(row.getCell(i).value, !!workbook.properties.date1904);
  const value = (row: ExcelJS.Row, i: number) => str(row.getCell(i).value);
  function project(name: string, extra: Partial<RecordData> = {}) {
    if (!name) return '';
    if (!projects.has(name)) {
      const record = makeRecord({ id: `${origin}-p${projects.size + 1}`, title: name, ...extra });
      projects.set(name, record);
    } else Object.assign(projects.get(name)!, extra);
    return projects.get(name)!.id;
  }

  workbook.getWorksheet('Setup')?.eachRow((row, number) => { if (number > 8) project(value(row, 11)); });
  workbook.getWorksheet('Charter')?.eachRow((row, number) => {
    if (number < 6 || !value(row, 3)) return;
    project(value(row, 3), { code: value(row, 4), owner: value(row, 6), plannedStart: dateOf(row, 7), plannedEnd: dateOf(row, 8), notes: [10, 11, 12].map(i => value(row, i)).filter(Boolean).join('\n\n'), fields: { Sponsor: value(row, 5), Capex: scalar(row.getCell(9).value), Opex: scalar(row.getCell(10).value) } });
  });

  const source = workbook.getWorksheet('Tasks');
  if (!source || value(source.getRow(7), 5).toUpperCase() !== 'TASK DESCRIPTION') throw new Error('This workbook does not have the supported Tasks layout.');
  const refs: { task: RecordData; ids: string[]; number: number }[] = [];
  const ids = new Map<string, string>();
  source.eachRow((row, number) => {
    if (number < 8 || !value(row, 5)) return;
    const plannedStart = dateOf(row, 6);
    const plannedEnd = dateOf(row, 7);
    const projectId = project(value(row, 3));
    const code = value(row, 2);
    if (!projectId || !plannedStart || !plannedEnd || plannedEnd < plannedStart) { errors.push(`Tasks row ${number}: check project and planned dates.`); return; }
    const originalStatus = value(row, 8);
    const state = status(originalStatus);
    const task = makeRecord({ id: `${origin}-t${number}`, title: value(row, 5), projectId, code, plannedStart, plannedEnd, phase: value(row, 4), owner: value(row, 9), status: state,
      progress: defaultProgress(state, 0), fields: { Priority: value(row, 10), Effort: value(row, 11), 'Original status': originalStatus } });
    if (code) ids.set(`${projectId}:${code.toLowerCase()}`, task.id);
    const raw = value(row, 12);
    refs.push({ task, number, ids: raw && raw !== '0' ? raw.split(/[,;\n]/).map(id => id.trim()).filter(Boolean) : [] });
    data.Tasks.push(task);
  });
  for (const { task, ids: dependencies, number } of refs) for (const code of dependencies) {
    const id = ids.get(`${task.projectId}:${code.toLowerCase()}`);
    if (id) task.dependencies.push(id);
    else warnings.push(`Tasks row ${number}: dependency ${code} did not match a task in the same project.`);
  }
  const schedule = workbook.getWorksheet('Schedule');
  if (schedule) {
    const keys = new Set(data.Tasks.map(task => `${task.projectId}:${task.title}:${task.plannedStart}:${task.plannedEnd}`));
    let mismatches = 0;
    schedule.eachRow((row, number) => {
      if (number < 8 || !value(row, 4)) return;
      const phaseProject = projects.get(value(row, 2));
      if (!keys.has(`${phaseProject?.id}:${value(row, 4)}:${dateOf(row, 5)}:${dateOf(row, 6)}`)) mismatches++;
    });
    if (mismatches) warnings.push(`${mismatches} Schedule rows did not match the Tasks sheet. Tasks was used as the source.`);
  }
  type Mapping = { first: number; title: number; projectCol?: number; owner?: number; code?: number; due?: number; state?: number; fields: Record<string, number> };
  const mapping: Record<Module, Mapping> = {
    Deliverables: { first: 6, title: 4, projectCol: 3, code: 2, due: 5, state: 6, owner: 7, fields: { Approver: 8, Link: 10 } },
    'Risks & Issues': { first: 8, title: 6, projectCol: 5, code: 2, state: 10, owner: 11, due: 13, fields: { Type: 3, Impact: 7, Likelihood: 8, Mitigation: 9 } },
    Resources: { first: 6, title: 2, owner: 7, fields: { Role: 3, Phone: 4, Email: 5, Department: 6, Rate: 8, Frequency: 9 } },
    Stakeholders: { first: 6, title: 3, projectCol: 2, due: 11, fields: { Role: 4, Influence: 5, Interest: 6, Communication: 9 } },
    Costs: { first: 8, title: 4, projectCol: 2, due: 11, fields: { Category: 3, Supplier: 5, 'Planned amount': 6, 'Actual amount': 7, Paid: 9, Terms: 12, 'Purchase order': 13, Invoice: 14 } },
  };
  for (const table of Object.keys(mapping) as Module[]) {
    const m = mapping[table];
    workbook.getWorksheet(table)?.eachRow((row, number) => {
      if (number < m.first || !value(row, m.title)) return;
      const fields = Object.fromEntries(Object.entries(m.fields).map(([label, i]) => [label, scalar(row.getCell(i).value)]));
      if (m.state) fields['Original status'] = value(row, m.state);
      const originalStatus = m.state ? value(row, m.state) : '';
      const state = /^(approved|closed|paid)$/i.test(originalStatus) ? 'Completed' : /^(open|in review)$/i.test(originalStatus) ? 'In Progress' : status(originalStatus);
      data[table].push(makeRecord({ title: value(row, m.title), projectId: m.projectCol ? project(value(row, m.projectCol)) : '', code: m.code ? value(row, m.code) : '', owner: m.owner ? value(row, m.owner) : '', plannedEnd: m.due ? dateOf(row, m.due) : '', status: state, progress: defaultProgress(state, 0), fields }));
    });
  }
  data.Projects = [...projects.values()];
  if (data.Tasks.length) warnings.unshift('The workbook does not supply task actual dates or percentages. Actual dates are blank and percentages use status defaults.');
  try { if (data.Tasks.length || data.Projects.length) applyChanges(emptyData(), tables.flatMap(table => data[table].map(record => ({ table, record, expectedVersion: 0 })))); }
  catch (error) { errors.push((error as Error).message); }
  return { file, data, warnings, errors };
}

export function importChanges(data: Data, existing: Data): Change[] {
  const projects = new Map(existing.Projects.filter(row => !row.archived).map(row => [row.title.toLowerCase(), row]));
  const map = new Map(data.Projects.map(project => [project.id, projects.get(project.title.toLowerCase())?.id || project.id]));
  const changes: Change[] = [];
  for (const table of tables) {
    if (table === 'Members') continue;
    for (const record of data[table]) {
      if (table === 'Projects' && map.get(record.id) !== record.id) continue;
      changes.push({ table, record: { ...record, projectId: map.get(record.projectId) || record.projectId }, expectedVersion: 0 });
    }
  }
  return changes;
}
