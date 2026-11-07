#!/usr/bin/env node
/** Nightshift command line. */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { randomUUID } from 'node:crypto'
import { ConfigError, loadConfig, writeStarterConfig, type Config } from './config.ts'
import { Daemon } from './daemon.ts'
import { Store } from './db.ts'
import { checkAuth, listComments } from './github.ts'
import { exec } from './git.ts'
import { intake, ticketIdFor } from './intake.ts'
import { Logger, levelFromEnv, type Level } from './log.ts'
import { resolveOpencode } from './opencode.ts'
import { executeTicket } from './ticket.ts'
import type { Ticket, Trigger } from './types.ts'

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }

const USAGE = `nightshift ${pkg.version} - an always-on coding agent for one GitHub repository

Usage:
  nightshift init [--repo owner/name] [--agent login] [--allow login[,login]] [--model provider/model] [--dir <path>]
  nightshift run [--config <path>] [--log debug|info|warn|error]
  nightshift once [--config <path>]
  nightshift status [--config <path>] [--all]
  nightshift inject --text "<request>" [--issue <n>] [--actor <login>] [--run]
  nightshift retry <ticketId> [--run]
  nightshift doctor [--config <path>]
  nightshift version

The config file is nightshift.config.json, found in the current directory or a parent.
`

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      config: { type: 'string', short: 'c' },
      repo: { type: 'string' },
      agent: { type: 'string' },
      allow: { type: 'string', multiple: true },
      model: { type: 'string' },
      dir: { type: 'string' },
      text: { type: 'string' },
      issue: { type: 'string' },
      actor: { type: 'string' },
      run: { type: 'boolean', default: false },
      all: { type: 'boolean', default: false },
      log: { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
      version: { type: 'boolean', short: 'v', default: false },
    },
  })

  const command = positionals[0] ?? (values.help ? 'help' : 'help')
  if (values.help || command === 'help') {
    process.stdout.write(USAGE)
    return 0
  }
  if (values.version || command === 'version') {
    process.stdout.write(`nightshift ${pkg.version}\n`)
    return 0
  }

  const level = (typeof values.log === 'string' ? values.log : levelFromEnv()) as Level
  const log = new Logger(level)

  switch (command) {
    case 'init':
      return await init(log, values)
    case 'run':
    case 'once': {
      const config = loadConfig(values.config as string | undefined)
      const store = openStore(config)
      const recovered = store.requeueRunning()
      if (recovered > 0) log.warn(`requeued ${recovered} ticket(s) left running by a previous process`)
      const daemon = new Daemon(config, store, log)
      process.on('SIGINT', () => daemon.stop())
      process.on('SIGTERM', () => daemon.stop())
      try {
        if (command === 'once') {
          await daemon.tick()
          await daemon.drain()
        } else {
          await daemon.run()
        }
      } finally {
        store.close()
      }
      return 0
    }
    case 'status':
      return status(loadConfig(values.config as string | undefined), values.all === true)
    case 'inject':
      return await inject(loadConfig(values.config as string | undefined), log, values)
    case 'retry':
      return await retry(loadConfig(values.config as string | undefined), log, positionals[1], values.run === true)
    case 'doctor':
      return await doctor(values.config as string | undefined, log)
    default:
      process.stderr.write(`Unknown command: ${command}\n\n${USAGE}`)
      return 2
  }
}

async function init(log: Logger, values: Record<string, unknown>): Promise<number> {
  const dir = typeof values.dir === 'string' ? values.dir : process.cwd()
  const repo = values.repo
  if (typeof repo !== 'string' || !/^[\w.-]+\/[\w.-]+$/.test(repo)) {
    throw new ConfigError('Pass --repo owner/name.')
  }
  const agent = typeof values.agent === 'string' ? values.agent : 'nightshift-bot'
  let allowed = Array.isArray(values.allow) ? values.allow as string[] : []
  if (allowed.length === 0) {
    const auth = await checkAuth()
    if (auth.ok && auth.login) {
      allowed = [auth.login]
      log.info(`defaulting allowedLogins to your GitHub login @${auth.login}`)
    } else {
      throw new ConfigError('Pass --allow <login> (the people who may ask the agent for work).')
    }
  }
  allowed = allowed.flatMap(item => item.split(/[\s,]+/)).map(item => item.trim()).filter(Boolean)
  const model = typeof values.model === 'string' ? values.model : 'opencode-go/glm-5.3'
  const path = writeStarterConfig(dir, repo, agent, allowed, model)
  process.stdout.write(`Wrote ${path}\n\nNext:\n`)
  process.stdout.write(`  1. gh auth login                       # authenticate the GitHub CLI\n`)
  process.stdout.write(`  2. nightshift doctor                   # verify the environment\n`)
  process.stdout.write(`  3. nightshift inject --text "..." --run  # try one request locally\n`)
  process.stdout.write(`  4. nightshift run                      # start the always-on loop\n`)
  return 0
}

function status(config: Config, all: boolean): number {
  const store = openStore(config)
  try {
    const counts = store.counts()
    process.stdout.write(`repo: ${config.repo}  model: ${config.model}  mode: ${config.delivery.mode}\n`)
    process.stdout.write(`tickets: ${Object.entries(counts).map(([key, value]) => `${key}=${value}`).join(' ') || 'none'}\n\n`)
    const tickets = store.listTickets(all ? undefined : 'running', 20)
    if (tickets.length === 0) {
      process.stdout.write(all ? 'No tickets yet.\n' : 'No running tickets. Use --all to see every ticket.\n')
      return 0
    }
    for (const ticket of tickets) {
      process.stdout.write(formatTicket(ticket) + '\n')
    }
    return 0
  } finally {
    store.close()
  }
}

async function inject(config: Config, log: Logger, values: Record<string, unknown>): Promise<number> {
  const text = values.text
  if (typeof text !== 'string' || !text.trim()) throw new ConfigError('Pass --text "<request>".')
  const issue = Number(values.issue ?? 0) || 1
  const actor = typeof values.actor === 'string' ? values.actor : 'local'
  const store = openStore(config)
  try {
    const now = new Date().toISOString()
    const trigger: Trigger = {
      id: `manual:${randomUUID()}`,
      source: 'manual',
      thread: `${config.repo}#${issue}`,
      actor,
      text,
      at: now,
      receivedAt: now,
    }
    store.insertTrigger(trigger)
    const id = ticketIdFor(trigger.id)
    const ticket: Ticket = {
      id,
      triggerId: trigger.id,
      repo: config.repo,
      issue,
      title: text.trim().split('\n')[0]!.slice(0, 80),
      requester: actor,
      branch: `nightshift/${id}`,
      state: 'queued',
      createdAt: now,
      updatedAt: now,
    }
    store.createTicket(ticket)
    log.info(`manual ticket ${id} created`)
    if (values.run === true) {
      const updated = await executeTicket({ config, store, log }, ticket)
      process.stdout.write(formatTicket(updated) + '\n')
      return updated.state === 'done' ? 0 : 1
    }
    process.stdout.write(`${ticket.id}\n`)
    return 0
  } finally {
    store.close()
  }
}

async function retry(config: Config, log: Logger, id: string | undefined, run: boolean): Promise<number> {
  if (!id) throw new ConfigError('Pass a ticket id: nightshift retry <ticketId>')
  const store = openStore(config)
  try {
    const ticket = store.getTicket(id)
    if (!ticket) throw new ConfigError(`No ticket ${id}.`)
    store.resetTicket(id)
    const queued = store.getTicket(id)!
    log.info(`ticket ${id} queued again`)
    if (!run) {
      process.stdout.write(formatTicket(queued) + '\n')
      return 0
    }
    const updated = await executeTicket({ config, store, log }, queued)
    process.stdout.write(formatTicket(updated) + '\n')
    return updated.state === 'done' ? 0 : 1
  } finally {
    store.close()
  }
}

async function doctor(configPath: string | undefined, log: Logger): Promise<number> {
  const checks: { name: string; ok: boolean; detail: string }[] = []
  const nodeMajor = Number(process.versions.node.split('.')[0])
  const nodeMinor = Number(process.versions.node.split('.')[1])
  checks.push({ name: 'node', ok: nodeMajor > 22 || (nodeMajor === 22 && nodeMinor >= 18), detail: process.versions.node })

  const git = await exec('git', ['--version'])
  checks.push({ name: 'git', ok: git.code === 0, detail: git.stdout.trim() || git.stderr.trim() })

  const auth = await checkAuth()
  checks.push({ name: 'gh auth', ok: auth.ok, detail: auth.ok ? `@${auth.login}` : 'run `gh auth login`' })

  let config: Config | undefined
  try {
    config = loadConfig(configPath)
    checks.push({ name: 'config', ok: true, detail: `${config.repo} -> ${config.model}` })
  } catch (error) {
    checks.push({ name: 'config', ok: false, detail: (error as Error).message })
  }

  if (config) {
    const runner = await resolveOpencode(config)
    const version = await exec(runner.command, [...runner.prefix, '--version'])
    checks.push({ name: 'opencode', ok: version.code === 0, detail: `${runner.command} ${version.stdout.trim()}` })
    if (auth.ok) {
      const comments = await listComments(config, new Date(Date.now() - 3_600_000).toISOString())
      checks.push({ name: 'github read', ok: true, detail: `${comments.length} comment(s) in the last hour` })
      const repo = await exec('gh', ['repo', 'view', config.repo, '--json', 'name,defaultBranchRef', '--jq', '.name + " (" + .defaultBranchRef.name + ")"'])
      checks.push({ name: 'github repo', ok: repo.code === 0, detail: repo.code === 0 ? repo.stdout.trim() : (repo.stderr.trim().split('\n')[0] ?? 'cannot read') })
    }
  }

  let failed = false
  for (const check of checks) {
    if (!check.ok) failed = true
    process.stdout.write(`${check.ok ? 'ok  ' : 'FAIL'} ${check.name.padEnd(14)} ${check.detail}\n`)
  }
  if (failed) process.stdout.write('\nFix the FAIL lines before running the agent.\n')
  else process.stdout.write('\nAll checks passed.\n')
  return failed ? 1 : 0
}

function openStore(config: Config): Store {
  return new Store(join(config.stateDir, 'nightshift.db'))
}

function formatTicket(ticket: Ticket): string {
  const pr = ticket.prUrl ? ` ${ticket.prUrl}` : ''
  const error = ticket.error ? `\n    error: ${ticket.error.split('\n')[0]}` : ''
  return `${ticket.id}  ${ticket.state.padEnd(8)} #${ticket.issue}  ${ticket.title}${pr}${error}`
}

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code
  })
  .catch((error: unknown) => {
    if (error instanceof ConfigError) {
      process.stderr.write(`error: ${error.message}\n`)
    } else {
      process.stderr.write(`error: ${(error as Error).stack ?? String(error)}\n`)
    }
    process.exitCode = 1
  })
