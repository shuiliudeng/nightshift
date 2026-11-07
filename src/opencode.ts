/** Runs the OpenCode CLI as the execution engine and collects its result. */

import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Config } from './config.ts'
import { exec } from './git.ts'
import type { Logger } from './log.ts'
import type { AgentRunResult } from './types.ts'

export interface Runner {
  command: string
  /** Arguments inserted before the OpenCode CLI arguments (for a JS wrapper). */
  prefix: string[]
}

/** Finds the real OpenCode executable, avoiding the Windows .cmd shim. */
export async function resolveOpencode(config: Config): Promise<Runner> {
  const explicit = config.opencode.command || process.env.OPENCODE_BIN
  if (explicit) return asRunner(explicit)
  if (process.platform !== 'win32') return { command: 'opencode', prefix: [] }

  const where = await exec('where', ['opencode'])
  if (where.code === 0) {
    for (const line of where.stdout.split(/\r?\n/).map(item => item.trim()).filter(Boolean)) {
      if (line.toLowerCase().endsWith('.exe') && existsSync(line)) return { command: line, prefix: [] }
    }
    for (const line of where.stdout.split(/\r?\n/).map(item => item.trim()).filter(Boolean)) {
      if (line.toLowerCase().endsWith('.cmd') && existsSync(line)) {
        const match = readFileSync(line, 'utf8').match(/"([^"]+\.exe)"/i)
        if (match?.[1] && existsSync(match[1])) return { command: match[1], prefix: [] }
      }
    }
  }
  const appData = process.env.APPDATA
  if (appData) {
    const candidate = join(appData, 'npm', 'node_modules', 'opencode-ai', 'bin', 'opencode.exe')
    if (existsSync(candidate)) return { command: candidate, prefix: [] }
  }
  return { command: 'opencode', prefix: [] }
}

/** A JS wrapper is run with the current Node; anything else is executed directly. */
function asRunner(command: string): Runner {
  if (/\.(?:mjs|cjs|js)$/i.test(command)) return { command: process.execPath, prefix: [command] }
  return { command, prefix: [] }
}

export interface RunOptions {
  dir: string
  prompt: string
  title: string
  sessionId?: string
  signal?: AbortSignal
  onText?: (text: string) => void
}

/** Runs `opencode run` once and returns its assistant text. */
export async function runAgent(config: Config, options: RunOptions, log: Logger): Promise<AgentRunResult> {
  const runner = await resolveOpencode(config)
  const args = [
    'run',
    '--dir', options.dir,
    '--model', config.model,
    '--auto',
    '--format', 'json',
    '--title', options.title,
  ]
  if (options.sessionId) args.push('--session', options.sessionId)
  if (config.opencode.agent) args.push('--agent', config.opencode.agent)
  args.push(...config.opencode.extraArgs, options.prompt)

  log.debug(`opencode ${runner.command} run --dir ${options.dir} --model ${config.model}`)

  return await new Promise<AgentRunResult>((resolve) => {
    const child = spawn(runner.command, [...runner.prefix, ...args], {
      cwd: options.dir,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, NO_COLOR: '1' },
    })

    let stdout = ''
    let stderr = ''
    let pending = ''
    let sessionId: string | undefined
    const texts: string[] = []
    let timedOut = false
    let settled = false

    const timeout = setTimeout(() => {
      timedOut = true
      log.warn(`opencode timed out after ${config.opencode.timeoutMinutes} minutes; killing it`)
      killTree(child.pid)
    }, config.opencode.timeoutMinutes * 60_000)

    const abort = (): void => {
      log.warn('run aborted')
      killTree(child.pid)
    }
    options.signal?.addEventListener('abort', abort, { once: true })

    const finish = (exitCode: number): void => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      options.signal?.removeEventListener('abort', abort)
      resolve({
        sessionId,
        text: texts.join('\n').trim(),
        exitCode,
        raw: (stdout + (stderr ? `\n[stderr]\n${stderr}` : '')).slice(-200_000),
        timedOut,
      })
    }

    const consume = (chunk: string): void => {
      pending += chunk
      for (;;) {
        const index = pending.indexOf('\n')
        if (index === -1) break
        const line = pending.slice(0, index).trim()
        pending = pending.slice(index + 1)
        if (!line) continue
        let event: unknown
        try { event = JSON.parse(line) } catch { continue }
        if (!isRecord(event)) continue
        if (typeof event.sessionID === 'string') sessionId = event.sessionID
        if (event.type === 'text' && isRecord(event.part) && typeof event.part.text === 'string') {
          texts.push(event.part.text)
          options.onText?.(event.part.text)
        }
        if (event.type === 'error' && isRecord(event.error) && typeof event.error.message === 'string') {
          stderr += `\n${event.error.message}`
        }
      }
    }

    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => {
      stdout += chunk
      if (stdout.length > 2_000_000) stdout = stdout.slice(-1_000_000)
      consume(chunk)
    })
    child.stderr?.on('data', (chunk: string) => {
      stderr += chunk
      if (stderr.length > 200_000) stderr = stderr.slice(-100_000)
    })
    child.on('error', (error) => {
      stderr += `\n${error.message}`
      finish(-1)
    })
    child.on('close', (code) => finish(code ?? -1))
  })
}

/** Kills a process and its children; OpenCode may spawn a local server. */
function killTree(pid: number | undefined): void {
  if (!pid) return
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
    return
  }
  try { process.kill(pid, 'SIGTERM') } catch { /* already gone */ }
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
