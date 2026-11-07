/** Executes one ticket: worktree, OpenCode run, commit, push, pull request, reply. */

import type { Config } from './config.ts'
import type { Store } from './db.ts'
import { commitAll, createPullRequest, defaultBranch, diffStat, ensureBaseClone, hasChanges, prepareWorktree, push } from './git.ts'
import { comment, findPullRequest } from './github.ts'
import type { Logger } from './log.ts'
import { runAgent } from './opencode.ts'
import { acknowledgement, buildPrompt, completionComment } from './prompt.ts'
import type { Ticket } from './types.ts'

export interface WorkerContext {
  config: Config
  store: Store
  log: Logger
  signal?: AbortSignal
}

/** Runs a queued ticket to completion. Returns the updated ticket. */
export async function executeTicket(context: WorkerContext, ticket: Ticket): Promise<Ticket> {
  const { config, store, log } = context
  const scope = log.child(ticket.id)
  const now = new Date().toISOString()

  store.updateTicket(ticket.id, { state: 'running', startedAt: now, updatedAt: now })
  scope.info(`starting: ${ticket.title}`)

  try {
    const base = await ensureBaseClone(config, scope)
    const branchBase = await defaultBranch(config, base)
    scope.info(`base branch: ${branchBase}`)
    const worktree = await prepareWorktree(config, ticket, branchBase, scope)
    store.updateTicket(ticket.id, { worktree, updatedAt: new Date().toISOString() })

    const trigger = store.getTrigger(ticket.triggerId)
    if (!trigger) throw new Error(`trigger ${ticket.triggerId} disappeared`)
    const prompt = buildPrompt(config, ticket, trigger)

    if (config.delivery.comment) {
      const ok = await comment(config, ticket.issue, acknowledgement(config, ticket, trigger))
      if (!ok) scope.warn('could not post the acknowledgement comment')
    }

    const result = await runAgent(config, {
      dir: worktree,
      prompt,
      title: `nightshift ${ticket.id}: ${ticket.title}`.slice(0, 120),
      signal: context.signal,
      onText: text => scope.debug(`agent: ${text.slice(0, 200).replace(/\n/g, ' ')}`),
    }, scope)

    store.updateTicket(ticket.id, { sessionId: result.sessionId, updatedAt: new Date().toISOString() })

    if (result.timedOut) throw new Error(`The agent timed out after ${config.opencode.timeoutMinutes} minutes.`)
    if (result.exitCode !== 0) {
      const detail = (result.raw.match(/\[stderr\]([\s\S]*)$/)?.[1] ?? result.raw).trim()
      throw new Error(`The agent exited with code ${result.exitCode}.\n${detail.slice(-3_000)}`)
    }

    const changed = await hasChanges(worktree)
    if (!changed) {
      scope.info('no changes; finishing without a pull request')
      return finish(context, ticket, {
        summary: result.text || 'No change was necessary.',
        committed: false,
      })
    }

    const stat = await diffStat(worktree)
    scope.info('changes:\n' + stat)
    const subject = `nightshift: ${ticket.title}`.slice(0, 72)
    const body = [
      `Requested by @${ticket.requester} in #${ticket.issue}.`,
      '',
      `Ticket: ${ticket.id}`,
      `Agent: ${config.model}`,
      '',
      result.text ? `Agent report:\n\n${result.text.slice(0, 4_000)}` : '',
    ].join('\n').trim()
    await commitAll(config, worktree, subject, body)

    if (config.delivery.mode === 'pr') {
      scope.info(`pushing ${ticket.branch}`)
      await push(worktree, ticket.branch)
      const existing = await findPullRequest(config, ticket.branch)
      const pr = existing ?? await createPullRequest(config, {
        head: ticket.branch,
        base: branchBase,
        title: ticket.title,
        body: [
          `Closes #${ticket.issue}.`,
          '',
          `Requested by @${ticket.requester}. Opened by Nightshift ticket \`${ticket.id}\`.`,
          '',
          result.text ? `## Agent report\n\n${result.text}` : '',
        ].join('\n'),
      })
      scope.info(`pull request: ${pr.url}`)
      return finish(context, ticket, { summary: result.text, prUrl: pr.url, pr: pr.number, committed: true })
    }

    return finish(context, ticket, { summary: result.text, committed: true })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    scope.error(`failed: ${message}`)
    store.updateTicket(ticket.id, {
      state: 'failed',
      error: message.slice(0, 8_000),
      endedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })
    if (config.delivery.comment) {
      const ok = await comment(config, ticket.issue, completionComment(config, ticket, { error: message }))
      if (!ok) scope.warn('could not post the failure comment')
    }
    return store.getTicket(ticket.id) ?? ticket
  }
}

async function finish(context: WorkerContext, ticket: Ticket, result: { summary?: string; prUrl?: string; pr?: number; error?: string; committed?: boolean }): Promise<Ticket> {
  const { config, store, log } = context
  const now = new Date().toISOString()
  store.updateTicket(ticket.id, {
    state: 'done',
    summary: result.summary?.slice(0, 20_000),
    pr: result.pr,
    prUrl: result.prUrl,
    endedAt: now,
    updatedAt: now,
  })
  const updated = store.getTicket(ticket.id) ?? ticket
  if (config.delivery.comment) {
    const ok = await comment(config, ticket.issue, completionComment(config, updated, result))
    if (!ok) log.child(ticket.id).warn('could not post the completion comment')
  }
  return updated
}
