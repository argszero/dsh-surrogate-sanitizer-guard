/**
 * The second repair: a tool `pattern` that names a surrogate code point.
 *
 * The reported defect is spelled entirely in ASCII — `^[^\uD800-\uDFFF]*$` is
 * well formed text that *names* the range — so the `isWellFormed()` walk that
 * catches lone surrogates is blind to it by construction. These arms pin the
 * second predicate on its own terms: what it recognises, what it must leave
 * alone, and what a request with one such schema does at the seam.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  containsSurrogatePattern,
  createGuard,
  deepSeekSafeParameters,
  namesSurrogateEscape,
  repairedTools,
  surrogatePatternTools,
} from '../lib/index.js'
import { request, toolNamed, user } from './fixtures/history.mjs'

/** The pattern REA 6.9.0 ships on 14 tools, and the one the report quotes. */
const REPORTED = String.raw`^[^\uD800-\uDFFF]*$`

/** A schema carrying `pattern` at a nested property, as a real tool declares it. */
const nested = (pattern) => ({
  type: 'object',
  properties: {
    name: { type: 'string', pattern },
    other: { type: 'string', pattern: '^[a-z]+$' },
  },
  required: ['name'],
})

/** One tool declaration whose schema carries `pattern`. */
const toolWith = (pattern, name = 'mcp__rea__binary_session') => ({
  name,
  description: 'reported by the server',
  parameters: nested(pattern),
})

/** Dispatch one request through a fresh guard, handing back what it replaced. */
function dispatch(options) {
  let handed
  const guard = createGuard()
  guard.handle(
    (replacement) => {
      handed = replacement
      return replacement
    },
    options,
    () => options,
  )
  return { handed, stats: guard.stats }
}

test('the reported pattern is recognised even though its text is well formed', () => {
  assert.equal(REPORTED.isWellFormed(), true, 'the ASCII spelling carries no surrogate code unit')
  assert.equal(namesSurrogateEscape(REPORTED), true, 'and the pattern predicate must still see it')
})

test('every spelling of a surrogate range is recognised', () => {
  for (const pattern of [
    String.raw`^\uD800$`,
    String.raw`^[\uD800-\uDFFF]*$`,
    String.raw`^\u{0D800}$`,
    String.raw`^\x{D800}$`,
    String.raw`^\uDFFF+$`,
  ]) {
    assert.equal(namesSurrogateEscape(pattern), true, `${pattern} names a surrogate code point`)
  }
})

test('an escape that is itself escaped is content, not a surrogate range', () => {
  // `\\uD800` is an escaped backslash followed by the text `uD800`: a constraint
  // on literal content that the API compiles happily, so it must survive.
  assert.equal(namesSurrogateEscape(String.raw`^\\uD800$`), false)
  assert.equal(namesSurrogateEscape(String.raw`^\\\\uD800$`), false)
})

test('an ordinary pattern and a non-string are not defects', () => {
  for (const pattern of ['^[a-z]+$', String.raw`^\d{4}-\d{2}$`, String.raw`^\u00e9$`, String.raw`^\u{1F600}$`]) {
    assert.equal(namesSurrogateEscape(pattern), false, `${pattern} names no surrogate code point`)
  }
  assert.equal(namesSurrogateEscape(undefined), false)
  assert.equal(namesSurrogateEscape(null), false)
  assert.equal(namesSurrogateEscape(42), false)
})

test('the reported pattern is dropped from a nested schema', () => {
  const repaired = deepSeekSafeParameters(nested(REPORTED))
  assert.equal(repaired.properties.name.pattern, undefined, 'the reported keyword is gone')
  assert.equal(repaired.properties.other.pattern, '^[a-z]+$', 'an ordinary sibling pattern survives verbatim')
  assert.equal(repaired.type, 'object')
  assert.deepEqual(repaired.required, ['name'], 'array members survive by value')
})

test('an unrelated pattern keeps the object, an affected one does not', () => {
  const clean = nested('^[a-z]+$')
  assert.equal(deepSeekSafeParameters(clean), clean, 'a clean schema keeps its identity')
  const dirty = nested(REPORTED)
  assert.notEqual(deepSeekSafeParameters(dirty), dirty, 'a repaired schema is a different object')
  assert.equal(dirty.properties.name.pattern, REPORTED, 'and the caller schema is not mutated')
})

test('instance data is not walked: a pattern inside default or enum is content', () => {
  const schema = {
    type: 'object',
    properties: {
      mode: { type: 'string', default: { pattern: REPORTED } },
      keys: { enum: [{ pattern: REPORTED }] },
    },
  }
  assert.equal(deepSeekSafeParameters(schema), schema, 'instance data is carried untouched')
})

test('a repaired schema is frozen, as a declared tool schema the adapter receives one', () => {
  const repaired = deepSeekSafeParameters(nested(REPORTED))
  assert.equal(Object.isFrozen(repaired), true)
  assert.equal(Object.isFrozen(repaired.properties), true)
  assert.equal(Object.isFrozen(repaired.properties.name), true)
})

test('the same source schema is repaired once, so repeated requests send identical bytes', () => {
  const schema = nested(REPORTED)
  const first = deepSeekSafeParameters(schema)
  assert.equal(deepSeekSafeParameters(schema), first, 'the second request reuses the same object')
  assert.equal(JSON.stringify(first), JSON.stringify(deepSeekSafeParameters(schema)))
})

test('non-object parameters are carried through unchanged', () => {
  assert.equal(deepSeekSafeParameters(undefined), undefined)
  assert.equal(deepSeekSafeParameters(null), null)
})

test('a tool list with no affected schema keeps the caller array by identity', () => {
  const tools = [toolNamed('plain'), toolWith('^[a-z]+$')]
  assert.equal(repairedTools(tools), tools)
  assert.equal(containsSurrogatePattern(tools), false)
  assert.deepEqual(surrogatePatternTools(tools), [])
})

test('a repaired tool keeps its declaration and only its parameters change', () => {
  const tools = [
    { name: 'mcp__rea__binary_session', description: 'kept', parameters: nested(REPORTED), deferLoading: true },
    toolNamed('untouched'),
  ]
  const repaired = repairedTools(tools)
  assert.notEqual(repaired, tools)
  assert.equal(Object.isFrozen(repaired), true)
  assert.equal(repaired[0].name, 'mcp__rea__binary_session')
  assert.equal(repaired[0].description, 'kept')
  assert.equal(repaired[0].deferLoading, true, 'the deferred-loading flag survives the rebuild')
  assert.equal(repaired[0].parameters.properties.name.pattern, undefined)
  assert.equal(repaired[1], tools[1], 'an unaffected tool is carried by reference')
  assert.deepEqual(surrogatePatternTools(tools), ['mcp__rea__binary_session'])
})

test('a non-array tool list is not a tool list', () => {
  assert.equal(containsSurrogatePattern(undefined), false)
  assert.equal(containsSurrogatePattern('tools'), false)
  assert.equal(repairedTools(undefined), undefined)
  assert.deepEqual(surrogatePatternTools(undefined), [])
})

test('the guard re-dispatches a request whose only defect is a tool pattern', () => {
  const options = request([user('list the binary')], { tools: [toolWith(REPORTED)] })
  const { handed, stats } = dispatch(options)
  assert.notEqual(handed, undefined, 'the guard must hand over a replacement')
  assert.notEqual(handed, options)
  assert.equal(handed.tools[0].parameters.properties.name.pattern, undefined)
  assert.equal(stats.repaired, 1)
  assert.equal(options.tools[0].parameters.properties.name.pattern, REPORTED, 'the caller request is untouched')
})

test('a request whose tool schemas are clean goes to next untouched', () => {
  const options = request([user('list the binary')], { tools: [toolWith('^[a-z]+$')] })
  const { handed, stats } = dispatch(options)
  assert.equal(handed, undefined, 'no replacement for a clean tool list')
  assert.equal(stats.repaired, 0)
})

test('a request with no tool list is unaffected by the second predicate', () => {
  const options = request([user('hello')])
  assert.equal(dispatch(options).handed, undefined)
})
