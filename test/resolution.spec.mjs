/**
 * Where the borrowed module comes from, and what happens when it comes from
 * nowhere.
 *
 * 0.2.0 imported `@deepseek-ai/dsh-llm` at module scope and could not load in a
 * profile at all — a defect no unit arm caught, because every arm here ran in a
 * tree where that import resolves. The arms below are the ones that decide it,
 * and each is measured in a child process, because the shapes that answer the
 * question are process-level: the working directory, `process.argv[1]`, and
 * whether the borrowed package is on the stack.
 *
 * The marker pair is not a value this plugin can copy. `isAgentLoopRequest` and
 * `markAgentLoopRequest` are two views of one module-scope `WeakSet`, so the
 * decisive reading is not "a module resolved" but "it is the caller's own
 * module" — compared by identity, here, against the very namespace this suite
 * imports.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import * as llm from '@deepseek-ai/dsh-llm'

import { resolveLoopMarker } from '../lib/index.js'
import { hostModules, resolutionCounts, resolutionReport } from '../lib/host.js'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * A directory under the OS temp root, namespaced to this suite.
 * @param tag - a short label for the shape.
 * @returns the path.
 */
function scratch(tag) {
  return mkdtempSync(join(tmpdir(), `ssg-resolution-${tag}-`))
}

/**
 * A copy of the shipped `lib/`, in a directory whose parents hold no
 * `node_modules` — the layout a profile gives a plugin, and the one shape where
 * every anchor fails.
 * @param tag - a short label for the shape.
 * @returns the scratch root and the plugin's entry inside it.
 */
function packedCopy(tag) {
  const root = scratch(tag)
  cpSync(join(ROOT, 'lib'), join(root, 'plugin', 'lib'), { recursive: true })
  writeFileSync(
    join(root, 'plugin', 'package.json'),
    JSON.stringify({ name: '@argszero/dsh-surrogate-sanitizer-guard', version: '0.0.0', type: 'module', main: 'lib/index.js' }),
  )
  return { root, entry: join(root, 'plugin', 'lib', 'index.js') }
}

/**
 * Run one probe script in a child process and return what it printed.
 * @param script - the probe's source.
 * @param options - the scratch root and the child's working directory.
 * @returns the parsed JSON the probe printed.
 */
function probe(script, options = {}) {
  const root = options.root ?? scratch('probe')
  const path = join(root, 'probe.mjs')
  writeFileSync(path, script)
  const stdout = execFileSync(process.execPath, [path], {
    cwd: options.cwd ?? root,
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1' },
  })
  const line = stdout.trim().split('\n').filter(Boolean).at(-1)
  return JSON.parse(line)
}

test('the shipped sources import no harness package at module scope', () => {
  // The 0.2.0 defect, as an assertion. A module-scope peer import is fatal in a
  // profile and no runtime arm can see it from inside a tree where it resolves,
  // so the source is read as text — which is the only vantage point that does
  // not depend on this checkout's own node_modules.
  for (const file of ['index.js', 'host.js']) {
    const source = readFileSync(join(ROOT, 'lib', file), 'utf8')
    const specifiers = [...source.matchAll(/^\s*(?:import|export)\s[^\n]*?from\s+['"]([^'"]+)['"]/gm)].map(match => match[1])
    const bare = specifiers.filter(specifier => !specifier.startsWith('node:') && !specifier.startsWith('.'))
    assert.deepEqual(bare, [], `${file} must import only node: builtins and its own files, found ${JSON.stringify(bare)}`)
    // A dynamic import is the same hazard one level in: it still names a package
    // the profile does not install.
    assert.equal(/import\s*\(\s*['"]@deepseek-ai/.test(source), false, `${file} must not dynamically import a harness package`)
  }
})

test('in the plugin\u2019s own suite the marker resolves to the very module this file imported', () => {
  // The development tree is the `fallback` shape, and that is legitimate here:
  // the harness packages are devDependencies. What must hold regardless is that
  // the instance the plugin stamps through is the instance this suite reads
  // through — a second copy would answer `false` forever, silently.
  const modules = hostModules()
  assert.equal(modules.llm.isAgentLoopRequest, llm.isAgentLoopRequest, 'the predicate must be the caller\u2019s own function')
  assert.equal(modules.llm.markAgentLoopRequest, llm.markAgentLoopRequest, 'and so must the marker')
  assert.equal(typeof modules.llm.version, 'string')
  assert.equal(resolveLoopMarker(), true, 'a repaired-envelope marker is available here')
})

test('a request the loop marked is recognised through the resolved pair, by identity', () => {
  // The decisive round trip: mark an object with this suite's import, ask the
  // plugin's resolved predicate about that exact object.
  const request = { provider: 'guarded', model: 'recording', messages: [] }
  llm.markAgentLoopRequest(request)
  const modules = hostModules()
  assert.equal(modules.llm.isAgentLoopRequest(request), true, 'the marker is one WeakSet, not two')
  const other = { provider: 'guarded', model: 'recording', messages: [] }
  assert.equal(modules.llm.isAgentLoopRequest(other), false, 'and it still answers about the exact object')
})

test('a host frame is recognised as the host, and reaches the host\u2019s own instance', () => {
  // The shape the plugin actually runs in: the host calls in, so a frame inside
  // `node_modules/@deepseek-ai/dsh-llm` is on the stack, and resolution from it
  // returns the module record the host already loaded.
  //
  // The layout is built rather than borrowed from this checkout, because this
  // checkout's own directory *is* the plugin: a frame under it is this package's
  // code or its devDependencies, which is precisely what the resolver must not
  // mistake for the host. So the host tree is a copy, and the probe lives inside
  // it — the same relationship a real install has.
  const root = scratch('host-frame')
  const hostModulesDir = join(root, 'host', 'node_modules')
  mkdirSync(hostModulesDir, { recursive: true })
  cpSync(join(ROOT, 'node_modules', '@deepseek-ai'), join(hostModulesDir, '@deepseek-ai'), { recursive: true })
  cpSync(join(ROOT, 'lib'), join(root, 'plugin', 'lib'), { recursive: true })
  const entry = join(root, 'plugin', 'lib', 'index.js')
  const marker = join(hostModulesDir, '@deepseek-ai', 'dsh-llm', '__emrg-resolution-probe.mjs')
  writeFileSync(marker, `
    import { createRequire } from 'node:module'
    import { hostModules, resolutionReport } from ${JSON.stringify(join(root, 'plugin', 'lib', 'host.js'))}
    const require = createRequire(import.meta.url)
    // Resolved from this frame, which sits inside the borrowed package itself:
    // this is the namespace the host would get.
    const own = require('@deepseek-ai/dsh-llm')
    const modules = hostModules()
    const probe = { provider: 'guarded', model: 'recording', messages: [] }
    own.markAgentLoopRequest(probe)
    console.log(JSON.stringify({
      report: resolutionReport(),
      samePredicate: modules.llm.isAgentLoopRequest === own.isAgentLoopRequest,
      sameListed: modules.llm.isAgentLoopRequest(probe),
      anchor: modules.anchor,
    }))
  `)
  try {
    const stdout = execFileSync(process.execPath, [marker], { encoding: 'utf8', cwd: root })
    const result = JSON.parse(stdout.trim().split('\n').filter(Boolean).at(-1))
    assert.equal(result.report.reached, true)
    assert.equal(result.report.kind, 'host-frame', `expected a host frame, got ${result.report.kind}`)
    assert.ok(result.anchor.includes(join('node_modules', '@deepseek-ai', 'dsh-llm')), `unexpected anchor ${result.anchor}`)
    // The two readings that matter: the same function object, and the same
    // WeakSet contents seen from both sides of the boundary.
    assert.equal(result.samePredicate, true, 'the predicate must be the caller\u2019s own function')
    assert.equal(result.sameListed, true, 'a request the caller marked must be visible to the plugin')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a second copy resolves just as happily \u2014 and is disclosed as `fallback`, not as the host', () => {
  // The disagreeing control. If resolution success were taken as proof of the
  // host instance, this arm would be indistinguishable from the one above: the
  // same call succeeds, returns a namespace, and describes a package by the same
  // name. Only the evidence field separates them — and here the decoy's marker
  // is a *different* WeakSet, which is exactly the silent failure this plugin
  // must never paper over.
  const { root, entry } = packedCopy('copy')
  const fake = join(root, 'node_modules', '@deepseek-ai', 'dsh-llm')
  mkdirSync(fake, { recursive: true })
  writeFileSync(join(fake, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-llm', version: '9.9.9', type: 'module', main: 'index.js' }))
  writeFileSync(join(fake, 'index.js'),
    'const marked = new WeakSet()\n'
    + 'export const markAgentLoopRequest = request => { marked.add(request); return request }\n'
    + 'export const isAgentLoopRequest = request => marked.has(request)\n')
  const result = probe(`
    import { hostModules, resolutionReport } from ${JSON.stringify(join(root, 'plugin', 'lib', 'host.js'))}
    console.log(JSON.stringify({ report: resolutionReport(), version: hostModules().llm.version }))
  `, { root, cwd: root })
  assert.equal(result.report.reached, true, 'a decoy copy is still a successful resolution')
  assert.equal(result.report.kind, 'fallback', 'and must never be reported as the host')
  assert.equal(result.version, '9.9.9', 'the report names the build that answered, so a decoy is visible')
})

test('with nowhere to resolve, the report says inactive, counts the failure, and lists every anchor', () => {
  const { root, entry } = packedCopy('unreachable')
  const result = probe(`
    import { resolutionReport, resolutionCounts } from ${JSON.stringify(join(root, 'plugin', 'lib', 'host.js'))}
    const first = resolutionReport()
    const second = resolutionReport()
    console.log(JSON.stringify({ first, second, counts: resolutionCounts() }))
  `, { root, cwd: root })
  assert.equal(result.first.reached, false)
  assert.equal(result.first.inactive, true, 'the state must name itself: inactive, not "nothing to report"')
  assert.ok(result.first.tried.length >= 2, `expected anchors, saw ${JSON.stringify(result.first.tried)}`)
  assert.ok(result.first.tried.every(anchor => typeof anchor === 'string'))
  assert.match(result.first.reason, /inactive|no anchor/)
  // Counted, not merely reported: one failure and then two is what separates
  // "could not reach once" from "cannot reach".
  assert.equal(result.first.failures, 1)
  assert.equal(result.second.failures, 2)
  assert.equal(result.counts.attempts, 2)
})

test('a request is still repaired when the host cannot be reached', () => {
  // The seam that carries the repair needs nothing from the host: the rebuild
  // and its predicate are this plugin's own code. Only the loop marker is
  // borrowed. A repair that refused because one borrowed value was missing would
  // trade a permanent, session-killing provider error for a cosmetic omission.
  const { root, entry } = packedCopy('repair-without-host')
  const result = probe(`
    import { replacedRequest, hasLoneSurrogate, resolveLoopMarker } from ${JSON.stringify(entry)}
    const request = {
      provider: 'guarded',
      model: 'recording',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'tail \\uD83D' }] }],
    }
    const replacement = replacedRequest(request)
    console.log(JSON.stringify({
      reached: resolveLoopMarker(),
      repaired: replacement.messages[0].content[0].text,
      original: request.messages[0].content[0].text,
      stillLone: hasLoneSurrogate(replacement),
    }))
  `, { root, cwd: root })
  assert.equal(result.reached, false, 'the marker half is unavailable here, and says so')
  assert.equal(result.original, 'tail \uD83D', 'the durable record keeps the producer bytes')
  assert.equal(result.repaired, 'tail \uFFFD', 'the outgoing frame is repaired regardless')
  assert.equal(result.stillLone, false)
})

test('the marker is never invented for a request the loop did not build', () => {
  // The mirror arm. A predicate that answered `true` unconditionally would pass
  // every "the marker survived" assertion and corrupt the opposite direction.
  const modules = hostModules()
  const handBuilt = { provider: 'guarded', model: 'recording', messages: [] }
  assert.equal(modules.llm.isAgentLoopRequest(handBuilt), false)
})
