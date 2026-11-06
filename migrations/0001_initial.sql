CREATE TABLE IF NOT EXISTS plans (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  priority INTEGER NOT NULL CHECK(priority BETWEEN 1 AND 5),
  success_criteria TEXT NOT NULL,
  estimated_minutes INTEGER NOT NULL CHECK(estimated_minutes >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK(end_date >= start_date)
);

CREATE TABLE IF NOT EXISTS plan_revisions (
  id TEXT PRIMARY KEY,
  plan_id TEXT NOT NULL REFERENCES plans(id),
  revision_no INTEGER NOT NULL,
  snapshot_json TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  UNIQUE(plan_id, revision_no)
);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  plan_id TEXT NOT NULL REFERENCES plans(id),
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  due_date TEXT NOT NULL DEFAULT '',
  priority INTEGER NOT NULL CHECK(priority BETWEEN 1 AND 5),
  tags_json TEXT NOT NULL DEFAULT '[]',
  estimated_minutes INTEGER NOT NULL CHECK(estimated_minutes >= 0),
  status TEXT NOT NULL DEFAULT 'todo' CHECK(status IN ('todo','done')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);

CREATE TABLE IF NOT EXISTS execution_records (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  started_at TEXT NOT NULL,
  ended_at TEXT NOT NULL,
  actual_minutes INTEGER NOT NULL CHECK(actual_minutes >= 0),
  blocker_reason TEXT NOT NULL DEFAULT '',
  idempotency_key TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  CHECK(ended_at >= started_at)
);

CREATE TABLE IF NOT EXISTS plan_handoffs (
  id TEXT PRIMARY KEY,
  source_plan_id TEXT NOT NULL REFERENCES plans(id),
  target_plan_id TEXT NOT NULL REFERENCES plans(id),
  insight_text TEXT NOT NULL,
  created_at TEXT NOT NULL,
  CHECK(source_plan_id <> target_plan_id)
);

CREATE INDEX IF NOT EXISTS idx_tasks_plan_status ON tasks(plan_id, status, deleted_at);
CREATE INDEX IF NOT EXISTS idx_tasks_due_date ON tasks(due_date);
CREATE INDEX IF NOT EXISTS idx_exec_task ON execution_records(task_id);
