import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Config } from '../src/config.ts'
import { authorize, mentions, stripMention, titleOf } from '../src/policy.ts'
import type { Trigger } from '../src/types.ts'

const config = {
  agentLogin: 'Nightshift-Bot',
  allowedLogins: ['alice', 'Bob'],
} as Config

const trigger = (actor: string, text: string): Trigger => ({
  id: 'github:comment:1',
  source: 'github',
  thread: 'acme/demo#1',
  actor,
  text,
  at: '2026-01-01T00:00:00.000Z',
  receivedAt: '2026-01-01T00:00:00.000Z',
})

test('mentions are case-insensitive and bounded', () => {
  assert.equal(mentions('hey @nightshift-bot can you', 'nightshift-bot'), true)
  assert.equal(mentions('@Nightshift-Bot', 'nightshift-bot'), true)
  assert.equal(mentions('@nightshift-bot.', 'nightshift-bot'), true)
  assert.equal(mentions('@nightshift-bot2 please', 'nightshift-bot'), false)
  assert.equal(mentions('mail me at a@nightshift-bot', 'nightshift-bot'), false)
})

test('stripMention removes the handle and leading punctuation', () => {
  assert.equal(stripMention('@nightshift-bot: fix the bug', 'nightshift-bot'), 'fix the bug')
  assert.equal(stripMention('hey @nightshift-bot, fix it', 'nightshift-bot'), 'hey , fix it')
})

test('titleOf uses the first non-empty line and truncates', () => {
  assert.equal(titleOf('\n\n  Fix login  \nmore', 'fallback'), 'Fix login')
  assert.equal(titleOf('', 'fallback'), 'fallback')
  assert.equal(titleOf('x'.repeat(100), 'fallback').length, 80)
})

test('authorize rejects self, bots, strangers, and unaddressed comments', () => {
  assert.deepEqual(authorize(config, trigger('nightshift-bot', '@nightshift-bot do it')), { ok: false, reason: 'self' })
  assert.deepEqual(authorize(config, trigger('dependabot[bot]', '@nightshift-bot do it')), { ok: false, reason: 'bot' })
  assert.deepEqual(authorize(config, trigger('mallory', '@nightshift-bot do it')), { ok: false, reason: 'not-allowed' })
  assert.deepEqual(authorize(config, trigger('alice', 'do it')), { ok: false, reason: 'not-addressed' })
  assert.deepEqual(authorize(config, trigger('alice', '@nightshift-bot do it')), { ok: true })
  assert.deepEqual(authorize(config, trigger('Bob', '@NightShift-Bot do it')), { ok: true })
})

test('a wildcard allowlist admits any human', () => {
  const open = { ...config, allowedLogins: ['*'] } as Config
  assert.deepEqual(authorize(open, trigger('anyone', '@nightshift-bot do it')), { ok: true })
})
