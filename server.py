#!/usr/bin/env python3
"""T06 planning and reflection app; Python standard library + SQLite only."""
from __future__ import annotations

import json
import os
import re
import sqlite3
import uuid
from contextlib import contextmanager
from datetime import date, datetime, timezone
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parent
DB_PATH = Path(os.environ.get("T06_DB_PATH", ROOT / "data" / "t06.sqlite3"))
DB_PATH.parent.mkdir(parents=True, exist_ok=True)
MAX_BODY = 1_000_000
SEOUL = ZoneInfo("Asia/Seoul")

SCHEMA = """
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS plans (
 id TEXT PRIMARY KEY, title TEXT NOT NULL, start_date TEXT NOT NULL, end_date TEXT NOT NULL,
 priority INTEGER NOT NULL CHECK(priority BETWEEN 1 AND 5), success_criteria TEXT NOT NULL,
 estimated_minutes INTEGER NOT NULL CHECK(estimated_minutes >= 0), created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS plan_revisions (
 id TEXT PRIMARY KEY, plan_id TEXT NOT NULL REFERENCES plans(id), revision_no INTEGER NOT NULL,
 snapshot_json TEXT NOT NULL, recorded_at TEXT NOT NULL, UNIQUE(plan_id, revision_no)
);
CREATE TABLE IF NOT EXISTS tasks (
 id TEXT PRIMARY KEY, plan_id TEXT NOT NULL REFERENCES plans(id), title TEXT NOT NULL,
 description TEXT NOT NULL DEFAULT '', due_date TEXT NOT NULL DEFAULT '', priority INTEGER NOT NULL CHECK(priority BETWEEN 1 AND 5),
 tags_json TEXT NOT NULL DEFAULT '[]', estimated_minutes INTEGER NOT NULL CHECK(estimated_minutes >= 0),
 status TEXT NOT NULL DEFAULT 'todo' CHECK(status IN ('todo','done')), created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 deleted_at TEXT
);
CREATE TABLE IF NOT EXISTS execution_records (
 id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), started_at TEXT NOT NULL, ended_at TEXT NOT NULL,
 actual_minutes INTEGER NOT NULL CHECK(actual_minutes >= 0), blocker_reason TEXT NOT NULL DEFAULT '',
 idempotency_key TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL,
 CHECK(ended_at >= started_at)
);
CREATE TABLE IF NOT EXISTS plan_handoffs (
 id TEXT PRIMARY KEY, source_plan_id TEXT NOT NULL REFERENCES plans(id), target_plan_id TEXT NOT NULL REFERENCES plans(id),
 insight_text TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tasks_plan_status ON tasks(plan_id, status, deleted_at);
CREATE INDEX IF NOT EXISTS idx_tasks_due_date ON tasks(due_date);
CREATE INDEX IF NOT EXISTS idx_exec_task ON execution_records(task_id);
"""

@contextmanager
def connect():
    c = sqlite3.connect(DB_PATH, timeout=10)
    c.row_factory = sqlite3.Row
    c.execute("PRAGMA foreign_keys = ON")
    try:
        yield c
        c.commit()
    except Exception:
        c.rollback()
        raise
    finally:
        c.close()

def now():
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")

def row_dict(row):
    return dict(row) if row is not None else None

def parse_tags(value):
    if isinstance(value, str):
        value = [x.strip() for x in value.split(",") if x.strip()]
    if not isinstance(value, list) or any(not isinstance(x, str) for x in value):
        raise ValueError("태그 형식이 올바르지 않습니다.")
    return list(dict.fromkeys(x.strip()[:40] for x in value if x.strip()))[:20]

def required_text(data, key, maxlen=500):
    value = data.get(key)
    if not isinstance(value, str) or not value.strip() or len(value.strip()) > maxlen:
        raise ValueError(f"{key} 항목을 확인해 주세요.")
    return value.strip()

def valid_date(value, key):
    if not isinstance(value, str):
        raise ValueError(f"{key} 날짜가 필요합니다.")
    try:
        date.fromisoformat(value)
    except ValueError as exc:
        raise ValueError(f"{key} 날짜 형식은 YYYY-MM-DD여야 합니다.") from exc
    return value

def nonnegative_int(data, key, maximum=100000):
    try:
        n = int(data.get(key))
    except (TypeError, ValueError) as exc:
        raise ValueError(f"{key}은(는) 0 이상의 정수여야 합니다.") from exc
    if n < 0 or n > maximum:
        raise ValueError(f"{key}은(는) 0에서 {maximum} 사이여야 합니다.")
    return n

def priority(data):
    try:
        p = int(data.get("priority"))
    except (TypeError, ValueError) as exc:
        raise ValueError("우선순위는 1에서 5 사이여야 합니다.") from exc
    if not 1 <= p <= 5:
        raise ValueError("우선순위는 1에서 5 사이여야 합니다.")
    return p

def plan_payload(data):
    start = valid_date(data.get("start_date"), "시작")
    end = valid_date(data.get("end_date"), "종료")
    if end < start:
        raise ValueError("종료일은 시작일보다 빠를 수 없습니다.")
    return (required_text(data, "title", 160), start, end, priority(data),
            required_text(data, "success_criteria", 2000), nonnegative_int(data, "estimated_minutes"))

def task_payload(data):
    title = required_text(data, "title", 240)
    description = data.get("description", "")
    if not isinstance(description, str) or len(description) > 4000:
        raise ValueError("할 일 설명은 4,000자 이내여야 합니다.")
    due = data.get("due_date", "")
    if due:
        valid_date(due, "마감")
    return (title, description, due, priority(data), json.dumps(parse_tags(data.get("tags", [])), ensure_ascii=False), nonnegative_int(data, "estimated_minutes"))

class APIError(Exception):
    def __init__(self, status, message):
        self.status, self.message = status, message

class Handler(BaseHTTPRequestHandler):
    server_version = "T06/1.0"

    def log_message(self, fmt, *args):
        # Avoid logging request bodies or user-entered text.
        super().log_message(fmt, *args)

    def send_json(self, status, obj, filename=None):
        raw = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(raw)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'")
        if filename:
            self.send_header("Content-Disposition", f'attachment; filename="{filename}"')
        self.end_headers()
        self.wfile.write(raw)

    def body(self):
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            raise ValueError("요청 크기를 읽을 수 없습니다.")
        if length > MAX_BODY:
            raise APIError(HTTPStatus.REQUEST_ENTITY_TOO_LARGE, "요청이 너무 큽니다.")
        raw = self.rfile.read(length)
        try:
            value = json.loads(raw or b"{}")
        except json.JSONDecodeError as exc:
            raise ValueError("JSON 요청 형식이 올바르지 않습니다.") from exc
        if not isinstance(value, dict):
            raise ValueError("요청 본문은 객체여야 합니다.")
        return value

    def do_GET(self):
        try:
            parsed = urlparse(self.path)
            if parsed.path.startswith("/api/"):
                self.api_get(parsed.path, parse_qs(parsed.query))
            elif parsed.path == "/" or parsed.path in ("/index.html", "/app.js", "/styles.css"):
                self.serve_static(parsed.path)
            else:
                raise APIError(HTTPStatus.NOT_FOUND, "요청한 경로를 찾을 수 없습니다.")
        except Exception as exc:
            self.handle_error(exc)

    def do_POST(self): self.dispatch_write("POST")
    def do_PATCH(self): self.dispatch_write("PATCH")
    def do_DELETE(self): self.dispatch_write("DELETE")

    def dispatch_write(self, method):
        try:
            data = self.body() if method != "DELETE" else {}
            self.api_write(method, urlparse(self.path).path, data)
        except Exception as exc:
            self.handle_error(exc)

    def serve_static(self, path):
        name = "index.html" if path == "/" else path.lstrip("/")
        target = (ROOT / "static" / name).resolve()
        if ROOT / "static" not in target.parents:
            raise APIError(HTTPStatus.NOT_FOUND, "파일을 찾을 수 없습니다.")
        if not target.is_file():
            raise APIError(HTTPStatus.NOT_FOUND, "파일을 찾을 수 없습니다.")
        content = target.read_bytes()
        mime = {".html":"text/html; charset=utf-8", ".js":"text/javascript; charset=utf-8", ".css":"text/css; charset=utf-8"}.get(target.suffix, "application/octet-stream")
        self.send_response(200)
        self.send_header("Content-Type", mime)
        self.send_header("Content-Length", str(len(content)))
        self.send_header("Cache-Control", "no-cache")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'")
        self.end_headers(); self.wfile.write(content)

    def api_get(self, path, query):
        with connect() as db:
            if path == "/api/health":
                self.send_json(200, {"ok": True, "database": "sqlite", "timezone": "Asia/Seoul"}); return
            if path == "/api/bootstrap":
                plans = [dict(r) for r in db.execute("SELECT * FROM plans ORDER BY start_date DESC, id")]
                tasks = []
                for r in db.execute("SELECT * FROM tasks WHERE deleted_at IS NULL ORDER BY created_at, id"):
                    d = dict(r); d["tags"] = json.loads(d.pop("tags_json")); tasks.append(d)
                revisions = [dict(r) for r in db.execute("SELECT * FROM plan_revisions ORDER BY recorded_at DESC")]
                for r in revisions: r["snapshot"] = json.loads(r.pop("snapshot_json"))
                executions = [dict(r) for r in db.execute("SELECT * FROM execution_records ORDER BY started_at DESC, id")]
                handoffs = [dict(r) for r in db.execute("SELECT * FROM plan_handoffs ORDER BY created_at DESC")]
                self.send_json(200, {"plans":plans,"tasks":tasks,"revisions":revisions,"executions":executions,"handoffs":handoffs,"today":datetime.now(SEOUL).date().isoformat()}); return
            if path == "/api/review":
                start = query.get("from", [""])[0]; end = query.get("to", [""])[0]
                if not start or not end: raise ValueError("회고 기간의 시작일과 종료일이 필요합니다.")
                valid_date(start,"시작"); valid_date(end,"종료")
                if end < start: raise ValueError("회고 종료일은 시작일보다 빠를 수 없습니다.")
                tasks = [dict(r) for r in db.execute("""SELECT t.*, p.title AS plan_title, p.start_date AS plan_start, p.end_date AS plan_end
                    FROM tasks t JOIN plans p ON p.id=t.plan_id WHERE t.deleted_at IS NULL
                    AND p.start_date<=? AND p.end_date>=? ORDER BY t.due_date, t.created_at, t.id""", (end,start))]
                task_ids = [t["id"] for t in tasks]
                execs = []
                if task_ids:
                    marks = ",".join("?" for _ in task_ids)
                    execs = [dict(r) for r in db.execute(f"SELECT * FROM execution_records WHERE task_id IN ({marks}) ORDER BY started_at, id", task_ids)]
                executions_by_task = {}
                for e in execs: executions_by_task.setdefault(e["task_id"], []).append(e)
                for t in tasks: t["executions"] = executions_by_task.get(t["id"], [])
                today_seoul = datetime.now(SEOUL).date().isoformat()
                done = sum(t["status"] == "done" for t in tasks)
                overdue = sum(t["status"] != "done" and bool(t["due_date"]) and t["due_date"] < today_seoul for t in tasks)
                blocked = sum(any(e["blocker_reason"].strip() for e in t["executions"]) for t in tasks)
                estimated = sum(t["estimated_minutes"] for t in tasks)
                actual = sum(e["actual_minutes"] for e in execs)
                summary = {"task_count":len(tasks),"completed_count":done,"overdue_count":overdue,"blocked_count":blocked,"estimated_minutes":estimated,"actual_minutes":actual,"difference_minutes":actual-estimated}
                self.send_json(200,{"summary":summary,"tasks":tasks,"executions":execs,"period":{"from":start,"to":end},"today_seoul":today_seoul}); return
            raise APIError(HTTPStatus.NOT_FOUND, "API 경로를 찾을 수 없습니다.")

    def api_write(self, method, path, data):
        now_value = now()
        with connect() as db:
            if path == "/api/plans" and method == "POST":
                title,start,end,prio,success,estimate = plan_payload(data)
                pid = str(uuid.uuid4())
                db.execute("INSERT INTO plans VALUES(?,?,?,?,?,?,?,?,?)", (pid,title,start,end,prio,success,estimate,now_value,now_value))
                self.send_json(201,{"id":pid}); return
            m = re.fullmatch(r"/api/plans/([0-9a-fA-F-]{36})", path)
            if m and method == "PATCH":
                pid=m.group(1); old=db.execute("SELECT * FROM plans WHERE id=?",(pid,)).fetchone()
                if not old: raise APIError(404,"계획을 찾을 수 없습니다.")
                title,start,end,prio,success,estimate=plan_payload(data)
                rev=db.execute("SELECT COALESCE(MAX(revision_no),0)+1 FROM plan_revisions WHERE plan_id=?",(pid,)).fetchone()[0]
                snapshot={k:old[k] for k in ("id","title","start_date","end_date","priority","success_criteria","estimated_minutes","created_at","updated_at")}
                db.execute("INSERT INTO plan_revisions VALUES(?,?,?,?,?)",(str(uuid.uuid4()),pid,rev,json.dumps(snapshot,ensure_ascii=False),now_value))
                db.execute("UPDATE plans SET title=?,start_date=?,end_date=?,priority=?,success_criteria=?,estimated_minutes=?,updated_at=? WHERE id=?",(title,start,end,prio,success,estimate,now_value,pid))
                self.send_json(200,{"ok":True,"revision_no":rev}); return
            if path == "/api/tasks" and method == "POST":
                plan_id=required_text(data,"plan_id",36)
                if not db.execute("SELECT 1 FROM plans WHERE id=?",(plan_id,)).fetchone(): raise APIError(404,"연결할 계획을 찾을 수 없습니다.")
                vals=task_payload(data); tid=str(uuid.uuid4())
                db.execute("INSERT INTO tasks(id,plan_id,title,description,due_date,priority,tags_json,estimated_minutes,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)",(tid,plan_id,*vals,"todo",now_value,now_value))
                self.send_json(201,{"id":tid}); return
            m=re.fullmatch(r"/api/tasks/([0-9a-fA-F-]{36})",path)
            if m and method=="PATCH":
                tid=m.group(1); old=db.execute("SELECT * FROM tasks WHERE id=? AND deleted_at IS NULL",(tid,)).fetchone()
                if not old: raise APIError(404,"할 일을 찾을 수 없습니다.")
                vals=task_payload(data); db.execute("UPDATE tasks SET title=?,description=?,due_date=?,priority=?,tags_json=?,estimated_minutes=?,updated_at=? WHERE id=?",(*vals,now_value,tid))
                self.send_json(200,{"ok":True}); return
            if m and method=="DELETE":
                tid=m.group(1); cur=db.execute("UPDATE tasks SET deleted_at=?,updated_at=? WHERE id=? AND deleted_at IS NULL",(now_value,now_value,tid))
                if not cur.rowcount: raise APIError(404,"할 일을 찾을 수 없습니다.")
                self.send_json(200,{"ok":True}); return
            m=re.fullmatch(r"/api/tasks/([0-9a-fA-F-]{36})/status",path)
            if m and method=="PATCH":
                status=data.get("status")
                if status != "todo": raise ValueError("완료 처리는 실행 기록과 함께 저장해야 합니다.")
                cur=db.execute("UPDATE tasks SET status=?,updated_at=? WHERE id=? AND deleted_at IS NULL",(status,now_value,m.group(1)))
                if not cur.rowcount: raise APIError(404,"할 일을 찾을 수 없습니다.")
                self.send_json(200,{"ok":True,"status":status}); return
            completion_match=re.fullmatch(r"/api/tasks/([0-9a-fA-F-]{36})/complete",path)
            if completion_match and method=="POST":
                tid=completion_match.group(1)
                try:
                    db.execute("BEGIN IMMEDIATE")
                    task=db.execute("SELECT status FROM tasks WHERE id=? AND deleted_at IS NULL",(tid,)).fetchone()
                    if not task: raise APIError(404,"할 일을 찾을 수 없습니다.")
                    request_key=data.get("idempotency_key")
                    if not isinstance(request_key,str) or not re.fullmatch(r"[0-9a-fA-F-]{36}",request_key):
                        raise ValueError("요청 키를 확인해 주세요.")
                    repeated=db.execute("SELECT id FROM execution_records WHERE idempotency_key=?",(request_key,)).fetchone()
                    if repeated:
                        db.commit(); self.send_json(200,{"ok":True,"duplicate":True,"execution_id":repeated["id"]}); return
                    if task["status"]=="done":
                        existing=db.execute("SELECT id FROM execution_records WHERE task_id=? ORDER BY created_at DESC LIMIT 1",(tid,)).fetchone()
                        db.commit(); self.send_json(200,{"ok":True,"duplicate":True,"execution_id":existing["id"] if existing else None}); return
                    started=data.get("started_at"); ended=data.get("ended_at")
                    try:
                        sd=datetime.fromisoformat(started.replace("Z","+00:00")); ed=datetime.fromisoformat(ended.replace("Z","+00:00"))
                        if ed < sd: raise ValueError()
                    except Exception as exc: raise ValueError("시작·종료 시각을 확인해 주세요.") from exc
                    actual=nonnegative_int(data,"actual_minutes")
                    blocker=data.get("blocker_reason","")
                    if not isinstance(blocker,str) or len(blocker)>2000: raise ValueError("막힘 이유는 2,000자 이내여야 합니다.")
                    eid=str(uuid.uuid4())
                    db.execute("INSERT INTO execution_records VALUES(?,?,?,?,?,?,?,?)",(eid,tid,sd.astimezone(timezone.utc).isoformat().replace("+00:00","Z"),ed.astimezone(timezone.utc).isoformat().replace("+00:00","Z"),actual,blocker.strip(),request_key,now_value))
                    db.execute("UPDATE tasks SET status='done',updated_at=? WHERE id=?",(now_value,tid))
                    db.commit(); self.send_json(201,{"ok":True,"execution_id":eid}); return
                except Exception:
                    db.rollback(); raise
            m=re.fullmatch(r"/api/tasks/([0-9a-fA-F-]{36})/executions",path)
            if m and method=="POST":
                tid=m.group(1)
                if not db.execute("SELECT 1 FROM tasks WHERE id=? AND deleted_at IS NULL",(tid,)).fetchone(): raise APIError(404,"할 일을 찾을 수 없습니다.")
                started=data.get("started_at"); ended=data.get("ended_at")
                try:
                    sd=datetime.fromisoformat(started.replace("Z","+00:00")); ed=datetime.fromisoformat(ended.replace("Z","+00:00"))
                    if ed < sd: raise ValueError()
                except Exception as exc: raise ValueError("시작·종료 시각을 확인해 주세요.") from exc
                actual=nonnegative_int(data,"actual_minutes"); blocker=data.get("blocker_reason","")
                if not isinstance(blocker,str) or len(blocker)>2000: raise ValueError("막힘 이유는 2,000자 이내여야 합니다.")
                eid=str(uuid.uuid4()); key=data.get("idempotency_key") or str(uuid.uuid4())
                if not isinstance(key,str) or not re.fullmatch(r"[0-9a-fA-F-]{36}",key): raise ValueError("요청 키를 확인해 주세요.")
                repeated=db.execute("SELECT id FROM execution_records WHERE idempotency_key=?",(key,)).fetchone()
                if repeated: self.send_json(200,{"id":repeated["id"],"duplicate":True}); return
                try:
                    db.execute("INSERT INTO execution_records VALUES(?,?,?,?,?,?,?,?)",(eid,tid,sd.astimezone(timezone.utc).isoformat().replace("+00:00","Z"),ed.astimezone(timezone.utc).isoformat().replace("+00:00","Z"),actual,blocker.strip(),key,now_value))
                except sqlite3.IntegrityError as exc: raise APIError(409,"이미 처리된 요청입니다.") from exc
                self.send_json(201,{"id":eid}); return
            m=re.fullmatch(r"/api/plans/([0-9a-fA-F-]{36})/handoffs",path)
            if m and method=="POST":
                source=m.group(1); target=required_text(data,"target_plan_id",36); note=required_text(data,"insight_text",1000)
                if source==target: raise ValueError("다음 계획은 이전 계획과 달라야 합니다.")
                if not db.execute("SELECT 1 FROM plans WHERE id=?",(source,)).fetchone() or not db.execute("SELECT 1 FROM plans WHERE id=?",(target,)).fetchone(): raise APIError(404,"연결할 계획을 찾을 수 없습니다.")
                hid=str(uuid.uuid4()); db.execute("INSERT INTO plan_handoffs VALUES(?,?,?,?,?)",(hid,source,target,note,now_value))
                self.send_json(201,{"id":hid}); return
            if path=="/api/export" and method=="POST":
                payload={"schema_version":"2","exported_at":now_value,"timezone":"Asia/Seoul"}
                for table_name in ("plans","plan_revisions","tasks","execution_records","plan_handoffs"):
                    payload[table_name]=[dict(r) for r in db.execute(f"SELECT * FROM {table_name} ORDER BY rowid")]
                self.send_json(200,payload,"t06-export.json"); return
            raise APIError(HTTPStatus.NOT_FOUND,"API 경로를 찾을 수 없습니다.")

    def handle_error(self, exc):
        if isinstance(exc, APIError):
            self.send_json(exc.status,{"error":exc.message}); return
        if isinstance(exc, ValueError):
            self.send_json(HTTPStatus.BAD_REQUEST,{"error":str(exc)}); return
        if isinstance(exc, sqlite3.IntegrityError):
            self.send_json(HTTPStatus.CONFLICT,{"error":"데이터 관계 또는 중복 요청을 확인해 주세요."}); return
        self.log_error("request failed: %s", type(exc).__name__)
        try: self.send_json(HTTPStatus.INTERNAL_SERVER_ERROR,{"error":"처리 중 문제가 생겼습니다. 잠시 후 다시 시도해 주세요."})
        except BrokenPipeError: pass

def main():
    with connect() as db:
        db.execute("PRAGMA journal_mode = WAL")
        db.executescript(SCHEMA)
    host=os.environ.get("T06_HOST","127.0.0.1")
    port=int(os.environ.get("PORT",os.environ.get("T06_PORT","8000")))
    server=ThreadingHTTPServer((host,port),Handler)
    print(f"T06 server listening on http://{host}:{port}")
    print(f"SQLite database: {DB_PATH}")
    try: server.serve_forever()
    except KeyboardInterrupt: print("\nStopping T06 server")
    finally: server.server_close()

if __name__=="__main__": main()

