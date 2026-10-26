/**
 * The second half of the request: extension fields.
 *
 * `llm/stream` carries the model request, but not the top-level fields that
 * `ctx.deepseekLlmApiExtensions` contributes and the adapter merges into the
 * serialized body. `dsh_session_log` is one of them, and because the session
 * log is replayed on every request, a lone surrogate there fails every later
 * turn exactly as one in the messages would.
 *
 * These arms follow the same discipline as the unit suite: the arm that decides
 * whether the seam is worth having is the negative one, and it is asserted by
 * identity — a prepared result carrying no defect must reach the adapter as the
 * registry's own object, not a rebuilt copy of it. The last arm takes the wire
 * reading, driving the real adapter through the same
 * `ctx.get('deepseekLlmApiExtensions')?.prepare(...)` expression the shipped
 * host uses.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { Context } from '@deepseek-ai/cordis'
import ExtensionRegistry from '@deepseek-ai/dsh-deepseek-llm-api-extensions'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import { DeepSeekAdapter, resolveAdapterOptions } from '@deepseek-ai/dsh-llm-deepseek'

import plugin, { createExtensionGuard, name } from '../lib/index.js'
import { LONE_HIGH, LONE_LOW, PAIR, REPLACEMENT, request, user } from './fixtures/history.mjs'

/** One complete, well-formed Messages event stream, so the adapter settles cleanly. */
const SSE = [
  'event: message_start',
  'data: {"type":"message_start","message":{"usage":{"input_tokens":5,"output_tokens":0}}}',
  '',
  'event: content_block_start',
  'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":"ok"}}',
  '',
  'event: content_block_stop',
  'data: {"type":"content_block_stop","index":0}',
  '',
  'event: message_delta',
  'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}',
  '',
  'event: message_stop',
  'data: {"type":"message_stop"}',
  '',
  '',
].join('\n')

/** A request fact set, in the shape the adapter hands the registry. */
const preparedRequest = () => ({ body: {}, signal: new AbortController().signal, sessionId: 'extension-probe' })

/** A prepared result with the shape the registry returns: frozen, null-prototype fields. */
function preparedResult(value, accept = async () => {}) {
  const fields = Object.create(null)
  fields.dsh_session_log = value
  Object.freeze(fields)
  return { fields, accept }
}

test('a clean prepared result is handed on as the registry\'s own object', () => {
  const guard = createExtensionGuard()
  const result = preparedResult({ texts: [PAIR] })
  assert.equal(guard.observe(result), result, 'a result carrying no defect must keep its identity')
  assert.equal(guard.stats.repaired, 0)
  assert.equal(guard.stats.prepared, 1)
})

test('a lone surrogate in a field value is replaced with U+FFFD', () => {
  const guard = createExtensionGuard()
  const result = preparedResult({ texts: [LONE_HIGH, `${LONE_LOW} x`] })
  const observed = guard.observe(result)
  assert.notEqual(observed, result, 'a defective result must be rebuilt')
  assert.deepEqual(observed.fields.dsh_session_log.texts, [`tail ${REPLACEMENT}`, `${REPLACEMENT} head x`])
  assert.equal(guard.stats.repaired, 1)
  assert.ok(!JSON.stringify(observed.fields).includes('\\ud83d'), 'no unpaired surrogate may survive')
})

test('the rebuilt record keeps the null prototype the registry builds', () => {
  const guard = createExtensionGuard()
  const observed = guard.observe(preparedResult({ texts: [LONE_HIGH] }))
  assert.equal(Object.getPrototypeOf(observed.fields), null, 'the record is spread into the body; it may not gain a prototype')
  assert.ok(Object.isFrozen(observed.fields), 'the adapter receives a frozen record')
})

test('the acceptance transaction is carried through the rebuild, not dropped', async () => {
  const guard = createExtensionGuard()
  let accepted = 0
  const accept = async () => { accepted += 1 }
  const observed = guard.observe(preparedResult({ texts: [LONE_HIGH] }, accept))
  assert.equal(observed.accept, accept, 'accept must be the registry\'s own closure')
  await observed.accept()
  assert.equal(accepted, 1, 'a dropped accept would leave the delivery watermark uncommitted')
})

test('a defective field does not churn a clean sibling', () => {
  const guard = createExtensionGuard()
  const clean = { texts: [PAIR] }
  const fields = Object.create(null)
  fields.dsh_log_budget = clean
  fields.dsh_session_log = { texts: [LONE_HIGH] }
  Object.freeze(fields)
  const observed = guard.observe({ fields, accept: async () => {} })
  assert.equal(observed.fields.dsh_log_budget, clean, 'an untouched field is carried by reference')
  assert.deepEqual(Object.keys(observed.fields), ['dsh_log_budget', 'dsh_session_log'], 'every key survives')
})

test('a result the guard cannot read is passed through untouched', () => {
  const guard = createExtensionGuard()
  for (const value of [undefined, null, 'not a result', 42]) {
    assert.equal(guard.observe(value), value)
  }
  const noFields = { accept: async () => {} }
  assert.equal(guard.observe(noFields), noFields, 'a result without fields is not this seam\'s business')
})

/** Mount the runtime, the registry and the plugin, in that order. */
async function mounted() {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(ExtensionRegistry)
  const fiber = ctx.plugin(plugin)
  await fiber
  return { ctx, fiber }
}

test('through the real registry, a poisoned dsh_session_log leaves prepared repaired', async () => {
  const { ctx, fiber } = await mounted()
  try {
    ctx.deepseekLlmApiExtensions.register('dsh_session_log', {
      prepare: () => ({ value: { texts: [LONE_HIGH] }, accept: async () => {} }),
    })
    const prepared = await ctx.deepseekLlmApiExtensions.prepare(preparedRequest())
    assert.deepEqual(prepared.fields.dsh_session_log.texts, [`tail ${REPLACEMENT}`])
    assert.ok(!JSON.stringify(prepared.fields).includes('\\ud83d'), 'the adapter must not receive an unpaired surrogate')
  } finally {
    await fiber.dispose()
  }
})

test('through the real registry, a clean dsh_session_log keeps its pair', async () => {
  const { ctx, fiber } = await mounted()
  try {
    ctx.deepseekLlmApiExtensions.register('dsh_session_log', {
      prepare: () => ({ value: { texts: [PAIR] }, accept: async () => {} }),
    })
    const prepared = await ctx.deepseekLlmApiExtensions.prepare(preparedRequest())
    assert.deepEqual(prepared.fields.dsh_session_log.texts, [PAIR], 'a valid pair must survive verbatim')
    assert.ok(!JSON.stringify(prepared.fields).includes(REPLACEMENT), 'no substitute may appear in a clean field')
  } finally {
    await fiber.dispose()
  }
})

test('a registry mounted after the plugin is still covered', async () => {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  const fiber = ctx.plugin(plugin)
  await fiber
  try {
    assert.equal(ctx.get('deepseekLlmApiExtensions'), undefined, 'the seam is optional, so it must mount without one')
    await ctx.plugin(ExtensionRegistry)
    ctx.deepseekLlmApiExtensions.register('dsh_session_log', {
      prepare: () => ({ value: { texts: [LONE_HIGH] }, accept: async () => {} }),
    })
    const prepared = await ctx.deepseekLlmApiExtensions.prepare(preparedRequest())
    assert.deepEqual(prepared.fields.dsh_session_log.texts, [`tail ${REPLACEMENT}`], 'a late registry must be picked up')
  } finally {
    await fiber.dispose()
  }
})

test('disposing the plugin restores the registry\'s own prepare', async () => {
  const { ctx, fiber } = await mounted()
  ctx.deepseekLlmApiExtensions.register('dsh_session_log', {
    prepare: () => ({ value: { texts: [LONE_HIGH] }, accept: async () => {} }),
  })
  await fiber.dispose()
  const prepared = await ctx.deepseekLlmApiExtensions.prepare(preparedRequest())
  assert.deepEqual(prepared.fields.dsh_session_log.texts, [LONE_HIGH], 'after dispose the defect must reach the adapter untouched')
})

test('the guard still declares one hard requirement, and the registry is not it', () => {
  assert.deepEqual(plugin.inject, ['llm'], 'a profile without the registry must still load this plugin')
  assert.equal(plugin.name, name)
})

test('on the wire, the extension field reaches the body with U+FFFD and nothing else changes', async () => {
  const { ctx, fiber } = await mounted()
  try {
    ctx.deepseekLlmApiExtensions.register('dsh_session_log', {
      prepare: () => ({ value: { texts: [LONE_HIGH] }, accept: async () => {} }),
    })
    const captures = await transcribe(ctx, request([user('hello')]))
    assert.equal(captures.length, 1, 'one request must reach the transport')
    const { raw, body } = captures[0]
    assert.ok(!raw.includes('\\ud83d'), `an unpaired surrogate reached the wire: ${raw}`)
    assert.ok(raw.includes(REPLACEMENT), 'the substitute must be U+FFFD')
    assert.deepEqual(body.dsh_session_log.texts, [`tail ${REPLACEMENT}`])
    assert.equal(body.model, 'wire-model', 'routing fields must survive')
  } finally {
    await fiber.dispose()
  }
})

/**
 * Run one request through the real adapter, over a capturing transport, with the
 * registry read exactly the way the shipped host reads it.
 * @param ctx - context carrying the registry and the mounted guard.
 * @param options - request as it would be dispatched.
 * @returns the captured transport calls.
 */
async function transcribe(ctx, options) {
  const connection = resolveAdapterOptions({ baseURL: 'http://127.0.0.1:9', models: [{ id: 'wire-model' }] })
  const captures = []
  const original = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    captures.push({ url: String(url), headers: init.headers, raw: init.body, body: JSON.parse(init.body) })
    return new Response(SSE, { status: 200, headers: { 'content-type': 'text/event-stream' } })
  }
  const adapter = new DeepSeekAdapter({
    options: () => connection,
    resolveAuth: async () => ({ headers: { 'x-api-key': 'probe' } }),
    resolveUserId: () => 'probe-user',
    // The shipped wiring, verbatim: packages/llm/llm-deepseek/src/host.ts:52
    prepareExtensions: request => ctx.get('deepseekLlmApiExtensions')?.prepare(request),
  })
  try {
    for await (const _chunk of adapter.stream({ ...options, provider: 'deepseek', model: 'wire-model' })) { /* drain */ }
  } finally {
    globalThis.fetch = original
  }
  return captures
}
