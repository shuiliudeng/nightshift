import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Config } from '../src/config.ts'
import { Store } from '../src/db.ts'
import { must } from '../src/git.ts'
import { Logger } from '../src/log.ts'
import { executeTicket } from '../src/ticket.ts'
import type { Ticket, Trigger } from '../src/types.ts'

const quiet = new Logger('error')

interface Fixture {
  root: string
  remote: string
  config: Config
  store: Store
  cleanup(): void
}

async function fixture(agentSource: string): Promise<Fixture> {
  const root = mkdtempSync(join(tmpdir(), 'nightshift-e2e-'))
  const remote = join(root, 'remote.git')
  const seed = join(root, 'seed')
  const script = join(root, 'fake-opencode.mjs')

  await must('git', ['init', '--bare', '--quiet', remote])
  await must('git', ['clone', '--quiet', remote, seed])
  await must('git', ['-C', seed, 'config', 'user.name', 'Test'])
  await must('git', ['-C', seed, 'config', 'user.email', 'test@example.com'])
  writeFileSync(join(seed, 'README.md'), '# demo\n')
  await must('git', ['-C', seed, 'add', '-A'])
  await must('git', ['-C', seed, 'commit', '--quiet', '-m', 'init'])
  await must('git', ['-C', seed, 'branch', '-M', 'main'])
  await must('git', ['-C', seed, 'push', '--quiet', '-u', 'origin', 'main'])
  await must('git', ['-C', remote, 'symbolic-ref', 'HEAD', 'refs/heads/main'])

  writeFileSync(script, agentSource, 'utf8')

  const config: Config = {
    repo: 'acme/demo',
    agentLogin: 'nightshift-bot',
    allowedLogins: ['alice'],
    model: 'fake/model',
    baseBranch: 'main',
    cloneUrl: remote,
    maxWorkers: 1,
    pollSeconds: 60,
    workspaceDir: join(root, 'workspaces'),
    stateDir: join(root, 'state'),
    delivery: { mode: 'local', comment: false },
    git: { authorName: 'Nightshift', authorEmail: 'nightshift@example.com' },
    opencode: { command: script, extraArgs: [], timeoutMinutes: 2 },
    prompt: { extraInstructions: '' },
    configDir: root,
    configPath: join(root, 'nightshift.config.json'),
  }
  const store = new Store(join(config.stateDir, 'nightshift.db'))
  return {
    root,
    remote,
    config,
    store,
    cleanup(): void {
      store.close()
      rmSync(root, { recursive: true, force: true })
    },
  }
}

function queueTicket(store: Store, text = 'add a file'): Ticket {
  const now = new Date().toISOString()
  const trigger: Trigger = {
    id: `manual:${Math.random()}`,
    source: 'manual',
    thread: 'acme/demo#1',
    actor: 'alice',
    text,
    at: now,
    receivedAt: now,
  }
  store.insertTrigger(trigger)
  const ticket: Ticket = {
    id: 't_test00001',
    triggerId: trigger.id,
    repo: 'acme/demo',
    issue: 1,
    title: 'Add a file',
    requester: 'alice',
    branch: 'nightshift/t_test00001',
    state: 'queued',
    createdAt: now,
    updatedAt: now,
  }
  store.createTicket(ticket)
  return ticket
}

test('a ticket runs, commits, and finishes in local mode', async () => {
  const fx = await fixture(`
import { writeFileSync } from 'node:fs'
writeFileSync('AGENT_OUTPUT.md', '# done\\n')
console.log(JSON.stringify({ type: 'text', sessionID: 'ses_test', part: { type: 'text', text: '## Summary\\nAdded AGENT_OUTPUT.md\\n\\n## Verification\\nnone' } }))
`)
  try {
    const ticket = queueTicket(fx.store)
    const updated = await executeTicket({ config: fx.config, store: fx.store, log: quiet }, ticket)

    assert.equal(updated.state, 'done', updated.error)
    assert.match(updated.summary ?? '', /Added AGENT_OUTPUT/)
    assert.ok(updated.worktree && existsSync(join(updated.worktree, 'AGENT_OUTPUT.md')))
    const log = await must('git', ['-C', updated.worktree!, 'log', '--oneline', '-1'])
    assert.match(log, /nightshift: Add a file/)
  } finally {
    fx.cleanup()
  }
})

test('no changes finishes without a commit', async () => {
  const fx = await fixture(`
console.log(JSON.stringify({ type: 'text', sessionID: 'ses_test', part: { type: 'text', text: '## Summary\\nNothing to do' } }))
`)
  try {
    const ticket = queueTicket(fx.store, 'explain the code')
    const updated = await executeTicket({ config: fx.config, store: fx.store, log: quiet }, ticket)

    assert.equal(updated.state, 'done', updated.error)
    assert.match(updated.summary ?? '', /Nothing to do/)
    const count = await must('git', ['-C', updated.worktree!, 'rev-list', '--count', 'HEAD'])
    assert.equal(count.trim(), '1')
  } finally {
    fx.cleanup()
  }
})

test('a failed agent marks the ticket failed with its error', async () => {
  const fx = await fixture(`
console.error('model exploded')
process.exit(3)
`)
  try {
    const ticket = queueTicket(fx.store)
    const updated = await executeTicket({ config: fx.config, store: fx.store, log: quiet }, ticket)

    assert.equal(updated.state, 'failed')
    assert.match(updated.error ?? '', /code 3/)
    assert.match(updated.error ?? '', /model exploded/)
  } finally {
    fx.cleanup()
  }
})
