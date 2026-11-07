/** GitHub source: poll issue comments that mention the agent, reply, and open pull requests. */

import type { Config } from './config.ts'
import { exec } from './git.ts'
import type { Trigger } from './types.ts'

export interface GithubComment {
  id: number
  body: string
  login: string
  issue: number
  url: string
  createdAt: string
}

export interface IssueInfo {
  number: number
  title: string
  body: string
  author: string
  isPullRequest: boolean
  url: string
}

/** Parses `gh api --paginate --slurp` output: an array of pages, each an array of comments. */
export function parseComments(stdout: string): GithubComment[] {
  let pages: unknown
  try {
    pages = JSON.parse(stdout)
  } catch {
    return []
  }
  const rows = Array.isArray(pages) ? pages.flat() : []
  const comments: GithubComment[] = []
  for (const row of rows) {
    if (!isRecord(row)) continue
    const issueUrl = typeof row.issue_url === 'string' ? row.issue_url : ''
    const issue = Number(issueUrl.split('/').pop())
    const id = Number(row.id)
    const user = isRecord(row.user) ? row.user : {}
    if (!Number.isFinite(id) || !Number.isFinite(issue) || issue <= 0 || typeof row.body !== 'string' || typeof user.login !== 'string') continue
    comments.push({
      id,
      body: row.body,
      login: user.login,
      issue,
      url: typeof row.html_url === 'string' ? row.html_url : '',
      createdAt: typeof row.created_at === 'string' ? row.created_at : new Date().toISOString(),
    })
  }
  return comments.sort((a, b) => a.createdAt.localeCompare(b.createdAt))
}

/** Lists issue comments created or edited since `since`, oldest first. */
export async function listComments(config: Config, since: string, log?: { warn(message: string): void }): Promise<GithubComment[]> {
  const query = new URLSearchParams({
    since,
    per_page: '100',
    sort: 'created',
    direction: 'asc',
  })
  const result = await exec('gh', [
    'api', '--paginate', '--slurp',
    `repos/${config.repo}/issues/comments?${query.toString()}`,
  ])
  if (result.code !== 0) {
    log?.warn(`GitHub poll failed: ${(result.stderr || result.stdout).trim().split('\n')[0] ?? result.code}`)
    return []
  }
  return parseComments(result.stdout)
}

/** Fetches the issue a comment belongs to. */
export async function getIssue(config: Config, issue: number): Promise<IssueInfo | undefined> {
  const result = await exec('gh', ['api', `repos/${config.repo}/issues/${issue}`])
  if (result.code !== 0) return undefined
  try {
    const row = JSON.parse(result.stdout) as Record<string, unknown>
    return {
      number: issue,
      title: typeof row.title === 'string' ? row.title : `Issue #${issue}`,
      body: typeof row.body === 'string' ? row.body : '',
      author: isRecord(row.user) && typeof row.user.login === 'string' ? row.user.login : 'unknown',
      isPullRequest: isRecord(row.pull_request),
      url: typeof row.html_url === 'string' ? row.html_url : `https://github.com/${config.repo}/issues/${issue}`,
    }
  } catch {
    return undefined
  }
}

/** Posts an issue comment. Returns false when GitHub refused it. */
export async function comment(config: Config, issue: number, body: string): Promise<boolean> {
  const result = await exec('gh', ['issue', 'comment', String(issue), '--repo', config.repo, '--body-file', '-'], { input: body })
  return result.code === 0
}

/** Finds an open pull request whose head is `branch`, for retries. */
export async function findPullRequest(config: Config, branch: string): Promise<{ number: number; url: string } | undefined> {
  const result = await exec('gh', ['pr', 'list', '--repo', config.repo, '--head', branch, '--state', 'open', '--json', 'number,url'])
  if (result.code !== 0) return undefined
  try {
    const rows = JSON.parse(result.stdout) as { number: number; url: string }[]
    return rows[0]
  } catch {
    return undefined
  }
}

/** Whether the GitHub CLI is authenticated. */
export async function checkAuth(): Promise<{ ok: boolean; login?: string; error?: string }> {
  const result = await exec('gh', ['api', 'user', '--jq', '.login'])
  if (result.code !== 0) return { ok: false, error: (result.stderr || result.stdout).trim() }
  return { ok: true, login: result.stdout.trim() }
}

/** Builds the trigger for one comment. */
export function triggerOf(config: Config, comment: GithubComment): Trigger {
  return {
    id: `github:comment:${comment.id}`,
    source: 'github',
    thread: `${config.repo}#${comment.issue}`,
    actor: comment.login,
    text: comment.body,
    url: comment.url,
    at: comment.createdAt,
    receivedAt: new Date().toISOString(),
  }
}

/** The mention text with a stable footer, used in prompts. */
export function issueLink(config: Config, issue: number): string {
  return `https://github.com/${config.repo}/issues/${issue}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
