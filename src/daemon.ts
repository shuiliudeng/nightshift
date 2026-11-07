/** The always-on loop: poll sources, create tickets, run workers. */

import type { Config } from './config.ts'
import type { Store } from './db.ts'
import { listComments, triggerOf } from './github.ts'
import { intake } from './intake.ts'
import type { Logger } from './log.ts'
import { executeTicket } from './ticket.ts'

const CURSOR_KEY = 'github.cursor'

export class Daemon {
  private readonly active = new Map<string, Promise<void>>()
  private readonly controller = new AbortController()
  private readonly config: Config
  private readonly store: Store
  private readonly log: Logger
  private stopped = false

  constructor(config: Config, store: Store, log: Logger) {
    this.config = config
    this.store = store
    this.log = log
  }

  /** Polls once and starts as many queued workers as the concurrency limit allows. */
  async tick(): Promise<void> {
    await this.poll()
    this.dispatch()
  }

  /** Runs until stopped. Errors in one pass are logged, never fatal. */
  async run(): Promise<void> {
    this.log.info(`watching ${this.config.repo} every ${this.config.pollSeconds}s; up to ${this.config.maxWorkers} worker(s)`)
    while (!this.stopped) {
      try {
        await this.tick()
      } catch (error) {
        this.log.error('poll failed:', error)
      }
      await sleep(this.config.pollSeconds * 1_000, this.controller.signal)
    }
    await this.drain()
  }

  /** Stops polling and aborts running workers. */
  stop(): void {
    if (this.stopped) return
    this.stopped = true
    this.log.info('stopping; aborting running workers')
    this.controller.abort()
  }

  /** Waits for every running worker. */
  async drain(): Promise<void> {
    while (this.active.size) {
      await Promise.allSettled([...this.active.values()])
    }
  }

  private async poll(): Promise<void> {
    const now = new Date()
    let cursor = this.store.getMeta(CURSOR_KEY)
    if (!cursor) {
      // Start from one minute ago, so a comment written just before launch is not lost,
      // while the repository's history is not replayed.
      cursor = new Date(now.getTime() - 60_000).toISOString()
      this.store.setMeta(CURSOR_KEY, cursor)
      this.log.info(`first poll: starting from ${cursor}`)
    }

    const comments = await listComments(this.config, cursor, this.log)
    if (comments.length === 0) return

    const triggers = comments.map(item => triggerOf(this.config, item))
    const result = await intake(this.config, this.store, triggers, this.log)
    const newest = comments.at(-1)?.createdAt
    if (newest) {
      // Step back one second so comments sharing a timestamp are not skipped; dedupe makes a replay harmless.
      const at = Date.parse(newest)
      this.store.setMeta(CURSOR_KEY, Number.isFinite(at) ? new Date(at - 1_000).toISOString() : newest)
    }
    if (result.created.length) this.log.info(`intake: ${result.created.length} ticket(s) created`)
  }

  private dispatch(): void {
    while (!this.stopped && this.store.runningCount() < this.config.maxWorkers) {
      const ticket = this.store.nextQueued()
      if (!ticket) return
      const promise = executeTicket({
        config: this.config,
        store: this.store,
        log: this.log,
        signal: this.controller.signal,
      }, ticket)
        .then((updated) => {
          this.log.child(ticket.id).info(`finished: ${updated.state}`)
        })
        .catch((error: unknown) => {
          this.log.child(ticket.id).error('worker crashed:', error)
        })
        .finally(() => {
          this.active.delete(ticket.id)
        })
      this.active.set(ticket.id, promise)
    }
  }
}

/** Abortable sleep. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    if (signal?.aborted) return resolve()
    const timer = setTimeout(done, ms)
    function done(): void {
      clearTimeout(timer)
      signal?.removeEventListener('abort', done)
      resolve()
    }
    signal?.addEventListener('abort', done, { once: true })
  })
}
