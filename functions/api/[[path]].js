const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_BODY = 1_000_000;
const SEOUL_TODAY = () => new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit'
}).format(new Date());

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const json = (obj, status = 200, headers = {}) => new Response(JSON.stringify(obj), {
  status,
  headers: {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
    ...headers
  }
});
const fail = (status, message) => { throw new HttpError(status, message); };
const id = () => crypto.randomUUID();
const timestamp = () => new Date().toISOString();
const db = env => {
  if (!env.DB) fail(500, 'D1 데이터베이스 바인딩 DB가 설정되지 않았습니다.');
  return env.DB;
};
const all = async (database, sql, ...params) => (await database.prepare(sql).bind(...params).all()).results || [];
const first = (database, sql, ...params) => database.prepare(sql).bind(...params).first();
const run = (database, sql, ...params) => database.prepare(sql).bind(...params).run();

async function requestData(request) {
  let raw, value;
  try { raw = await request.text(); }
  catch { fail(400, '요청 본문을 읽지 못했습니다.'); }
  if (new TextEncoder().encode(raw).byteLength > MAX_BODY) fail(413, '요청이 너무 큽니다.');
  try { value = JSON.parse(raw || '{}'); }
  catch { fail(400, 'JSON 요청 형식이 올바르지 않습니다.'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(400, '요청 본문은 객체여야 합니다.');
  return value;
}
function text(data, key, limit = 500) {
  const v = data[key];
  if (typeof v !== 'string' || !v.trim() || v.trim().length > limit) fail(400, `${key} 항목을 확인해 주세요.`);
  return v.trim();
}
function optionalText(data, key, limit = 2000) {
  const v = data[key] ?? '';
  if (typeof v !== 'string' || v.length > limit) fail(400, `${key} 항목을 확인해 주세요.`);
  return v.trim();
}
function dateValue(v, label) {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) fail(400, `${label} 날짜는 YYYY-MM-DD 형식이어야 합니다.`);
  const d = new Date(`${v}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== v) fail(400, `${label} 날짜를 확인해 주세요.`);
  return v;
}
function integer(data, key, max = 100000) {
  if ((typeof data[key] !== 'number' && typeof data[key] !== 'string') || data[key] === '') fail(400, `${key}은(는) 0에서 ${max} 사이의 정수여야 합니다.`);
  const n = Number(data[key]);
  if (!Number.isInteger(n) || n < 0 || n > max) fail(400, `${key}은(는) 0에서 ${max} 사이의 정수여야 합니다.`);
  return n;
}
function priority(data) {
  const n = Number(data.priority);
  if (!Number.isInteger(n) || n < 1 || n > 5) fail(400, '우선순위는 1에서 5 사이여야 합니다.');
  return n;
}
function planFields(data) {
  const start = dateValue(data.start_date, '시작');
  const end = dateValue(data.end_date, '종료');
  if (end < start) fail(400, '종료일은 시작일보다 빠를 수 없습니다.');
  return [text(data, 'title', 160), start, end, priority(data), text(data, 'success_criteria', 2000), integer(data, 'estimated_minutes')];
}
function taskFields(data) {
  const title = text(data, 'title', 240);
  const description = optionalText(data, 'description', 4000);
  const due = data.due_date || '';
  if (due) dateValue(due, '마감');
  const rawTags = Array.isArray(data.tags) ? data.tags : typeof data.tags === 'string' ? data.tags.split(',') : [];
  if (rawTags.some(t => typeof t !== 'string')) fail(400, '태그 형식이 올바르지 않습니다.');
  const tags = [...new Set(rawTags.map(t => t.trim()).filter(Boolean))].slice(0, 20).map(t => t.slice(0, 40));
  return [title, description, due, priority(data), JSON.stringify(tags), integer(data, 'estimated_minutes')];
}
function validUuid(value, label = 'ID') {
  if (typeof value !== 'string' || !UUID.test(value)) fail(400, `${label} 형식이 올바르지 않습니다.`);
  return value;
}
function timestampValue(value, label) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) fail(400, `${label} 시각을 확인해 주세요.`);
  return new Date(value).toISOString();
}
function taskWithTags(row) {
  return { ...row, tags: JSON.parse(row.tags_json || '[]') };
}

async function bootstrap(database) {
  const [plans, taskRows, revisionRows, executions, handoffs] = await Promise.all([
    all(database, 'SELECT * FROM plans ORDER BY start_date DESC, id'),
    all(database, 'SELECT * FROM tasks WHERE deleted_at IS NULL ORDER BY created_at, id'),
    all(database, 'SELECT * FROM plan_revisions ORDER BY recorded_at DESC'),
    all(database, 'SELECT * FROM execution_records ORDER BY started_at DESC, id'),
    all(database, 'SELECT * FROM plan_handoffs ORDER BY created_at DESC')
  ]);
  const tasks = taskRows.map(taskWithTags);
  const revisions = revisionRows.map(r => ({ ...r, snapshot: JSON.parse(r.snapshot_json) }));
  return { plans, tasks, revisions, executions, handoffs, today: SEOUL_TODAY() };
}

async function review(database, url) {
  const from = dateValue(url.searchParams.get('from'), '시작');
  const to = dateValue(url.searchParams.get('to'), '종료');
  if (to < from) fail(400, '회고 종료일은 시작일보다 빠를 수 없습니다.');
  const tasks = await all(database, `SELECT t.*, p.title AS plan_title, p.start_date AS plan_start, p.end_date AS plan_end
    FROM tasks t JOIN plans p ON p.id=t.plan_id WHERE t.deleted_at IS NULL
    AND p.start_date<=? AND p.end_date>=? ORDER BY t.due_date, t.created_at, t.id`, to, from);
  let executions = [];
  if (tasks.length) {
    const marks = tasks.map(() => '?').join(',');
    executions = await all(database, `SELECT * FROM execution_records WHERE task_id IN (${marks}) ORDER BY started_at, id`, ...tasks.map(t => t.id));
  }
  const byTask = new Map();
  for (const e of executions) {
    if (!byTask.has(e.task_id)) byTask.set(e.task_id, []);
    byTask.get(e.task_id).push(e);
  }
  for (const t of tasks) t.executions = byTask.get(t.id) || [];
  const today = SEOUL_TODAY();
  const summary = {
    task_count: tasks.length,
    completed_count: tasks.filter(t => t.status === 'done').length,
    overdue_count: tasks.filter(t => t.status === 'todo' && t.due_date && t.due_date < today).length,
    blocked_count: tasks.filter(t => (t.executions || []).some(e => e.blocker_reason.trim())).length,
    estimated_minutes: tasks.reduce((n, t) => n + Number(t.estimated_minutes), 0),
    actual_minutes: executions.reduce((n, e) => n + Number(e.actual_minutes), 0)
  };
  summary.difference_minutes = summary.actual_minutes - summary.estimated_minutes;
  return { summary, tasks, executions, period: { from, to }, today_seoul: today };
}

async function createPlan(database, data) {
  const fields = planFields(data), pid = id(), now = timestamp();
  await run(database, 'INSERT INTO plans(id,title,start_date,end_date,priority,success_criteria,estimated_minutes,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)', pid, ...fields, now, now);
  return json({ id: pid }, 201);
}
async function editPlan(database, pid, data) {
  const current = await first(database, 'SELECT * FROM plans WHERE id=?', pid);
  if (!current) fail(404, '계획을 찾을 수 없습니다.');
  const fields = planFields(data), rev = (await first(database, 'SELECT COALESCE(MAX(revision_no),0)+1 AS n FROM plan_revisions WHERE plan_id=?', pid)).n;
  const snapshot = JSON.stringify({ id: current.id, title: current.title, start_date: current.start_date, end_date: current.end_date, priority: current.priority, success_criteria: current.success_criteria, estimated_minutes: current.estimated_minutes, created_at: current.created_at, updated_at: current.updated_at });
  await database.batch([
    database.prepare('INSERT INTO plan_revisions(id,plan_id,revision_no,snapshot_json,recorded_at) VALUES(?,?,?,?,?)').bind(id(), pid, rev, snapshot, timestamp()),
    database.prepare('UPDATE plans SET title=?,start_date=?,end_date=?,priority=?,success_criteria=?,estimated_minutes=?,updated_at=? WHERE id=?').bind(...fields, timestamp(), pid)
  ]);
  return json({ ok: true, revision_no: rev });
}
async function createTask(database, data) {
  const pid = validUuid(data.plan_id, '계획 ID');
  if (!(await first(database, 'SELECT id FROM plans WHERE id=?', pid))) fail(404, '연결할 계획을 찾을 수 없습니다.');
  const fields = taskFields(data), tid = id(), now = timestamp();
  await run(database, `INSERT INTO tasks(id,plan_id,title,description,due_date,priority,tags_json,estimated_minutes,status,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?)`, tid, pid, ...fields, 'todo', now, now);
  return json({ id: tid }, 201);
}
async function editTask(database, tid, data) {
  const fields = taskFields(data);
  const result = await run(database, 'UPDATE tasks SET title=?,description=?,due_date=?,priority=?,tags_json=?,estimated_minutes=?,updated_at=? WHERE id=? AND deleted_at IS NULL', ...fields, timestamp(), tid);
  if (!result.meta.changes) fail(404, '할 일을 찾을 수 없습니다.');
  return json({ ok: true });
}
async function completeTask(database, tid, data) {
  const task = await first(database, 'SELECT status FROM tasks WHERE id=? AND deleted_at IS NULL', tid);
  if (!task) fail(404, '할 일을 찾을 수 없습니다.');
  const key = validUuid(data.idempotency_key, '요청 키');
  const prior = await first(database, 'SELECT id FROM execution_records WHERE idempotency_key=?', key);
  if (prior) return json({ ok: true, duplicate: true, execution_id: prior.id });
  if (task.status === 'done') {
    const priorTaskRecord = await first(database, 'SELECT id FROM execution_records WHERE task_id=? ORDER BY created_at DESC LIMIT 1', tid);
    return json({ ok: true, duplicate: true, execution_id: priorTaskRecord?.id || null });
  }
  const started = timestampValue(data.started_at, '시작'), ended = timestampValue(data.ended_at, '종료');
  if (ended < started) fail(400, '종료 시각은 시작 시각보다 빠를 수 없습니다.');
  const actual = integer(data, 'actual_minutes'), blocker = optionalText(data, 'blocker_reason', 2000), eid = id(), now = timestamp();
  await database.batch([
    database.prepare(`INSERT INTO execution_records(id,task_id,started_at,ended_at,actual_minutes,blocker_reason,idempotency_key,created_at)
      SELECT ?,?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM tasks WHERE id=? AND status='todo' AND deleted_at IS NULL)
      ON CONFLICT(idempotency_key) DO NOTHING`).bind(eid, tid, started, ended, actual, blocker, key, now, tid),
    database.prepare("UPDATE tasks SET status='done',updated_at=? WHERE id=? AND status='todo' AND deleted_at IS NULL").bind(now, tid)
  ]);
  const record = await first(database, 'SELECT id FROM execution_records WHERE idempotency_key=?', key);
  if (record) return json({ ok: true, execution_id: record.id }, record.id === eid ? 201 : 200);
  const existing = await first(database, 'SELECT id FROM execution_records WHERE task_id=? ORDER BY created_at DESC LIMIT 1', tid);
  return json({ ok: true, duplicate: true, execution_id: existing?.id || null });
}

async function handle(context) {
  const request = context.request, url = new URL(request.url), path = url.pathname;
  const method = request.method.toUpperCase(), database = db(context.env);
  try {
    if (path === '/api/health' && method === 'GET') return json({ ok: true, database: 'D1', timezone: 'Asia/Seoul' });
    if (path === '/api/bootstrap' && method === 'GET') return json(await bootstrap(database));
    if (path === '/api/review' && method === 'GET') return json(await review(database, url));
    if (path === '/api/plans' && method === 'POST') return await createPlan(database, await requestData(request));
    let m = path.match(/^\/api\/plans\/([0-9a-f-]{36})$/i);
    if (m && method === 'PATCH') return await editPlan(database, m[1], await requestData(request));
    if (path === '/api/tasks' && method === 'POST') return await createTask(database, await requestData(request));
    m = path.match(/^\/api\/tasks\/([0-9a-f-]{36})$/i);
    if (m && method === 'PATCH') return await editTask(database, m[1], await requestData(request));
    if (m && method === 'DELETE') {
      const result = await run(database, 'UPDATE tasks SET deleted_at=?,updated_at=? WHERE id=? AND deleted_at IS NULL', timestamp(), timestamp(), m[1]);
      if (!result.meta.changes) fail(404, '할 일을 찾을 수 없습니다.');
      return json({ ok: true });
    }
    m = path.match(/^\/api\/tasks\/([0-9a-f-]{36})\/status$/i);
    if (m && method === 'PATCH') {
      const data = await requestData(request);
      if (data.status !== 'todo') fail(400, '완료 처리는 실행 기록과 함께 저장해야 합니다.');
      const result = await run(database, "UPDATE tasks SET status='todo',updated_at=? WHERE id=? AND deleted_at IS NULL", timestamp(), m[1]);
      if (!result.meta.changes) fail(404, '할 일을 찾을 수 없습니다.');
      return json({ ok: true, status: 'todo' });
    }
    m = path.match(/^\/api\/tasks\/([0-9a-f-]{36})\/complete$/i);
    if (m && method === 'POST') return await completeTask(database, m[1], await requestData(request));
    m = path.match(/^\/api\/tasks\/([0-9a-f-]{36})\/executions$/i);
    if (m && method === 'POST') {
      const data = await requestData(request), tid = m[1];
      if (!(await first(database, 'SELECT id FROM tasks WHERE id=? AND deleted_at IS NULL', tid))) fail(404, '할 일을 찾을 수 없습니다.');
      const started = timestampValue(data.started_at, '시작'), ended = timestampValue(data.ended_at, '종료');
      if (ended < started) fail(400, '종료 시각은 시작 시각보다 빠를 수 없습니다.');
      const actual = integer(data, 'actual_minutes'), blocker = optionalText(data, 'blocker_reason', 2000);
      const key = data.idempotency_key ? validUuid(data.idempotency_key, '요청 키') : id();
      const prior = await first(database, 'SELECT id FROM execution_records WHERE idempotency_key=?', key);
      if (prior) return json({ id: prior.id, duplicate: true });
      const eid = id();
      await run(database, 'INSERT INTO execution_records(id,task_id,started_at,ended_at,actual_minutes,blocker_reason,idempotency_key,created_at) VALUES(?,?,?,?,?,?,?,?)', eid, tid, started, ended, actual, blocker, key, timestamp());
      return json({ id: eid }, 201);
    }
    m = path.match(/^\/api\/plans\/([0-9a-f-]{36})\/handoffs$/i);
    if (m && method === 'POST') {
      const data = await requestData(request), source = m[1], target = validUuid(data.target_plan_id, '다음 계획 ID'), note = text(data, 'insight_text', 1000);
      if (source === target) fail(400, '다음 계획은 이전 계획과 달라야 합니다.');
      const plans = await all(database, 'SELECT id FROM plans WHERE id IN (?,?)', source, target);
      if (plans.length !== 2) fail(404, '연결할 계획을 찾을 수 없습니다.');
      const hid = id();
      await run(database, 'INSERT INTO plan_handoffs(id,source_plan_id,target_plan_id,insight_text,created_at) VALUES(?,?,?,?,?)', hid, source, target, note, timestamp());
      return json({ id: hid }, 201);
    }
    if (path === '/api/export' && method === 'POST') {
      const payload = { schema_version: '2', exported_at: timestamp(), timezone: 'Asia/Seoul' };
      for (const table of ['plans','plan_revisions','tasks','execution_records','plan_handoffs']) payload[table] = await all(database, `SELECT * FROM ${table} ORDER BY rowid`);
      return json(payload, 200, { 'Content-Disposition': 'attachment; filename="t06-export.json"' });
    }
    fail(404, 'API 경로를 찾을 수 없습니다.');
  } catch (error) {
    if (error instanceof HttpError) return json({ error: error.message }, error.status);
    if (error?.message?.includes('UNIQUE constraint failed')) return json({ error: '이미 처리된 요청입니다.' }, 409);
    console.error('T06 API error', error?.name || 'Error');
    return json({ error: '처리 중 문제가 생겼습니다. 잠시 후 다시 시도해 주세요.' }, 500);
  }
}

export async function onRequest(context) { return handle(context); }
