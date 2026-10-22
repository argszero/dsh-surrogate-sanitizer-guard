/**
 * Unit suite for the surrogate guard.
 *
 * Two arms decide whether the guard is worth having, and each is asserted in
 * both directions: a request carrying a lone surrogate must be re-dispatched
 * repaired, and a request that carries none must reach `next()` as the caller's
 * own object — identity, not equality. The negative arm is the one a careless
 * predicate loses, so it is tested with a valid pair, with a well-formed
 * request carrying an abort signal, and with text that merely spells a
 * surrogate escape.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { isAgentLoopRequest, markAgentLoopRequest } from '@deepseek-ai/dsh-llm'

import plugin, {
  containsLoneSurrogate,
  createGuard,
  hasLoneSurrogate,
  inject,
  name,
  replacedRequest,
  sanitizeStrings,
} from '../lib/index.js'
import { RecordingAdapter } from './fixtures/adapter.mjs'
import { LITERAL_ESCAPE, LONE_HIGH, LONE_LOW, PAIR, REPLACEMENT, request, textOf, toolNamed, toolResult, user } from './fixtures/history.mjs'

/**
 * Drive one dispatch through a fresh guard.
 * @param options - request to dispatch.
 * @param logger - optional logger spy.
 * @returns the guard, the replacement it re-dispatched (undefined when it continued), and what `next` received.
 */
function dispatch(options, logger) {
  const guard = createGuard(logger)
  const observed = { handed: undefined, continued: undefined }
  guard.handle(
    (replacement) => {
      observed.handed = replacement
      return { kind: 'redispatch' }
    },
    options,
    () => {
      observed.continued = options
      return { kind: 'continue' }
    },
  )
  return { guard, ...observed }
}

test('the predicate answers about code units, not about text', () => {
  assert.equal(hasLoneSurrogate(LONE_HIGH), true, 'a trailing high surrogate is a defect')
  assert.equal(hasLoneSurrogate(LONE_LOW), true, 'a leading low surrogate is a defect')
  assert.equal(hasLoneSurrogate(PAIR), false, 'a valid pair is not a defect')
  assert.equal(hasLoneSurrogate(LITERAL_ESCAPE), false, 'spelling an escape is not a defect')
  assert.equal(hasLoneSurrogate(42), false, 'a non-string is never a defect')
  assert.equal(hasLoneSurrogate(undefined), false)
})

test('the walk finds a surrogate deep in the graph and stops at an opaque object', () => {
  assert.equal(containsLoneSurrogate(request([user(LONE_HIGH)])), true)
  assert.equal(containsLoneSurrogate(request([user(PAIR)])), false)
  assert.equal(containsLoneSurrogate({ tools: [{ description: LONE_LOW }] }), true, 'tool schemas are part of the request')
  assert.equal(containsLoneSurrogate({ signal: new AbortController().signal }), false, 'an abort signal is not walked')
})

test('a cyclic request neither hangs the predicate nor the rebuild', () => {
  const cyclic = { provider: 'guarded', model: 'recording', messages: [] }
  cyclic.self = cyclic
  assert.equal(containsLoneSurrogate(cyclic), false)
  const rebuilt = sanitizeStrings(cyclic)
  assert.equal(rebuilt.self, rebuilt, 'the cycle is preserved, not unrolled')
})

test('a lone high surrogate in a user turn is replaced with U+FFFD', () => {
  const { handed } = dispatch(request([user(LONE_HIGH)]))
  assert.notEqual(handed, undefined, 'the guard must re-dispatch rather than continue')
  assert.equal(textOf(handed.messages[0]), `tail ${REPLACEMENT}`)
})

test('a lone low surrogate is repaired the same way', () => {
  const { handed } = dispatch(request([user(LONE_LOW)]))
  assert.equal(textOf(handed.messages[0]), `${REPLACEMENT} head`)
})

test('a high in one string and a low in another are both repaired', () => {
  const { handed } = dispatch(request([user(LONE_HIGH), user(LONE_LOW)]))
  assert.equal(textOf(handed.messages[0]), `tail ${REPLACEMENT}`)
  assert.equal(textOf(handed.messages[1]), `${REPLACEMENT} head`)
})

test('a lone surrogate in a tool result is repaired', () => {
  const { handed } = dispatch(request([user('go'), toolResult(LONE_HIGH)]))
  assert.equal(textOf(handed.messages[1]), `tail ${REPLACEMENT}`)
})

test('a lone surrogate in a tool declaration is repaired', () => {
  const { handed } = dispatch(request([user('go')], { tools: [toolNamed(LONE_HIGH)] }))
  assert.equal(handed.tools[0].description, `tail ${REPLACEMENT}`)
})

test('a lone surrogate in the one-shot system prompt is repaired', () => {
  const { handed } = dispatch(request([user('go')], { system: LONE_LOW }))
  assert.equal(handed.system, `${REPLACEMENT} head`)
})

test('a valid surrogate pair reaches next untouched, by identity', () => {
  const options = request([user(PAIR)])
  const { handed, continued } = dispatch(options)
  assert.equal(handed, undefined, 'the guard must not re-dispatch a well-formed request')
  assert.equal(continued, options, 'the caller request itself must continue')
  assert.equal(textOf(options.messages[0]), PAIR)
})

test('a well-formed request carrying an abort signal is untouched', () => {
  const controller = new AbortController()
  const options = request([user(PAIR)], { signal: controller.signal })
  const { handed, continued } = dispatch(options)
  assert.equal(handed, undefined, 'an opaque member must not be mistaken for a defect')
  assert.equal(continued, options)
})

test('text that merely spells a surrogate escape is not a defect', () => {
  const { handed, continued } = dispatch(request([user(LITERAL_ESCAPE)]))
  assert.equal(handed, undefined, 'a well-formed request must never be rewritten')
  assert.equal(continued.messages[0].content[0].text, LITERAL_ESCAPE)
})

test('the caller request is byte-identical after a guarded dispatch', () => {
  const options = request([user(LONE_HIGH)])
  const before = JSON.stringify(options)
  const { handed } = dispatch(options)
  assert.notEqual(handed, undefined)
  assert.equal(JSON.stringify(options), before, 'durable history must not change')
  assert.equal(textOf(options.messages[0]), LONE_HIGH, 'the record keeps the producer bytes')
  assert.equal(textOf(handed.messages[0]), `tail ${REPLACEMENT}`, 'only the outgoing frame is repaired')
})

test('the replacement is frozen, as a loop request the adapter receives one', () => {
  const { handed } = dispatch(request([user(LONE_HIGH)]))
  assert.equal(Object.isFrozen(handed), true)
  assert.equal(Object.isFrozen(handed.messages), true)
  assert.equal(Object.isFrozen(handed.messages[0]), true)
  assert.equal(Object.isFrozen(handed.messages[0].content), true)
})

test('non-string fields survive the rebuild unchanged', () => {
  const options = request([user(LONE_HIGH)], { maxTokens: 4096, temperature: 0.25, stop: ['END'], sessionId: 's-1' })
  const { handed } = dispatch(options)
  assert.equal(handed.maxTokens, 4096)
  assert.equal(handed.temperature, 0.25)
  assert.deepEqual(handed.stop, ['END'])
  assert.equal(handed.sessionId, 's-1')
  assert.equal(handed.provider, 'guarded')
  assert.equal(handed.model, 'recording')
})

test('the abort signal is shared with the replacement by reference', () => {
  const controller = new AbortController()
  const { handed } = dispatch(request([user(LONE_HIGH)], { signal: controller.signal }))
  assert.equal(handed.signal, controller.signal, 'a live abort must still reach the adapter')
})

test('the agent-loop marker is re-stamped on the replacement', () => {
  const options = markAgentLoopRequest(request([user(LONE_HIGH)]))
  const { handed } = dispatch(options)
  assert.equal(isAgentLoopRequest(options), true)
  assert.equal(isAgentLoopRequest(handed), true, 'a rebuilt loop request must stay a loop request')
})

test('a hand-built request does not acquire the loop marker', () => {
  const options = request([user(LONE_HIGH)])
  const { handed } = dispatch(options)
  assert.equal(isAgentLoopRequest(options), false)
  assert.equal(isAgentLoopRequest(handed), false, 'the guard must not invent loop identity')
})

test('a failing predicate leaves the caller request in place', () => {
  const hostile = {
    provider: 'guarded',
    model: 'recording',
    get messages() {
      throw new Error('boom')
    },
  }
  const { handed, continued } = dispatch(hostile)
  assert.equal(handed, undefined, 'the guard must never decide whether a request runs')
  assert.equal(continued, hostile)
})

test('sanitizing an already repaired request changes nothing', () => {
  const once = replacedRequest(request([user(LONE_HIGH)]))
  const twice = sanitizeStrings(once)
  assert.deepEqual(twice, once)
  assert.equal(textOf(twice.messages[0]), `tail ${REPLACEMENT}`)
})

test('the guard counts what it dispatched and what it repaired', () => {
  const guard = createGuard()
  guard.handle(replacement => replacement, request([user(PAIR)]), () => 'continued')
  guard.handle(replacement => replacement, request([user(LONE_HIGH)]), () => 'continued')
  assert.deepEqual(guard.stats, { requests: 2, repaired: 1 })
})

test('the re-entrant dispatch is short-circuited, not walked again', () => {
  const guard = createGuard()
  let handed
  guard.handle((replacement) => {
    handed = replacement
    return 'redispatched'
  }, request([user(LONE_HIGH)]), () => 'continued')
  assert.deepEqual(guard.stats, { requests: 1, repaired: 1 })
  guard.handle(() => 'nested', handed, () => 'continued')
  assert.deepEqual(guard.stats, { requests: 1, repaired: 1 }, 'the guard must not run its own pass twice')
})

test('a repair warns once per route and a clean request never warns', () => {
  const warnings = []
  const guard = createGuard({ warn: message => warnings.push(message) })
  guard.handle(replacement => replacement, request([user(PAIR)]), () => 'continued')
  assert.deepEqual(warnings, [], 'a request that needs nothing must stay silent')
  guard.handle(replacement => replacement, request([user(LONE_HIGH)]), () => 'continued')
  guard.handle(replacement => replacement, request([user(LONE_HIGH)]), () => 'continued')
  assert.equal(warnings.length, 1, 'one warning per route, not per request')
  guard.handle(replacement => replacement, { ...request([user(LONE_HIGH)]), model: 'other' }, () => 'continued')
  assert.equal(warnings.length, 2, 'a second route gets its own warning')
})

test('a guard without a logger still repairs', () => {
  const { handed } = dispatch(request([user(LONE_HIGH)]), undefined)
  assert.equal(textOf(handed.messages[0]), `tail ${REPLACEMENT}`)
})

test('the plugin declares a hard llm requirement and a default export', () => {
  assert.deepEqual(inject, ['llm'], 'an absent runtime must leave the plugin pending')
  assert.equal(name, '@argszero/dsh-surrogate-sanitizer-guard')
  assert.equal(plugin.name, name)
  assert.deepEqual(plugin.inject, ['llm'])
  assert.equal(typeof plugin.apply, 'function')
})

/**
 * Mount the plugin on a real cordis runtime over a recording adapter.
 * @returns the context, the adapter, the requests other listeners observed, and the plugin fiber.
 */
async function mounted() {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  const adapter = new RecordingAdapter()
  ctx.llm.registerAdapter(['guarded'], adapter)
  const observed = []
  ctx.on('llm/stream', (options, next) => {
    observed.push(options)
    return next()
  })
  const fiber = ctx.plugin(plugin)
  await fiber
  return { ctx, adapter, observed, fiber }
}

/** Run one request to completion through the mounted runtime. */
async function drain(ctx, options) {
  const chunks = []
  for await (const chunk of ctx.llm.stream(options)) chunks.push(chunk)
  return chunks
}

test('on the runtime, exactly one repaired request reaches the adapter', async () => {
  const { ctx, adapter, observed, fiber } = await mounted()
  try {
    await drain(ctx, request([user(LONE_HIGH)]))
    assert.equal(adapter.requests.length, 1, 'the re-entrant dispatch must not double-dispatch')
    assert.equal(observed.length, 1, 'the guarded chain runs once, not twice')
    assert.equal(observed[0], adapter.requests[0])
    assert.equal(textOf(adapter.requests[0].messages[0]), `tail ${REPLACEMENT}`)
  } finally {
    await fiber.dispose()
  }
})

test('disposing the plugin restores the raw request', async () => {
  const { ctx, adapter, fiber } = await mounted()
  await drain(ctx, request([user(LONE_HIGH)]))
  await fiber.dispose()
  const raw = request([user(LONE_HIGH)])
  await drain(ctx, raw)
  const last = adapter.requests.at(-1)
  assert.equal(last, raw, 'after dispose the caller request reaches the adapter unchanged')
  assert.equal(textOf(last.messages[0]), LONE_HIGH)
})
