import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import { OAuth2Client } from 'google-auth-library';
import { addYears, Conflict, day, tables, ValidationError, type Change, type Data, type Role, type Table } from '../shared/model';
import { SheetsStore } from './sheets';
import { syncSummaries } from './notion';

const env = process.env;
const necessary = ['SPREADSHEET_ID', 'LOCK_BUCKET', 'GOOGLE_CLIENT_ID', 'OWNER_EMAIL', 'APP_ORIGIN'] as const;
const absent = necessary.filter(key => !env[key]);
if (absent.length) throw new Error(`Missing server configuration: ${absent.join(', ')}`);
const store = new SheetsStore({ spreadsheetId: env.SPREADSHEET_ID!, lockBucket: env.LOCK_BUCKET! });
if (process.argv[2] === 'initialise') { await store.initialise(); console.log('Spreadsheet tabs are ready.'); process.exit(0); }
const auth = new OAuth2Client(env.GOOGLE_CLIENT_ID);
const primaryOwner = env.OWNER_EMAIL!.trim().toLowerCase();
const origin = env.APP_ORIGIN!;
const tokens = new Map<string, { email: string; expires: number }>();

class HttpError extends Error { constructor(readonly status: number, message: string) { super(message); } }
function reply(res: ServerResponse, status: number, payload: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(JSON.stringify(payload));
}
async function body(req: IncomingMessage) {
  if (!req.headers['content-type']?.startsWith('application/json')) throw new HttpError(415, 'Send JSON.');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const value of req) {
    const chunk = Buffer.from(value);
    size += chunk.length;
    if (size > 16_000_000) throw new HttpError(413, 'This import is too large for one save.');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new HttpError(400, 'Invalid JSON.'); }
}
function roleFor(data: Data, email: string): Role {
  if (email === primaryOwner) return 'Owner';
  const member = data.Members.find(row => !row.archived && row.title.toLowerCase() === email);
  const role = member?.fields.role;
  if (role !== 'Owner' && role !== 'Editor' && role !== 'Viewer') throw new HttpError(403, 'Ask the workspace owner to add your Google account.');
  return role;
}
async function emailFor(req: IncomingMessage) {
  const token = /^Bearer ([A-Za-z0-9._-]{16,8192})$/.exec(req.headers.authorization || '')?.[1];
  if (!token) throw new HttpError(401, 'Sign in with Google.');
  const now = Date.now();
  const cached = tokens.get(token);
  if (cached && cached.expires > now) return cached.email;
  const ticket = await auth.verifyIdToken({ idToken: token, audience: env.GOOGLE_CLIENT_ID }).catch(() => { throw new HttpError(401, 'Your Google session expired. Sign in again.'); });
  const identity = ticket.getPayload();
  if (!identity?.email || !identity.email_verified || (!identity.hd && !identity.email.toLowerCase().endsWith('@gmail.com'))) throw new HttpError(401, 'Use a verified Gmail or Google Workspace account.');
  if (tokens.size >= 250) tokens.delete(tokens.keys().next().value!);
  const email = identity.email.toLowerCase();
  tokens.set(token, { email, expires: identity.exp * 1000 });
  return email;
}
function offsetOf(url: URL) { return Math.min(100_000, Math.max(0, Math.trunc(Number(url.searchParams.get('offset')) || 0))); }
function sameSecret(value: string | undefined, secret: string | undefined) {
  if (!secret || !value) return false;
  const a = Buffer.from(value), b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

createServer(async (req, res) => {
  const method = req.method;
  const url = new URL(req.url || '/', 'http://localhost');
  const path = url.pathname;
  if (req.headers.origin && req.headers.origin !== origin) return reply(res, 403, { error: 'This website origin is not allowed.' });
  if (req.headers.origin === origin) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Vary', 'Origin');
  }
  if (method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  if (method === 'GET' && path === '/health') return reply(res, 200, { ok: true });
  try {
    if (path === '/jobs/notion' && method === 'POST') {
      if (!sameSecret(req.headers['x-scheduler-secret'] as string | undefined, env.SCHEDULER_SECRET)) throw new HttpError(403, 'Invalid scheduler credentials.');
      if (!env.NOTION_TOKEN || !env.NOTION_DATA_SOURCE_ID || !env.PLANNER_URL) throw new HttpError(503, 'Notion sync is not configured.');
      const { token, source, site } = { token: env.NOTION_TOKEN, source: env.NOTION_DATA_SOURCE_ID, site: env.PLANNER_URL };
      return reply(res, 200, await store.withLock('notion', async () => syncSummaries({ token, source, site }, await store.projectSummaries())));
    }
    const email = await emailFor(req);
    const snapshot = await store.snapshot();
    const role = roleFor(snapshot.data, email);
    if (path === '/workspace' && method === 'GET') return reply(res, 200, { role, projects: snapshot.data.Projects, summaries: await store.projectSummaries(), revision: snapshot.revision });
    if (path === '/schedule' && method === 'GET') {
      const param = (key: string) => (url.searchParams.get(key) || '').slice(0, 300);
      const filters = { project: param('project'), q: param('q'), start: param('start'), end: param('end'), status: param('status'), phase: param('phase') };
      if (!/^\d{4}-\d{2}-\d{2}$/.test(filters.start) || !/^\d{4}-\d{2}-\d{2}$/.test(filters.end) || !Number.isFinite(day(filters.start)) || !Number.isFinite(day(filters.end)) || filters.end < filters.start || filters.end >= addYears(filters.start, 10)) throw new HttpError(400, 'Choose a timeline window of up to 10 years.');
      const offset = offsetOf(url);
      const limit = Math.min(200, Math.max(1, Math.trunc(Number(param('limit')) || 100)));
      const rows = await store.schedule(filters);
      return reply(res, 200, { rows: rows.slice(offset, offset + limit), total: rows.length });
    }
    if (path === '/records' && method === 'GET') {
      const table = url.searchParams.get('table') as Table;
      if (!tables.includes(table)) throw new HttpError(400, 'Unknown table.');
      if (table === 'Members' && role !== 'Owner') throw new HttpError(403, 'Only owners can view team access.');
      const project = url.searchParams.get('project');
      const offset = offsetOf(url);
      const rows = snapshot.data[table].filter(record => !record.archived && (!project || record.projectId === project));
      return reply(res, 200, { rows: rows.slice(offset, offset + 100), total: rows.length });
    }
    if (path === '/backup' && method === 'GET') {
      if (role !== 'Owner') throw new HttpError(403, 'Only owners can download a workspace backup.');
      return reply(res, 200, snapshot.data);
    }
    if (path === '/save' && method === 'POST') {
      if (role === 'Viewer') throw new HttpError(403, 'Viewer accounts cannot edit the planner.');
      const { changes, operationId } = (await body(req)) ?? {} as { changes?: Change[]; operationId?: string };
      if (!Array.isArray(changes) || changes.length < 1 || changes.length > 60_000 || typeof operationId !== 'string' || !/^[0-9a-f-]{36}$/i.test(operationId)) throw new HttpError(400, 'Invalid changes or operation ID.');
      const revision = createHash('sha256').update(JSON.stringify(changes)).digest('hex');
      const outcome = await store.save(email, operationId, revision, changes, data => {
        const liveRole = roleFor(data, email);
        if (liveRole === 'Viewer' || (liveRole !== 'Owner' && (changes.length > 1 || changes.some(change => change?.table === 'Members')))) throw new HttpError(403, 'Only owners can import data or change team access.');
        for (const change of changes as Change[]) if (change?.table === 'Members' && typeof change.record?.title === 'string') {
          const address = change.record.title.trim().toLowerCase();
          const duplicate = data.Members.some(row => !row.archived && row.id !== change.record.id && row.title.toLowerCase() === address);
          if (duplicate || address === primaryOwner) throw new ValidationError('This Google account already has access.');
        }
      });
      return reply(res, 200, outcome);
    }
    return reply(res, 404, { error: 'Unknown endpoint.' });
  } catch (error) {
    if (error instanceof Conflict) return reply(res, 409, { error: error.message, current: error.current });
    if (error instanceof HttpError) return reply(res, error.status, { error: error.message });
    if (error instanceof ValidationError) return reply(res, 422, { error: error.message });
    console.error('Planner request failed', path, (error as Error).name, (error as { response?: { status: number } }).response?.status || '');
    return reply(res, 503, { error: 'The workspace service is unavailable. Retry the same save to check its status.' });
  }
}).listen(Number(env.PORT || 8080), '0.0.0.0', () => console.log('Planner API listening'));
