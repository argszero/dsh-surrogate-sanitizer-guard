/**
 * Line-level evidence: what the published DeepSeek Messages serializer actually
 * puts on the wire, before and after the guard.
 *
 * The unit suite reads request objects. This file takes the second, independent
 * reading the artifact needs: it drives the real upstream adapter
 * (`@deepseek-ai/dsh-llm-deepseek@0.2.1-rc.2`) with a capturing `fetch` and
 * asserts on the HTTP body the adapter builds.
 *
 * The discriminator is one field: `messages[0].content[0].text`. Unguarded it
 * leaves as the escaped lone surrogate `\ud83d` — the frame the reported
 * session sends and the endpoint rejects. Guarded it carries U+FFFD instead,
 * and every other byte of the body is identical. The control proves the guard
 * is inert on a well-formed request, and the last test proves the durable
 * record is untouched: the guard repairs the frame, not the history.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { DeepSeekAdapter, resolveAdapterOptions } from '@deepseek-ai/dsh-llm-deepseek'

import { createGuard } from '../lib/index.js'
import { LONE_HIGH, PAIR, REPLACEMENT, request, textOf, user } from './fixtures/history.mjs'

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

const connection = resolveAdapterOptions({ baseURL: 'http://127.0.0.1:9', models: [{ id: 'wire-model' }] })

/**
 * Run one request through the real adapter over a capturing transport.
 * @param options - request as it would be dispatched.
 * @returns the raw body string, the parsed body, and the headers actually sent.
 */
async function transcribe(options) {
  const captures = []
  const original = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    captures.push({ url: String(url), headers: init.headers, raw: init.body })
    return new Response(SSE, { status: 200, headers: { 'content-type': 'text/event-stream' } })
  }
  const adapter = new DeepSeekAdapter({
    options: () => connection,
    resolveAuth: async () => ({ headers: { 'x-api-key': 'probe' } }),
    resolveUserId: () => 'probe-user',
    prepareExtensions: async () => ({ fields: {}, accept: async () => {} }),
  })
  try {
    for await (const _chunk of adapter.stream({ ...options, provider: 'deepseek', model: 'wire-model' })) { /* drain */ }
  } finally {
    globalThis.fetch = original
  }
  assert.equal(captures.length, 1, 'one request must reach the transport')
  const sent = captures[0]
  return { raw: sent.raw, body: JSON.parse(sent.raw), headers: sent.headers, url: sent.url }
}

/**
 * Run one request through the guard and return the replacement it would dispatch.
 * @param options - request as assembled by the caller.
 * @returns the replacement request, or undefined when the guard continued.
 */
function guarded(options) {
  let handed
  createGuard().handle(
    (replacement) => {
      handed = replacement
      return replacement
    },
    options,
    () => options,
  )
  return handed
}

test('the unguarded request really does reach the wire carrying a lone surrogate', async () => {
  const sent = await transcribe(request([user(LONE_HIGH)]))
  assert.ok(sent.raw.includes('\\ud83d'), 'the unguarded body must carry the escaped lone surrogate')
  assert.equal(sent.body.messages[0].content[0].text, LONE_HIGH, 'and the same field carries it after parsing')
})

test('the guarded request reaches the wire with U+FFFD at that same field', async () => {
  const replacement = guarded(request([user(LONE_HIGH)]))
  assert.notEqual(replacement, undefined, 'the guard must hand over a replacement')
  const sent = await transcribe(replacement)
  assert.ok(!sent.raw.includes('\\ud83d'), `a lone surrogate survived on the wire: ${sent.raw}`)
  assert.ok(sent.raw.includes(REPLACEMENT), 'the substitute must be U+FFFD')
  assert.equal(sent.body.messages[0].content[0].text, `tail ${REPLACEMENT}`)
  assert.equal(sent.body.model, 'wire-model', 'routing fields must survive')
  assert.equal(sent.body.stream, true)
})

test('nothing else in the frame changes: the two bodies differ only in that field', async () => {
  const plain = await transcribe(request([user(LONE_HIGH)]))
  const repaired = await transcribe(guarded(request([user(LONE_HIGH)])))
  assert.deepEqual(repaired.body, {
    ...plain.body,
    messages: [{ ...plain.body.messages[0], content: [{ ...plain.body.messages[0].content[0], text: `tail ${REPLACEMENT}` }] }],
  }, 'only the repaired field may differ')
  assert.equal(repaired.headers['x-api-key'], 'probe', 'credentials must still be sent')
  assert.equal(repaired.headers['anthropic-version'], plain.headers['anthropic-version'])
})

test('a well-formed request is dispatched untouched and reaches the wire with its pair intact', async () => {
  const options = request([user(PAIR)])
  assert.equal(guarded(options), undefined, 'the guard must not re-dispatch a well-formed request')
  const sent = await transcribe(options)
  assert.ok(sent.raw.includes(PAIR), 'the valid pair must survive verbatim')
  assert.ok(!sent.raw.includes(REPLACEMENT), 'no substitute may appear in a well-formed frame')
  assert.equal(sent.body.messages[0].content[0].text, PAIR)
})

test('the durable record is byte-identical after the guarded frame goes out', async () => {
  const options = request([user(LONE_HIGH)])
  const before = JSON.stringify(options)
  const replacement = guarded(options)
  await transcribe(replacement)
  assert.equal(JSON.stringify(options), before, 'the session record the loop holds must not change')
  assert.equal(textOf(options.messages[0]), LONE_HIGH, 'the producer bytes survive for the core fix to see')
})
