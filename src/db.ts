/** Durable state in one SQLite file, using Node's built-in `node:sqlite`. */

import { DatabaseSync, type StatementSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import type { Ticket, TicketState, Trigger } from './types.ts'

const SCHEMA = `
CREATE TABLE IF NOT EXISTS trigger (
  id          TEXT PRIMARY KEY,
  source      TEXT NOT NULL,
  thread      TEXT NOT NULL,
  actor       TEXT NOT NULL,
  text        TEXT NOT NULL,
  url         TEXT,
  at          TEXT NOT NULL,
  received_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ticket (
  id         TEXT PRIMARY KEY,
  trigger_id TEXT NOT NULL UNIQUE,
  repo       TEXT NOT NULL,
  issue      INTEGER NOT NULL,
  title      TEXT NOT NULL,
  requester  TEXT NOT NULL,
  branch     TEXT NOT NULL,
  worktree   TEXT,
  state      TEXT NOT NULL,
  session_id TEXT,
  pr         INTEGER,
  pr_url     TEXT,
  summary    TEXT,
  error      TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  started_at TEXT,
  ended_at   TEXT
);

CREATE INDEX IF NOT EXISTS ticket_state ON ticket(state);
CREATE INDEX IF NOT EXISTS ticket_created ON ticket(created_at);

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`

const TICKET_COLUMNS: Record<string, string> = {
  id: 'id',
  triggerId: 'trigger_id',
  repo: 'repo',
  issue: 'issue',
  title: 'title',
  requester: 'requester',
  branch: 'branch',
  worktree: 'worktree',
  state: 'state',
  sessionId: 'session_id',
  pr: 'pr',
  prUrl: 'pr_url',
  summary: 'summary',
  error: 'error',
  createdAt: 'created_at',
  updatedAt: 'updated_at',
  startedAt: 'started_at',
  endedAt: 'ended_at',
}

export class Store {
  private readonly db: DatabaseSync
  private readonly statements = new Map<string, StatementSync>()

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true })
    this.db = new DatabaseSync(path)
    this.db.exec('PRAGMA journal_mode = WAL;')
    this.db.exec('PRAGMA foreign_keys = ON;')
    this.db.exec(SCHEMA)
  }

  close(): void {
    this.db.close()
  }

  /** Records a trigger; returns false when it was already seen. */
  insertTrigger(trigger: Trigger): boolean {
    const result = this.statement(
      'INSERT OR IGNORE INTO trigger (id, source, thread, actor, text, url, at, received_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(trigger.id, trigger.source, trigger.thread, trigger.actor, trigger.text, trigger.url ?? null, trigger.at, trigger.receivedAt)
    return Number(result.changes) > 0
  }

  getTrigger(id: string): Trigger | undefined {
    const row = this.statement('SELECT * FROM trigger WHERE id = ?').get(id) as TriggerRow | undefined
    return row ? triggerOf(row) : undefined
  }

  createTicket(ticket: Ticket): void {
    this.statement(
      `INSERT INTO ticket (id, trigger_id, repo, issue, title, requester, branch, worktree, state, session_id, pr, pr_url,
        summary, error, created_at, updated_at, started_at, ended_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      ticket.id, ticket.triggerId, ticket.repo, ticket.issue, ticket.title, ticket.requester, ticket.branch,
      ticket.worktree ?? null, ticket.state, ticket.sessionId ?? null, ticket.pr ?? null, ticket.prUrl ?? null,
      ticket.summary ?? null, ticket.error ?? null, ticket.createdAt, ticket.updatedAt,
      ticket.startedAt ?? null, ticket.endedAt ?? null,
    )
  }

  getTicket(id: string): Ticket | undefined {
    const row = this.statement('SELECT * FROM ticket WHERE id = ?').get(id) as TicketRow | undefined
    return row ? ticketOf(row) : undefined
  }

  findTicketByTrigger(triggerId: string): Ticket | undefined {
    const row = this.statement('SELECT * FROM ticket WHERE trigger_id = ?').get(triggerId) as TicketRow | undefined
    return row ? ticketOf(row) : undefined
  }

  updateTicket(id: string, patch: Partial<Ticket>): void {
    const entries = Object.entries(patch).filter(([key, value]) => key in TICKET_COLUMNS && value !== undefined)
    if (entries.length === 0) return
    const assignments = entries.map(([key]) => `${TICKET_COLUMNS[key]} = ?`).join(', ')
    const values = entries.map(([, value]) => value as string | number | null)
    this.statement(`UPDATE ticket SET ${assignments} WHERE id = ?`).run(...values, id)
  }

  /** Puts a failed or stopped ticket back in the queue and clears the previous outcome. */
  resetTicket(id: string): void {
    this.statement(
      `UPDATE ticket SET state = 'queued', error = NULL, summary = NULL, pr = NULL, pr_url = NULL,
         started_at = NULL, ended_at = NULL, updated_at = ? WHERE id = ?`,
    ).run(new Date().toISOString(), id)
  }

  /** Requeues tickets left `running` by a previous process. Returns how many were recovered. */
  requeueRunning(): number {
    const result = this.statement(
      `UPDATE ticket SET state = 'queued', started_at = NULL, updated_at = ? WHERE state = 'running'`,
    ).run(new Date().toISOString())
    return Number(result.changes)
  }

  listTickets(state?: TicketState, limit = 50): Ticket[] {
    const rows = state
      ? this.statement('SELECT * FROM ticket WHERE state = ? ORDER BY created_at DESC LIMIT ?').all(state, limit)
      : this.statement('SELECT * FROM ticket ORDER BY created_at DESC LIMIT ?').all(limit)
    return (rows as unknown as TicketRow[]).map(ticketOf)
  }

  /** The oldest queued ticket, or undefined. */
  nextQueued(): Ticket | undefined {
    const row = this.statement("SELECT * FROM ticket WHERE state = 'queued' ORDER BY created_at ASC LIMIT 1").get() as TicketRow | undefined
    return row ? ticketOf(row) : undefined
  }

  runningCount(): number {
    const row = this.statement("SELECT COUNT(*) AS n FROM ticket WHERE state = 'running'").get() as { n: number }
    return Number(row.n)
  }

  counts(): Record<string, number> {
    const rows = this.statement('SELECT state, COUNT(*) AS n FROM ticket GROUP BY state').all() as { state: string; n: number }[]
    return Object.fromEntries(rows.map(row => [row.state, Number(row.n)]))
  }

  getMeta(key: string): string | undefined {
    const row = this.statement('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined
    return row?.value
  }

  setMeta(key: string, value: string): void {
    this.statement('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value)
  }

  private statement(sql: string): StatementSync {
    let statement = this.statements.get(sql)
    if (!statement) {
      statement = this.db.prepare(sql)
      this.statements.set(sql, statement)
    }
    return statement
  }
}

interface TriggerRow {
  id: string
  source: string
  thread: string
  actor: string
  text: string
  url: string | null
  at: string
  received_at: string
}

interface TicketRow {
  id: string
  trigger_id: string
  repo: string
  issue: number
  title: string
  requester: string
  branch: string
  worktree: string | null
  state: string
  session_id: string | null
  pr: number | null
  pr_url: string | null
  summary: string | null
  error: string | null
  created_at: string
  updated_at: string
  started_at: string | null
  ended_at: string | null
}

function triggerOf(row: TriggerRow): Trigger {
  return {
    id: row.id,
    source: row.source as Trigger['source'],
    thread: row.thread,
    actor: row.actor,
    text: row.text,
    url: row.url ?? undefined,
    at: row.at,
    receivedAt: row.received_at,
  }
}

function ticketOf(row: TicketRow): Ticket {
  return {
    id: row.id,
    triggerId: row.trigger_id,
    repo: row.repo,
    issue: Number(row.issue),
    title: row.title,
    requester: row.requester,
    branch: row.branch,
    worktree: row.worktree ?? undefined,
    state: row.state as TicketState,
    sessionId: row.session_id ?? undefined,
    pr: row.pr === null ? undefined : Number(row.pr),
    prUrl: row.pr_url ?? undefined,
    summary: row.summary ?? undefined,
    error: row.error ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startedAt: row.started_at ?? undefined,
    endedAt: row.ended_at ?? undefined,
  }
}
