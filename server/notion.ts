import { createHash } from 'node:crypto';
import type { ProjectSummary } from '../shared/model';

export interface NotionSettings { token: string; source: string; site: string }
type Property = { rich_text?: { plain_text: string }[] };
type Page = { id: string; properties: Record<string, Property> };
const rich = (content: string) => [{ type: 'text', text: { content } }];
const range = (start: string, end: string) => start ? { start, end: end || null } : null;
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export async function syncSummaries(settings: NotionSettings, projects: ProjectSummary[]) {
  async function call<T>(path: string, method: string, body: unknown): Promise<T> {
    for (let attempt = 0; attempt < 4; attempt++) {
      const response = await fetch(`https://api.notion.com/v1${path}`, { method, headers: { Authorization: `Bearer ${settings.token}`, 'Notion-Version': '2026-03-11', 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(25_000) });
      if (response.ok) return await response.json() as T;
      if (![429, 529].includes(response.status)) throw new Error(`Notion ${method} failed (${response.status}). Check the integration permission and database properties.`);
      await sleep(Math.max(1, Number(response.headers.get('Retry-After')) || 2 ** attempt) * 1000);
    }
    throw new Error('Notion is rate limited. The next scheduled sync will retry.');
  }
  const destination = new Map<string, Page>();
  let cursor: string | undefined;
  do {
    const result = await call<{ results: Page[]; next_cursor: string | null; request_status?: { type: string } }>(`/data_sources/${settings.source}/query`, 'POST', { page_size: 100, start_cursor: cursor });
    if (result.request_status?.type === 'incomplete') throw new Error('Use a dedicated Notion data source for project summaries.');
    for (const page of result.results) {
      const id = page.properties['Project ID']?.rich_text?.map(part => part.plain_text).join('');
      if (!id) continue;
      if (destination.has(id)) throw new Error('Duplicate Project ID in the Notion summary. Resolve the duplicate before syncing.');
      destination.set(id, page);
    }
    cursor = result.next_cursor || undefined;
    if (cursor) await sleep(360);
  } while (cursor);

  let updated = 0;
  let pending = 0;
  for (const project of projects) {
    const actual = range(project.actualStart, project.actualEnd);
    const planned = range(project.plannedStart, project.plannedEnd);
    const digest = createHash('sha256').update(JSON.stringify([project.title, project.status, planned, actual, project.progress, project.overdue, settings.site])).digest('hex');
    const existing = destination.get(project.id);
    if (existing?.properties['Sync revision']?.rich_text?.[0]?.plain_text === digest) continue;
    if (updated >= 80) { pending++; continue; }
    const properties = {
      Name: { title: rich(project.title) }, 'Project ID': { rich_text: rich(project.id) }, Status: { select: { name: project.status } },
      Planned: { date: planned }, Actual: { date: actual }, 'Progress percent': { number: project.progress }, Overdue: { number: project.overdue },
      'Last synced': { date: { start: new Date().toISOString() } }, 'Sync revision': { rich_text: rich(digest) },
      Planner: { url: `${settings.site.replace(/\/$/, '')}/#/gantt?project=${encodeURIComponent(project.id)}` },
    };
    if (existing) await call(`/pages/${existing.id}`, 'PATCH', { properties });
    else await call('/pages', 'POST', { parent: { type: 'data_source_id', data_source_id: settings.source }, properties });
    updated++;
    await sleep(360);
  }
  return { updated, pending };
}
