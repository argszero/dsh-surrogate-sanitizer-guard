/**
 * Repair lone UTF-16 surrogates on the outgoing model request.
 *
 * A model-authored tool call can produce a string cut through a surrogate pair
 * — `JSON.stringify` in generated code, `.slice(0, 120)` applied to a label, a
 * byte-bounded truncation. That string enters the durable session record, and
 * because the record is replayed into every later request, one bad cut makes
 * every turn carry it. The Messages API rejects such a body, so the session
 * fails permanently: the producer is in the history, and the history never
 * changes.
 *
 * This plugin repairs the outgoing frame. Before a request is dispatched it
 * looks for a string carrying a lone surrogate; only if it finds one does it
 * rebuild the request with `String.prototype.toWellFormed()` applied to every
 * string, which substitutes U+FFFD for each unpaired code unit, and re-dispatch
 * that instead. Durable history is untouched: the report, the session log and
 * the projection all keep the bytes the producer wrote, so a later core fix
 * still sees the real defect.
 *
 * The guard is provider-agnostic. A lone surrogate is not a DeepSeek-specific
 * defect — it is invalid in any JSON API surface — and the predicate is exact,
 * so a request that needs nothing keeps its identity all the way to the
 * adapter.
 *
 * ## Two halves, two seams
 *
 * The outgoing body has two authors, and only one of them goes through
 * `llm/stream`. The model request is dispatched there, but the top-level
 * extension fields are not part of it: they are contributed later by
 * `ctx.deepseekLlmApiExtensions`, one provider per field, and merged into the
 * serialized body by the adapter. `dsh_session_log` — the session's own
 * durable log, replayed on every request — is one such field.
 *
 * A repair that watched `llm/stream` alone therefore reached only half the
 * body. Measured against the real adapter, a lone surrogate in
 * `dsh_session_log` leaves the serializer emitting a *complete, valid*
 * `\ud83c` escape — the payload parses — and is rejected by the provider on the
 * value, which is why the reported 400 names `texts[0]` and words the failure
 * as a truncated escape. The defect is in the value, so the repair belongs at
 * the value: this plugin also shadows `deepseekLlmApiExtensions.prepare`, walks
 * the `fields` record it returns, and repairs those strings. The frozen record
 * is rebuilt rather than mutated, and the acceptance transaction is carried
 * through untouched.
 *
 * @module dsh-surrogate-sanitizer-guard
 */

import { isAgentLoopRequest, markAgentLoopRequest } from '@deepseek-ai/dsh-llm'

/** Plugin name reported by the loader. */
export const name = '@argszero/dsh-surrogate-sanitizer-guard'

/**
 * Hard requirement: the seam is dispatched on the LLM runtime, so an absent
 * instance must leave this plugin pending rather than loaded and inert.
 */
export const inject = ['llm']

/**
 * Test one string for an unpaired UTF-16 surrogate.
 * `isWellFormed` is the engine's own scan: it allocates nothing and answers
 * the exact question, so it is the predicate rather than a proxy for it.
 * @param text - candidate string; non-strings are never a defect here.
 * @returns whether the string carries at least one lone surrogate.
 */
export function hasLoneSurrogate(text) {
  return typeof text === 'string' && !text.isWellFormed()
}

/**
 * Test whether a value is a plain data record the guard may rebuild.
 * Anything else — an AbortSignal, a Date, a class instance — is opaque: it
 * travels by reference and is never walked.
 * @param value - candidate value.
 * @returns whether the value is a plain object or a null-prototype object.
 */
export function isPlainRecord(value) {
  if (value === null || typeof value !== 'object') return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

/**
 * Report whether any string reachable from `root` carries a lone surrogate.
 *
 * Two cheaper-looking predicates are wrong, and both were measured:
 *   - `JSON.stringify(root).isWellFormed()` is always true. `JSON.stringify`
 *     escapes a lone surrogate into the well-formed text `\ud83d`, so the
 *     serialized form is structurally unable to witness the defect.
 *   - scanning the serialized text for surrogate escapes invents defects. A
 *     message that literally *contains* the six characters `\ud83d` — a quoted
 *     stack trace, a `run_code` snippet, this plugin's own README — is
 *     perfectly well formed, and such content is ordinary in a coding agent's
 *     history.
 *
 * Walking the graph keeps both failures out: it answers about the strings the
 * adapter will serialize, not about a representation of them.
 * @param root - any value; the request envelope in ordinary use.
 * @returns whether a lone surrogate is reachable from `root`.
 */
export function containsLoneSurrogate(root) {
  const visited = new Set()
  const walk = (value) => {
    if (typeof value === 'string') return !value.isWellFormed()
    if (value === null || typeof value !== 'object') return false
    if (visited.has(value)) return false
    visited.add(value)
    if (Array.isArray(value)) {
      for (const item of value) {
        if (walk(item)) return true
      }
      return false
    }
    if (!isPlainRecord(value)) return false
    for (const key of Object.keys(value)) {
      if (walk(value[key])) return true
    }
    return false
  }
  return walk(root)
}

/**
 * Substitute U+FFFD for every lone surrogate in one string.
 * A well-formed string is returned as the same object, so a rebuild that has
 * nothing to repair cannot churn identity.
 * @param text - candidate string.
 * @returns the repaired string.
 */
function wellFormed(text) {
  return text.isWellFormed() ? text : text.toWellFormed()
}

/**
 * Rebuild `root` with every reachable string made well formed.
 * Containers are rebuilt rather than mutated because a loop-built request
 * arrives deep-frozen; the rebuilt graph is frozen in turn so the request the
 * adapter observes keeps the contract it expects.
 * @param root - any value; the request envelope in ordinary use.
 * @returns the rebuilt value, sharing every opaque member by reference.
 */
export function sanitizeStrings(root) {
  const seen = new Map()
  const rebuild = (value) => {
    if (typeof value === 'string') return wellFormed(value)
    if (value === null || typeof value !== 'object') return value
    if (seen.has(value)) return seen.get(value)
    if (Array.isArray(value)) {
      const items = []
      seen.set(value, items)
      for (const item of value) items.push(rebuild(item))
      return Object.freeze(items)
    }
    if (!isPlainRecord(value)) return value
    const fields = {}
    seen.set(value, fields)
    for (const key of Object.keys(value)) fields[key] = rebuild(value[key])
    return Object.freeze(fields)
  }
  return rebuild(root)
}

/**
 * Build the replacement request envelope.
 * The agent-loop marker is a module-level set of exact request objects, not a
 * property on them, so a rebuilt envelope does not inherit it: it is stamped
 * again here, which is what keeps downstream loop-aware listeners behaving the
 * same across the re-dispatch.
 * @param options - the original request.
 * @returns a frozen, well-formed replacement.
 */
export function replacedRequest(options) {
  const replacement = sanitizeStrings(options)
  if (isAgentLoopRequest(options)) markAgentLoopRequest(replacement)
  return replacement
}

/**
 * Create the guard used by one plugin instance.
 * @param logger - optional cordis logger; warned once per repaired route.
 * @returns the handler, plus the counters a test or an operator can read.
 */
export function createGuard(logger) {
  const dispatched = new WeakSet()
  const reported = new Set()
  const stats = { requests: 0, repaired: 0 }

  /**
   * Handle one `llm/stream` dispatch.
   * @param stream - the runtime's public stream entry point, used to re-dispatch.
   * @param options - request as assembled by the caller.
   * @param next - continuation bound to the original request; it cannot carry a
   *   replacement, which is why a repaired request is re-dispatched instead.
   * @returns the chunk stream for the request that actually goes out.
   */
  function handle(stream, options, next) {
    if (dispatched.has(options)) return next()
    stats.requests += 1
    try {
      if (!containsLoneSurrogate(options)) return next()
      const replacement = replacedRequest(options)
      dispatched.add(replacement)
      stats.repaired += 1
      warnOnce(options)
      return stream(replacement)
    } catch (_sanitizerFailed) {
      // The guard must never decide whether a request runs: any failure here
      // leaves the assembled request exactly as the caller built it.
      return next()
    }
  }

  function warnOnce(options) {
    if (typeof logger?.warn !== 'function') return
    const key = `${String(options.provider)}\u0000${String(options.model)}`
    if (reported.has(key)) return
    reported.add(key)
    logger.warn(
      `${name}: provider "${String(options.provider)}" model "${String(options.model)}" sent a request carrying `
      + 'a lone UTF-16 surrogate; replaced it with U+FFFD on the outgoing frame. Durable history is unchanged.',
    )
  }

  return { handle, stats }
}

/** Handle behind a Cordis service view; the view itself is rebuilt on every read. */
export const ORIGINAL = Symbol.for('cordis.original')

/**
 * Rebuild the extension-field record with every lone surrogate repaired.
 *
 * The registry hands out a frozen `Object.create(null)` record, so it is
 * rebuilt rather than mutated — and rebuilt with the same null prototype, since
 * that record is spread into the request body and a prototype it never had is
 * not this plugin's to add. A field whose value is already well formed is
 * carried by reference, so a single bad field does not churn the rest.
 * @param fields - the prepared fields record, as the registry returned it.
 * @returns a frozen null-prototype record with the same keys.
 */
export function repairedFields(fields) {
  const rebuilt = Object.create(null)
  for (const key of Object.keys(fields)) {
    const value = fields[key]
    rebuilt[key] = containsLoneSurrogate(value) ? sanitizeStrings(value) : value
  }
  return Object.freeze(rebuilt)
}

/**
 * Create the extension-field guard used by one plugin instance.
 * @param logger - optional cordis logger; warned once per set of repaired fields.
 * @returns the observer, plus the counters a test or an operator can read.
 */
export function createExtensionGuard(logger) {
  const reported = new Set()
  const stats = { prepared: 0, repaired: 0 }

  /**
   * Observe one prepared extension result.
   *
   * A clean result is returned as the caller's own object, identity and all: a
   * request that carries no defect must be indistinguishable from one the guard
   * never saw. Only a defect triggers a rebuild, and the acceptance transaction
   * (`accept`) is carried through by reference — it is the one part of the
   * result this plugin has no business changing, and dropping it would leave the
   * delivery watermark uncommitted on a request that otherwise succeeded.
   * @param result - what the registry's own `prepare` returned.
   * @returns the result to hand the adapter.
   */
  function observe(result) {
    stats.prepared += 1
    if (result === null || typeof result !== 'object') return result
    const fields = result.fields
    if (fields === null || typeof fields !== 'object') return result
    const affected = Object.keys(fields).filter(key => containsLoneSurrogate(fields[key]))
    if (affected.length === 0) return result
    stats.repaired += 1
    warnOnce(affected)
    return { fields: repairedFields(fields), accept: result.accept }
  }

  function warnOnce(affected) {
    if (typeof logger?.warn !== 'function') return
    const key = affected.join('\u0000')
    if (reported.has(key)) return
    reported.add(key)
    logger.warn(
      `${name}: request extension field${affected.length === 1 ? '' : 's'} `
      + `${affected.map(field => JSON.stringify(field)).join(', ')} carried a lone UTF-16 surrogate; `
      + 'replaced it with U+FFFD on the outgoing frame. Durable history is unchanged.',
    )
  }

  return { observe, stats }
}

/**
 * Shadow `prepare` on one registry instance.
 * The write goes on the instance, not on a service view: `ctx.get()` answers
 * with a fresh view on every read, so a shadow installed there is gone by the
 * next call. The saved property is restored on release, including the "there was
 * no own property" case, which must go back to the prototype method rather than
 * to a copy of it.
 * @param registry - the registry instance behind the service view.
 * @param guard - the observer built by createExtensionGuard.
 * @returns the disposer that puts the original method back.
 */
export function shadowPrepare(registry, guard) {
  const own = Object.hasOwn(registry, 'prepare')
  const original = registry.prepare
  registry.prepare = async function guardedPrepare(request) {
    return guard.observe(await original.call(registry, request))
  }
  return () => {
    if (own) registry.prepare = original
    else delete registry.prepare
  }
}

/**
 * Attach the extension-field guard to the registry, now or when it appears.
 *
 * The registry is optional. `llm-deepseek` reads it with `ctx.get(...)?.prepare`
 * and a profile may not mount it at all, so requiring it here would leave this
 * plugin pending — and a guard that refuses to load on the profiles that need it
 * least is worse than one that watches a second seam only where that seam
 * exists.
 * @param ctx - plugin context.
 * @param logger - optional cordis logger.
 * @returns the observer, so a test or an operator can read its counters.
 */
export function mountExtensionGuard(ctx, logger) {
  const guard = createExtensionGuard(logger)
  ctx.inject(['deepseekLlmApiExtensions'], (inner) => {
    const service = inner.get('deepseekLlmApiExtensions')
    const registry = service?.[ORIGINAL] ?? service
    if (typeof registry?.prepare !== 'function') return
    return shadowPrepare(registry, guard)
  })
  return guard
}

/**
 * Mount the guard on one context.
 * Prepended: the guard must see the request before any other listener wraps or
 * routes it, and the re-dispatch then passes through that whole chain once.
 * @param ctx - plugin context providing the `llm` service.
 */
export function apply(ctx) {
  const guard = createGuard(ctx.logger)
  ctx.on('llm/stream', (options, next) => guard.handle(request => ctx.llm.stream(request), options, next), { prepend: true })
  mountExtensionGuard(ctx, ctx.logger)
}

export default { name, inject, apply }
