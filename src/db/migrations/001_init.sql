-- PRD-01: all tables used by PRD-01..03. Timestamps are UTC ISO strings.

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  appName TEXT,
  createdAt TEXT NOT NULL,
  lastActiveAt TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sessionId TEXT NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  createdAt TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_session ON messages (sessionId, id);

CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  sessionId TEXT NOT NULL,
  type TEXT NOT NULL,
  payload TEXT NOT NULL,
  ts TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_session ON events (sessionId, ts);

CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY,
  sessionId TEXT,
  tool TEXT NOT NULL,
  args TEXT NOT NULL,
  risk INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected', 'expired')),
  createdAt TEXT NOT NULL,
  resolvedAt TEXT,
  resolvedBy TEXT
);

CREATE TABLE IF NOT EXISTS audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sessionId TEXT,
  tool TEXT NOT NULL,
  args TEXT NOT NULL,
  risk INTEGER NOT NULL,
  startedAt TEXT NOT NULL,
  finishedAt TEXT,
  ok INTEGER,
  resultSummary TEXT,
  verifyOk INTEGER,
  verifyEvidence TEXT
);
CREATE INDEX IF NOT EXISTS idx_audit_tool ON audit (tool, startedAt);

CREATE TABLE IF NOT EXISTS sources (
  appName TEXT NOT NULL,
  sourceID TEXT NOT NULL,
  archivePath TEXT NOT NULL,
  releaseID TEXT,
  createdAt TEXT NOT NULL,
  PRIMARY KEY (appName, sourceID)
);

CREATE TABLE IF NOT EXISTS app_memory (
  appName TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  updatedAt TEXT NOT NULL,
  PRIMARY KEY (appName, key)
);

CREATE TABLE IF NOT EXISTS metric_snapshots (
  appName TEXT NOT NULL,
  ts TEXT NOT NULL,
  cpu REAL,
  memMB REAL,
  latencyMs REAL,
  healthStatus INTEGER
);
CREATE INDEX IF NOT EXISTS idx_metric_snapshots_app ON metric_snapshots (appName, ts);

CREATE TABLE IF NOT EXISTS alerts (
  id TEXT PRIMARY KEY,
  appName TEXT NOT NULL,
  severity TEXT NOT NULL,
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  createdAt TEXT NOT NULL,
  acknowledgedAt TEXT
);
