/** Turns observed triggers into authorized tickets. */

import { createHash } from 'node:crypto'
import type { Config } from './config.ts'
import type { Store } from './db.ts'
import { getIssue } from './github.ts'
import type { Logger } from './log.ts'
import { authorize, stripMention, titleOf } from './policy.ts'
import type { Ticket, Trigger } from './types.ts'

export interface IntakeResult {
  created: Ticket[]
  skipped: { trigger: Trigger; reason: string }[]
}

/** Ticket id derived from the trigger, so re-processing the same comment is idempotent. */
export function ticketIdFor(triggerId: string): string {
  return 't_' + createHash('sha1').update(triggerId).digest('hex').slice(0, 10)
}

/** The issue number encoded in a thread key such as `owner/repo#42`. */
export function issueOf(trigger: Trigger): number {
  const match = trigger.thread.match(/#(\d+)$/)
  return match ? Number(match[1]) : 0
}

/** Records triggers and creates tickets for the ones policy allows. */
export async function intake(config: Config, store: Store, triggers: Trigger[], log: Logger): Promise<IntakeResult> {
  const result: IntakeResult = { created: [], skipped: [] }
  for (const trigger of triggers) {
    if (!store.insertTrigger(trigger)) {
      result.skipped.push({ trigger, reason: 'duplicate' })
      continue
    }
    const auth = authorize(config, trigger)
    if (!auth.ok) {
      log.debug(`ignoring ${trigger.id}: ${auth.reason}`)
      result.skipped.push({ trigger, reason: auth.reason })
      continue
    }
    if (store.findTicketByTrigger(trigger.id)) {
      result.skipped.push({ trigger, reason: 'already-ticketed' })
      continue
    }

    const issueNumber = issueOf(trigger)
    const issue = issueNumber > 0 ? await getIssue(config, issueNumber) : undefined
    if (issue?.isPullRequest) {
      log.info(`ignoring ${trigger.id}: comments on pull requests are not supported yet`)
      result.skipped.push({ trigger, reason: 'pull-request' })
      continue
    }

    const request = stripMention(trigger.text, config.agentLogin)
    const id = ticketIdFor(trigger.id)
    const now = new Date().toISOString()
    const ticket: Ticket = {
      id,
      triggerId: trigger.id,
      repo: config.repo,
      issue: issueNumber,
      title: titleOf(request, issue?.title ?? `Issue #${issueNumber}`),
      requester: trigger.actor,
      branch: `nightshift/${id}`,
      state: 'queued',
      createdAt: now,
      updatedAt: now,
    }
    store.createTicket(ticket)
    log.info(`ticket ${id} created for @${trigger.actor} on #${issueNumber}: ${ticket.title}`)
    result.created.push(ticket)
  }
  return result
}
