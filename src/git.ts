/** Git and GitHub CLI plumbing: base clone, per-ticket worktrees, commits, pushes, pull requests. */

import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { Config } from './config.ts'
import type { Logger } from './log.ts'
import type { Ticket } from './types.ts'

export class CommandError extends Error {
  readonly command: string
  readonly code: number | string
  readonly stdout: string
  readonly stderr: string

  constructor(command: string, code: number | string, stdout: string, stderr: string) {
    super(`${command} failed (${code}): ${(stderr || stdout).trim().split('\n').slice(-5).join(' | ')}`)
    this.command = command
    this.code = code
    this.stdout = stdout
    this.stderr = stderr
  }
}

export interface ExecResult {
  stdout: string
  stderr: string
  code: number
}

/** Runs a program without a shell, so arguments are never re-parsed. */
export function exec(program: string, args: string[], options: { cwd?: string; input?: string; timeoutMs?: number } = {}): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      program,
      args,
      {
        cwd: options.cwd,
        timeout: options.timeoutMs,
        maxBuffer: 32 * 1024 * 1024,
        windowsHide: true,
        encoding: 'utf8',
      },
      (error, stdout, stderr) => {
        const code = error ? (typeof error.code === 'number' ? error.code : String(error.code ?? 'error')) : 0
        if (error && (error as NodeJS.ErrnoException).code === 'ENOENT') {
          reject(new CommandError(program, 'ENOENT', stdout ?? '', stderr ?? ''))
          return
        }
        resolve({ stdout: stdout ?? '', stderr: stderr ?? '', code: typeof code === 'number' ? code : 1 })
      },
    )
    if (options.input !== undefined) {
      child.stdin?.end(options.input)
    }
  })
}

/** Runs a program and throws `CommandError` on a non-zero exit. */
export async function must(program: string, args: string[], options: { cwd?: string; input?: string; timeoutMs?: number } = {}): Promise<string> {
  const result = await exec(program, args, options)
  if (result.code !== 0) throw new CommandError(`${program} ${args.join(' ')}`, result.code, result.stdout, result.stderr)
  return result.stdout
}

/** The local base clone of the configured repository. */
export function baseDirectory(config: Config): string {
  return join(config.workspaceDir, config.repo.replace('/', '-'))
}

/** Clones the repository on first use, then fetches. Returns the base directory. */
export async function ensureBaseClone(config: Config, log: Logger): Promise<string> {
  const dir = baseDirectory(config)
  await mkdir(config.workspaceDir, { recursive: true })
  if (!existsSync(join(dir, '.git'))) {
    log.info(`cloning ${config.repo} into ${dir}`)
    if (config.cloneUrl) {
      await must('git', ['clone', '--quiet', config.cloneUrl, dir])
    } else {
      await must('gh', ['repo', 'clone', config.repo, dir, '--', '--quiet'])
    }
  } else {
    log.debug(`fetching ${config.repo}`)
    await must('git', ['-C', dir, 'fetch', 'origin', '--prune', '--quiet'])
  }
  return dir
}

/** The branch new work starts from. */
export async function defaultBranch(config: Config, base: string): Promise<string> {
  if (config.baseBranch) return config.baseBranch
  const head = await exec('git', ['-C', base, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])
  if (head.code === 0 && head.stdout.trim()) return head.stdout.trim().replace(/^origin\//, '')
  const view = await exec('gh', ['repo', 'view', config.repo, '--json', 'defaultBranchRef', '--jq', '.defaultBranchRef.name'])
  if (view.code === 0 && view.stdout.trim()) return view.stdout.trim()
  return 'main'
}

/** Directory of a ticket's worktree. */
export function worktreeDirectory(config: Config, ticket: Ticket): string {
  return join(config.workspaceDir, `${config.repo.replace('/', '-')}-${ticket.id}`)
}

/** Creates a fresh worktree on a fresh branch from `origin/<base>`. */
export async function prepareWorktree(config: Config, ticket: Ticket, base: string, log: Logger): Promise<string> {
  const branch = ticket.branch
  const dir = worktreeDirectory(config, ticket)
  const baseDir = baseDirectory(config)

  if (existsSync(dir)) {
    log.warn(`removing stale worktree ${dir}`)
    await exec('git', ['-C', baseDir, 'worktree', 'remove', '--force', dir])
    await rm(dir, { recursive: true, force: true })
  }
  await exec('git', ['-C', baseDir, 'branch', '-D', branch])

  log.info(`creating worktree ${dir} on ${branch} from origin/${base}`)
  await must('git', ['-C', baseDir, 'worktree', 'add', '-B', branch, dir, `origin/${base}`])
  await exec('git', ['-C', dir, 'config', 'user.name', config.git.authorName])
  await exec('git', ['-C', dir, 'config', 'user.email', config.git.authorEmail])
  return dir
}

/** Removes a worktree and its branch, best effort. */
export async function removeWorktree(config: Config, ticket: Ticket, log: Logger): Promise<void> {
  const dir = ticket.worktree ?? worktreeDirectory(config, ticket)
  const baseDir = baseDirectory(config)
  log.debug(`removing worktree ${dir}`)
  await exec('git', ['-C', baseDir, 'worktree', 'remove', '--force', dir])
  await rm(dir, { recursive: true, force: true })
  await exec('git', ['-C', baseDir, 'branch', '-D', ticket.branch])
}

/** Whether the worktree has any change, staged or not. */
export async function hasChanges(dir: string): Promise<boolean> {
  const status = await must('git', ['-C', dir, 'status', '--porcelain'])
  return status.trim().length > 0
}

/** `git diff --stat` for the change report, including new files. */
export async function diffStat(dir: string): Promise<string> {
  await exec('git', ['-C', dir, 'add', '-A'])
  const result = await exec('git', ['-C', dir, 'diff', '--cached', '--stat', 'HEAD'])
  return result.stdout.trim()
}

/** Stages everything and commits. Returns the commit subject. */
export async function commitAll(config: Config, dir: string, subject: string, body: string): Promise<void> {
  await must('git', ['-C', dir, 'add', '-A'])
  await must('git', [
    '-C', dir,
    '-c', `user.name=${config.git.authorName}`,
    '-c', `user.email=${config.git.authorEmail}`,
    'commit', '-m', subject, '-m', body,
  ])
}

/** Pushes the branch to origin. */
export async function push(dir: string, branch: string): Promise<void> {
  await must('git', ['-C', dir, 'push', '--set-upstream', 'origin', branch])
}

export interface PullRequest {
  number: number
  url: string
}

/** Opens a pull request with `gh`, reading the body from stdin. */
export async function createPullRequest(config: Config, options: {
  head: string
  base: string
  title: string
  body: string
}): Promise<PullRequest> {
  const output = await must('gh', [
    'pr', 'create',
    '--repo', config.repo,
    '--head', options.head,
    '--base', options.base,
    '--title', options.title,
    '--body-file', '-',
  ], { input: options.body })
  const url = output.trim().split('\n').find(line => /^https?:\/\//.test(line)) ?? output.trim()
  const match = url.match(/\/pull\/(\d+)/)
  return { number: match ? Number(match[1]) : 0, url }
}
