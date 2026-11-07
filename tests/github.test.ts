import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Config } from '../src/config.ts'
import { parseComments, triggerOf } from '../src/github.ts'
import { issueOf } from '../src/intake.ts'
import type { Trigger } from '../src/types.ts'

const config = { repo: 'acme/demo', agentLogin: 'nightshift-bot' } as unknown as Config

test('parseComments flattens pages and sorts by creation time', () => {
  const stdout = JSON.stringify([
    [
      {
        id: 2,
        body: '@nightshift-bot second',
        user: { login: 'bob' },
        issue_url: 'https://api.github.com/repos/acme/demo/issues/7',
        html_url: 'https://github.com/acme/demo/issues/7#issuecomment-2',
        created_at: '2026-01-02T00:00:00.000Z',
      },
    ],
    [
      {
        id: 1,
        body: '@nightshift-bot first',
        user: { login: 'alice' },
        issue_url: 'https://api.github.com/repos/acme/demo/issues/3',
        html_url: 'https://github.com/acme/demo/issues/3#issuecomment-1',
        created_at: '2026-01-01T00:00:00.000Z',
      },
      { id: 3, body: 'missing user' },
      'not a comment',
    ],
  ])

  const comments = parseComments(stdout)
  assert.deepEqual(comments.map(comment => comment.id), [1, 2])
  assert.equal(comments[0]?.issue, 3)
  assert.equal(comments[1]?.login, 'bob')
})

test('parseComments tolerates invalid JSON and empty pages', () => {
  assert.deepEqual(parseComments('not json'), [])
  assert.deepEqual(parseComments('[]'), [])
})

test('triggerOf builds a stable trigger id and thread', () => {
  const trigger = triggerOf(config, {
    id: 42,
    body: '@nightshift-bot fix it',
    login: 'alice',
    issue: 9,
    url: 'https://github.com/acme/demo/issues/9#issuecomment-42',
    createdAt: '2026-01-01T00:00:00.000Z',
  })
  assert.equal(trigger.id, 'github:comment:42')
  assert.equal(trigger.thread, 'acme/demo#9')
  assert.equal(trigger.actor, 'alice')
  assert.equal(trigger.source, 'github')
})

test('issueOf reads the issue number from a thread key', () => {
  const base: Trigger = {
    id: 'manual:1',
    source: 'manual',
    thread: 'acme/demo#17',
    actor: 'alice',
    text: 'do it',
    at: '2026-01-01T00:00:00.000Z',
    receivedAt: '2026-01-01T00:00:00.000Z',
  }
  assert.equal(issueOf(base), 17)
  assert.equal(issueOf({ ...base, thread: 'acme/demo' }), 0)
})
