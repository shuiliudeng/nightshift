/** Builds the prompt a ticket's worker receives. */

import type { Config } from './config.ts'
import { issueLink } from './github.ts'
import { stripMention } from './policy.ts'
import type { Ticket, Trigger } from './types.ts'

const MAX_REQUEST_CHARS = 12_000

/** Renders the assignment text for one ticket. */
export function buildPrompt(config: Config, ticket: Ticket, trigger: Trigger): string {
  const request = truncate(stripMention(trigger.text, config.agentLogin), MAX_REQUEST_CHARS)
  const extra = config.prompt.extraInstructions.trim()
  const lines = [
    `You are Nightshift, an autonomous coding agent working on the repository \`${config.repo}\`.`,
    '',
    `## Request`,
    `A maintainer (@${trigger.actor}) asked in ${issueLink(config, ticket.issue)}:`,
    '',
    quote(request),
    '',
    `## Your job`,
    `Work in the current checkout. It is already on branch \`${ticket.branch}\`, created from \`${config.baseBranch || 'the default branch'}\`.`,
    '',
    'Rules:',
    '1. Make the smallest change that fully satisfies the request. Do not refactor unrelated code.',
    '2. Read the repository first: AGENTS.md, README, and the files the request touches.',
    '3. Run the most relevant tests or checks before finishing. If they cannot run, say why.',
    '4. Do not create branches, commit, push, or open pull requests. The harness does that.',
    '5. Do not touch secrets, credentials, CI configuration, or files outside this checkout.',
    '6. If the request is ambiguous, unsafe, or impossible, change nothing and explain what a person must decide.',
    '7. Never mention this agent with @ in your output; it could re-trigger it.',
    '',
    'Finish with a short report in this shape:',
    '',
    '```',
    '## Summary',
    '<one or two sentences on what changed and why>',
    '',
    '## Verification',
    '<commands run and their outcome, or why nothing could be run>',
    '```',
  ]
  if (extra) lines.push('', '## Team instructions', extra)
  return lines.join('\n')
}

/** A short comment posted on the issue before work starts. */
export function acknowledgement(config: Config, ticket: Ticket, trigger: Trigger): string {
  return [
    `On it. I opened ticket \`${ticket.id}\` for @${trigger.actor} and will report back with a pull request.`,
    '',
    `- model: \`${config.model}\``,
  ].join('\n')
}

/** The comment posted when a ticket ends. */
export function completionComment(config: Config, ticket: Ticket, result: { summary?: string; prUrl?: string; error?: string; committed?: boolean }): string {
  if (result.error) {
    return [
      `I could not complete this request.`,
      '',
      `**Ticket:** \`${ticket.id}\``,
      '',
      '```',
      truncate(result.error.trim(), 3_000),
      '```',
      '',
      `A maintainer can retry with \`nightshift retry ${ticket.id}\`.`,
    ].join('\n')
  }
  const lines = [
    result.prUrl
      ? `Done: ${result.prUrl}`
      : result.committed === false
        ? 'Done. No change was necessary.'
        : `Done. The change is committed on branch \`${ticket.branch}\` (local mode).`,
    '',
    `**Ticket:** \`${ticket.id}\`  `,
    `**Branch:** \`${ticket.branch}\`  `,
    `**Model:** \`${config.model}\``,
  ]
  if (result.summary) lines.push('', '---', '', truncate(result.summary.trim(), 6_000))
  return lines.join('\n')
}

function quote(text: string): string {
  return text.split('\n').map(line => `> ${line}`).join('\n')
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text
  return text.slice(0, max) + `\n\n[... truncated ${text.length - max} characters]`
}
