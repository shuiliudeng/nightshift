/** Core domain types shared by the store, sources, and executor. */

export type SourceName = 'github' | 'manual'

/** One immutable request observed by a source. `text` is untrusted external data. */
export interface Trigger {
  /** Stable id: `github:comment:<id>`, `manual:<uuid>`. */
  id: string
  source: SourceName
  /** Conversation key, for GitHub `owner/repo#<issue>`. */
  thread: string
  /** Who asked. */
  actor: string
  /** Raw request text, with the mention left in. */
  text: string
  url?: string
  /** Source timestamp (ISO 8601). */
  at: string
  receivedAt: string
}

export type TicketState = 'queued' | 'running' | 'done' | 'failed' | 'stopped'

/** One authorized work item and its lifecycle. */
export interface Ticket {
  id: string
  triggerId: string
  repo: string
  issue: number
  title: string
  requester: string
  branch: string
  worktree?: string
  state: TicketState
  sessionId?: string
  pr?: number
  prUrl?: string
  summary?: string
  error?: string
  createdAt: string
  updatedAt: string
  startedAt?: string
  endedAt?: string
}

/** Outcome of one `opencode run` invocation. */
export interface AgentRunResult {
  sessionId?: string
  /** Concatenated assistant text parts. */
  text: string
  exitCode: number
  /** Raw stdout/stderr, for logs and failure reports. */
  raw: string
  timedOut: boolean
}
