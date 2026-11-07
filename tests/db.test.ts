import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../src/db.ts'
import type { Ticket, Trigger } from '../src/types.ts'

const trigger = (id: string): Trigger => ({
  id,
  source: 'manual',
  thread: 'acme/demo#1',
  actor: 'alice',
  text: 'do it',
  at: '2026-01-01T00:00:00.000Z',
  receivedAt: '2026-01-01T00:00:00.000Z',
})

const ticket = (id: string): Ticket => ({
  id,
  triggerId: 'manual:1',
  repo: 'acme/demo',
  issue: 1,
  title: 'Fix it',
  requester: 'alice',
  branch: `nightshift/${id}`,
  state: 'queued',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
})

test('triggers are deduplicated', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nightshift-db-'))
  const store = new Store(join(dir, 'state.db'))
  try {
    assert.equal(store.insertTrigger(trigger('a')), true)
    assert.equal(store.insertTrigger(trigger('a')), false)
    assert.equal(store.getTrigger('a')?.actor, 'alice')
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('tickets round-trip and reset', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nightshift-db-'))
  const store = new Store(join(dir, 'state.db'))
  try {
    store.insertTrigger(trigger('manual:1'))
    store.createTicket(ticket('t_1'))
    assert.equal(store.getTicket('t_1')?.state, 'queued')
    assert.equal(store.nextQueued()?.id, 't_1')
    assert.equal(store.runningCount(), 0)

    store.updateTicket('t_1', { state: 'failed', error: 'boom', endedAt: '2026-01-02T00:00:00.000Z' })
    assert.equal(store.getTicket('t_1')?.error, 'boom')
    assert.equal(store.nextQueued(), undefined)

    store.resetTicket('t_1')
    const reset = store.getTicket('t_1')!
    assert.equal(reset.state, 'queued')
    assert.equal(reset.error, undefined)
    assert.equal(reset.endedAt, undefined)

    store.updateTicket('t_1', { state: 'running', startedAt: '2026-01-03T00:00:00.000Z' })
    assert.equal(store.requeueRunning(), 1)
    assert.equal(store.getTicket('t_1')?.state, 'queued')
    assert.equal(store.getTicket('t_1')?.startedAt, undefined)
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('meta survives a reopen', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nightshift-db-'))
  const path = join(dir, 'state.db')
  const first = new Store(path)
  first.setMeta('cursor', '123')
  first.close()
  const second = new Store(path)
  try {
    assert.equal(second.getMeta('cursor'), '123')
  } finally {
    second.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
