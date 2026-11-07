/** Configuration loading and validation. */

import { readFileSync, existsSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, resolve } from 'node:path'

export interface DeliveryConfig {
  /** `pr` pushes the branch and opens a pull request; `local` only commits in the worktree. */
  mode: 'pr' | 'local'
  /** Whether to comment on the source issue. */
  comment: boolean
}

export interface GitConfig {
  authorName: string
  authorEmail: string
}

export interface OpencodeConfig {
  /** Explicit path to the opencode executable. Auto-detected when empty. */
  command?: string
  /** Optional OpenCode agent name passed with --agent. */
  agent?: string
  extraArgs: string[]
  timeoutMinutes: number
}

export interface PromptConfig {
  extraInstructions: string
}

export interface Config {
  repo: string
  agentLogin: string
  allowedLogins: string[]
  model: string
  baseBranch: string
  /** Optional git URL used instead of `gh repo clone` (SSH, local path, self-hosted). */
  cloneUrl?: string
  maxWorkers: number
  pollSeconds: number
  workspaceDir: string
  stateDir: string
  delivery: DeliveryConfig
  git: GitConfig
  opencode: OpencodeConfig
  prompt: PromptConfig
  /** Directory of the config file, used to resolve relative paths. */
  configDir: string
  /** Absolute path of the config file. */
  configPath: string
}

export class ConfigError extends Error {}

const DEFAULTS = {
  baseBranch: '',
  maxWorkers: 1,
  pollSeconds: 60,
  workspaceDir: '.nightshift/workspaces',
  stateDir: '.nightshift/state',
  delivery: { mode: 'pr' as const, comment: true },
  git: { authorName: 'Nightshift', authorEmail: 'nightshift@users.noreply.github.com' },
  opencode: { extraArgs: [] as string[], timeoutMinutes: 30 },
  prompt: { extraInstructions: '' },
}

/** Finds `nightshift.config.json` in `dir` or its parents. */
export function findConfig(start = process.cwd()): string | undefined {
  let dir = resolve(start)
  for (;;) {
    const candidate = resolve(dir, 'nightshift.config.json')
    if (existsSync(candidate)) return candidate
    const parent = dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
}

/** Loads and validates the configuration file. Throws `ConfigError` with a readable message. */
export function loadConfig(path?: string): Config {
  const configPath = path ? resolve(path) : findConfig()
  if (!configPath) {
    throw new ConfigError('No nightshift.config.json found. Run `nightshift init` or pass --config <path>.')
  }
  if (!existsSync(configPath)) throw new ConfigError(`Config file not found: ${configPath}`)

  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(configPath, 'utf8'))
  } catch (error) {
    throw new ConfigError(`Cannot parse ${configPath}: ${(error as Error).message}`)
  }
  if (!isRecord(raw)) throw new ConfigError('Config must be a JSON object.')

  const repo = stringField(raw, 'repo')
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new ConfigError(`"repo" must be "owner/name", got ${JSON.stringify(repo)}`)
  const agentLogin = stringField(raw, 'agentLogin')
  if (!/^[\w.-]+$/.test(agentLogin)) throw new ConfigError(`"agentLogin" must be a GitHub login, got ${JSON.stringify(agentLogin)}`)
  const model = stringField(raw, 'model')

  const allowed = raw.allowedLogins
  if (!Array.isArray(allowed) || allowed.length === 0 || !allowed.every(item => typeof item === 'string' && item.length > 0)) {
    throw new ConfigError('"allowedLogins" must be a non-empty array of GitHub logins, or ["*"].')
  }

  const configDir = dirname(configPath)
  const workspaceDir = resolvePath(configDir, optionalString(raw, 'workspaceDir') ?? DEFAULTS.workspaceDir)
  const stateDir = resolvePath(configDir, optionalString(raw, 'stateDir') ?? DEFAULTS.stateDir)

  const delivery = isRecord(raw.delivery) ? raw.delivery : {}
  const mode = optionalString(delivery, 'mode') ?? DEFAULTS.delivery.mode
  if (mode !== 'pr' && mode !== 'local') throw new ConfigError('"delivery.mode" must be "pr" or "local".')

  const git = isRecord(raw.git) ? raw.git : {}
  const opencode = isRecord(raw.opencode) ? raw.opencode : {}
  const prompt = isRecord(raw.prompt) ? raw.prompt : {}

  const extraArgs = opencode.extraArgs
  if (extraArgs !== undefined && (!Array.isArray(extraArgs) || !extraArgs.every(item => typeof item === 'string'))) {
    throw new ConfigError('"opencode.extraArgs" must be an array of strings.')
  }

  const maxWorkers = numberField(raw, 'maxWorkers', DEFAULTS.maxWorkers, 1, 16)
  const pollSeconds = numberField(raw, 'pollSeconds', DEFAULTS.pollSeconds, 5, 86_400)
  const timeoutMinutes = numberField(opencode, 'timeoutMinutes', DEFAULTS.opencode.timeoutMinutes, 1, 24 * 60)

  return {
    repo,
    agentLogin,
    allowedLogins: allowed as string[],
    model,
    baseBranch: optionalString(raw, 'baseBranch') ?? DEFAULTS.baseBranch,
    cloneUrl: optionalString(raw, 'cloneUrl') || undefined,
    maxWorkers,
    pollSeconds,
    workspaceDir,
    stateDir,
    delivery: { mode, comment: delivery.comment !== false },
    git: {
      authorName: optionalString(git, 'authorName') ?? DEFAULTS.git.authorName,
      authorEmail: optionalString(git, 'authorEmail') ?? DEFAULTS.git.authorEmail,
    },
    opencode: {
      command: optionalString(opencode, 'command') || undefined,
      agent: optionalString(opencode, 'agent') || undefined,
      extraArgs: (extraArgs as string[] | undefined) ?? [],
      timeoutMinutes,
    },
    prompt: { extraInstructions: optionalString(prompt, 'extraInstructions') ?? '' },
    configDir,
    configPath,
  }
}

/** Writes a starter config. Returns the path written. */
export function writeStarterConfig(dir: string, repo: string, agentLogin: string, allowed: string[], model: string): string {
  const path = resolve(dir, 'nightshift.config.json')
  const value = {
    repo,
    agentLogin,
    allowedLogins: allowed,
    model,
    baseBranch: '',
    maxWorkers: 1,
    pollSeconds: 60,
    workspaceDir: '.nightshift/workspaces',
    stateDir: '.nightshift/state',
    delivery: { mode: 'pr', comment: true },
    git: { authorName: 'Nightshift', authorEmail: 'nightshift@users.noreply.github.com' },
    opencode: { extraArgs: [], timeoutMinutes: 30 },
    prompt: { extraInstructions: '' },
  }
  if (existsSync(path)) throw new ConfigError(`Refusing to overwrite existing ${path}`)
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n', 'utf8')
  return path
}

function resolvePath(base: string, value: string): string {
  return isAbsolute(value) ? value : resolve(base, value)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stringField(value: Record<string, unknown>, key: string): string {
  const field = value[key]
  if (typeof field !== 'string' || field.length === 0) throw new ConfigError(`"${key}" is required and must be a non-empty string.`)
  return field
}

function optionalString(value: Record<string, unknown>, key: string): string | undefined {
  const field = value[key]
  if (field === undefined || field === null) return undefined
  if (typeof field !== 'string') throw new ConfigError(`"${key}" must be a string.`)
  return field
}

function numberField(value: Record<string, unknown>, key: string, fallback: number, min: number, max: number): number {
  const field = value[key]
  if (field === undefined || field === null) return fallback
  if (typeof field !== 'number' || !Number.isFinite(field) || field < min || field > max) {
    throw new ConfigError(`"${key}" must be a number between ${min} and ${max}.`)
  }
  return Math.floor(field)
}
