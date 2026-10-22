/**
 * Mount smoke on the published cordis runtime.
 *
 * The unit suite already mounts the guard on a real `Context`; this script is
 * the standalone reading a maintainer or a reviewer can run in one command. It
 * mounts `@deepseek-ai/cordis` and the published LLM service, dispatches one
 * request through the real `llm/stream` waterfall, and reports what the adapter
 * received, how many times other listeners saw the request, whether the guard
 * waited for the `llm` service, and whether disposing it restores the raw
 * request.
 *
 * Run: node scripts/mount-smoke.mjs
 */
import assert from 'node:assert/strict'

import { Context } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'

import guardPlugin from '../lib/index.js'
import { RecordingAdapter } from '../test/fixtures/adapter.mjs'
import { LONE_HIGH, PAIR, REPLACEMENT, request, textOf, user } from '../test/fixtures/history.mjs'

const ctx = new Context()
await ctx.plugin(LlmRuntime)

const adapter = new RecordingAdapter()
ctx.llm.registerAdapter(['guarded'], adapter)

const observed = []
ctx.on('llm/stream', (options, next) => {
  observed.push(options)
  return next()
})

// Mounted before the runtime exists it would stay pending; here it is mounted
// after, so this also proves the guard loads once `llm` is available.
const fiber = ctx.plugin(guardPlugin)
await fiber

const drain = async options => {
  const chunks = []
  for await (const chunk of ctx.llm.stream(options)) chunks.push(chunk)
  return chunks
}

await drain(request([user(LONE_HIGH)]))
const guarded = adapter.requests[0]
assert.equal(adapter.requests.length, 1, 'exactly one request may reach the adapter')
assert.equal(observed.length, 1, 'other listeners must see the request once')
assert.equal(observed[0], guarded, 'the observed request is the one that went out')
assert.equal(textOf(guarded.messages[0]), `tail ${REPLACEMENT}`, 'the frame carries U+FFFD')
assert.equal(Object.isFrozen(guarded), true, 'the adapter still observes a frozen request')

const before = request([user(PAIR)])
await drain(before)
assert.equal(adapter.requests[1], before, 'a well-formed request reaches the adapter as the caller built it')

const snapshot = {
  adapterRequests: adapter.requests.length,
  observed: observed.length,
  frozen: Object.isFrozen(guarded),
}

await fiber.dispose()
const after = request([user(LONE_HIGH)])
await drain(after)
const restored = adapter.requests.at(-1)
assert.equal(restored, after, 'after dispose the caller request reaches the adapter unchanged')
assert.equal(textOf(restored.messages[0]), LONE_HIGH, 'and it still carries the lone surrogate')

console.log('mount smoke: PASS')
console.log(`  requests reaching the adapter after the guarded dispatch: ${snapshot.adapterRequests}`)
console.log(`  listeners observing that request: ${snapshot.observed}`)
console.log(`  request frozen at the adapter: ${snapshot.frozen}`)
console.log(`  teardown observable: ${restored === after}`)
