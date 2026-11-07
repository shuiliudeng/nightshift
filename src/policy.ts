/** Who may ask the agent for work, and what counts as asking. */

import type { Config } from './config.ts'
import type { Trigger } from './types.ts'

export type AuthResult = { ok: true } | { ok: false; reason: string }

/** Escapes a login for use inside a regular expression. */
function escape(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Whether `text` addresses `login` with an @mention (case-insensitive, not part of a longer handle). */
export function mentions(text: string, login: string): boolean {
  return new RegExp(`(^|[^\\w-])@${escape(login)}(?![\\w-])`, 'i').test(text)
}

/** Removes the agent's mention and the punctuation that usually follows it. */
export function stripMention(text: string, login: string): string {
  return text
    .replace(new RegExp(`(^|[^\\w-])@${escape(login)}(?![\\w-])`, 'gi'), '$1')
    .replace(/^[\s,:，：-]+/, '')
    .trim()
}

/** The first line of the request, used as a ticket title. */
export function titleOf(text: string, fallback: string): string {
  const line = text.split(/\r?\n/).map(item => item.trim()).find(Boolean)
  if (!line) return fallback
  return line.length > 80 ? line.slice(0, 77) + '...' : line
}

/**
 * Decides whether a trigger may start work.
 * Order matters: the agent's own messages are rejected first so a reply can never re-trigger it.
 */
export function authorize(config: Config, trigger: Trigger): AuthResult {
  if (trigger.actor.toLowerCase() === config.agentLogin.toLowerCase()) {
    return { ok: false, reason: 'self' }
  }
  if (trigger.actor.endsWith('[bot]')) {
    return { ok: false, reason: 'bot' }
  }
  const allowed = config.allowedLogins.map(login => login.toLowerCase())
  if (!allowed.includes('*') && !allowed.includes(trigger.actor.toLowerCase())) {
    return { ok: false, reason: 'not-allowed' }
  }
  if (!mentions(trigger.text, config.agentLogin)) {
    return { ok: false, reason: 'not-addressed' }
  }
  return { ok: true }
}
