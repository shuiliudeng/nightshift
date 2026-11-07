#!/usr/bin/env node
/**
 * One-command Nightshift demo.
 *
 * Creates a temporary bare git repository, writes a config, runs one real
 * OpenCode ticket in local delivery mode, then prints the resulting commit.
 *
 * Usage:
 *   npm run demo
 *   npm run demo -- --model opencode-go/glm-5.3
 *   npm run demo -- --keep
 */

import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const cli = join(projectRoot, 'src', 'cli.ts')

const argv = process.argv.slice(2)
const keep = argv.includes('--keep')
const model = valueOf('--model') ?? 'opencode/deepseek-v4.1-flash-free'

const request = [
  'Create a file named DEMO.md.',
  'It should contain one short paragraph explaining that Nightshift is an always-on coding agent for GitHub,',
  'and end with the exact line: demo complete',
].join(' ')

const root = mkdtempSync(join(tmpdir(), 'nightshift-demo-'))
const remote = join(root, 'remote.git')
const seed = join(root, 'seed')
const configPath = join(root, 'nightshift.config.json')

function valueOf(flag) {
  const index = argv.indexOf(flag)
  return index === -1 ? undefined : argv[index + 1]
}

function git(args, options = {}) {
  return execFileSync('git', args, { encoding: 'utf8', stdio: options.inherit ? 'inherit' : 'pipe', ...options })
}

function runCli(args) {
  const env = { ...process.env }
  env.NODE_OPTIONS = [env.NODE_OPTIONS, '--no-warnings'].filter(Boolean).join(' ')
  return spawnSync(process.execPath, [cli, ...args], { stdio: 'inherit', env, cwd: projectRoot })
}

function line(title) {
  process.stdout.write(`\n=== ${title} ===\n`)
}

let succeeded = false
try {
  line('1/5 creating a temporary git remote')
  git(['init', '--bare', '--quiet', remote])
  git(['clone', '--quiet', remote, seed])
  git(['-C', seed, 'config', 'user.name', 'Nightshift Demo'])
  git(['-C', seed, 'config', 'user.email', 'demo@example.com'])
  writeFileSync(join(seed, 'README.md'), '# Nightshift demo\n\nThis repository is created by `scripts/demo.mjs`.\n')
  git(['-C', seed, 'add', '-A'])
  git(['-C', seed, 'commit', '--quiet', '-m', 'init'])
  git(['-C', seed, 'branch', '-M', 'main'])
  git(['-C', seed, 'push', '--quiet', '-u', 'origin', 'main'])
  git(['-C', remote, 'symbolic-ref', 'HEAD', 'refs/heads/main'])
  process.stdout.write(`remote: ${remote}\n`)

  line('2/5 writing the demo config')
  const config = {
    repo: 'demo/nightshift-demo',
    agentLogin: 'nightshift-bot',
    allowedLogins: ['demo'],
    model,
    baseBranch: 'main',
    cloneUrl: remote,
    maxWorkers: 1,
    pollSeconds: 60,
    workspaceDir: join(root, 'workspaces'),
    stateDir: join(root, 'state'),
    delivery: { mode: 'local', comment: false },
    git: { authorName: 'Nightshift Demo', authorEmail: 'demo@example.com' },
    opencode: { extraArgs: ['--pure'], timeoutMinutes: 10 },
    prompt: { extraInstructions: '' },
  }
  writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n')
  process.stdout.write(`config: ${configPath}\nmodel:  ${model}\n`)

  line('3/5 running one ticket with a real OpenCode model')
  const run = runCli(['inject', '--config', configPath, '--text', request, '--actor', 'demo', '--run'])
  if (run.status !== 0) {
    throw new Error(`nightshift inject exited with code ${run.status}`)
  }

  line('4/5 ticket status')
  runCli(['status', '--config', configPath, '--all'])

  line('5/5 the delivered change')
  const workspace = join(root, 'workspaces')
  const worktreeName = existsSync(workspace)
    ? readdirSync(workspace).find(name => name.startsWith('demo-nightshift-demo-t_'))
    : undefined
  if (!worktreeName) throw new Error('could not find the ticket worktree')
  const worktree = join(workspace, worktreeName)
  const demoFile = join(worktree, 'DEMO.md')
  if (!existsSync(demoFile)) throw new Error(`the agent did not create ${demoFile}`)
  process.stdout.write(`worktree: ${worktree}\n\n`)
  process.stdout.write(readFileSync(demoFile, 'utf8').trim() + '\n\n')
  process.stdout.write(git(['-C', worktree, 'log', '--oneline', '-1']))

  succeeded = true
  process.stdout.write('\nDemo complete.\n')
  if (keep) process.stdout.write(`Artifacts kept at: ${root}\n`)
} catch (error) {
  process.stderr.write(`\nDemo failed: ${error instanceof Error ? error.message : String(error)}\n`)
  process.stderr.write(`Artifacts kept at: ${root}\n`)
  process.stderr.write('Check that OpenCode is installed and the model is available (`opencode models`).\n')
  process.exitCode = 1
} finally {
  if (succeeded && !keep) rmSync(root, { recursive: true, force: true })
}
