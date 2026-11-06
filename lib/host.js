/**
 * The one harness module this plugin borrows, resolved from the running host.
 *
 * ## Why this file exists
 *
 * 0.2.0 imported the loop-marker pair at module scope:
 * `import { isAgentLoopRequest, markAgentLoopRequest } from '@deepseek-ai/dsh-llm'`.
 * In a profile that import is fatal, and the reason is structural rather than a
 * missing dependency: a profile installs with `autoInstallPeers: false`
 * (`pnpm-workspace.yaml`), so pnpm installs a package's own `dependencies` and
 * none of its peers, and `@deepseek-ai/dsh-llm` is a peer. Node then resolves
 * the bare specifier from the plugin's own directory and finds nothing — not the
 * host's copy, not any copy — so the module fails to evaluate and the loader
 * never sees the plugin.
 *
 * Declaring it as a real `dependency` is not the repair, and that was measured
 * twice over. It moves the failure one level deeper (`dsh-llm`'s own entry
 * imports its own peers at module scope), and where it does load, the profile's
 * copy wins resolution for the whole process and silently shadows the host's
 * core packages — the crash discussion #10338 reports, whose next start does not
 * boot.
 *
 * So the plugin asks the running host instead. Node resolves a bare specifier
 * from a base path, and `require()` of an ES module returns the namespace object
 * the host already loaded — the same object, not a second one.
 *
 * ## Here that sameness is the contract, not a detail
 *
 * `isAgentLoopRequest` and `markAgentLoopRequest` are not functions over a
 * value; they are two views of one module-scope
 * `WeakSet<GenerateOptions>` (`packages/llm/llm/src/call-config.ts:13`). The
 * loop marks the request object it assembled; every later listener asks that
 * same set whether this exact object is in it. A second copy of `dsh-llm`
 * carries a second, empty set, and answers `false` for every request the real
 * loop ever marked — silently, with no error, forever.
 *
 * That failure mode is specific to this plugin's errand. A vocabulary the plugin
 * borrowed would only be wrong in content; here a wrong instance quietly drops
 * the loop marker off the replacement envelope, and the rebuilt request loses a
 * property its caller had. So {@link ResolutionKind} is load-bearing:
 * `host-frame` means the anchor was a frame inside the very package being
 * borrowed, which exists only because that package is the caller; `fallback`
 * means the module may be the host's own or may be a second copy, and the report
 * says which of the two it is instead of assuming.
 *
 * ## What the failure must not become
 *
 * The plugin's contract is that it never decides whether a request runs, so a
 * resolution failure cannot block one. It also cannot be silent: "the request
 * carried no lone surrogate" and "I could not reach the host, so I could not
 * even ask" are different facts, and only one of them is about the request.
 * {@link resolutionReport} therefore never throws and never answers "clean" — it
 * says `reached: false`, lists every anchor it tried and counts the failure,
 * which is what makes an unattended outage legible to an operator.
 *
 * Resolution is synchronous and lazy. Synchronous because the guard rebuilds a
 * request inside a waterfall listener, which cannot await; lazy because nothing
 * here runs at import time, which is what lets the package load in a profile
 * that installs none of the harness packages.
 *
 * @module @argszero/dsh-surrogate-sanitizer-guard/host
 */

import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** The host package this plugin borrows. It is a declaration-time peer. */
export const HOST_PACKAGE = '@deepseek-ai/dsh-llm'

/**
 * This package's own directory.
 *
 * A frame inside it is never the host's: it is this plugin's code, or a copy of
 * the harness packages installed beneath it as devDependencies. Matched by path
 * prefix rather than by name, because a name match is wrong in both directions —
 * it misses a package installed under any other directory name, and it discards
 * every frame whenever this package's own checkout happens to be named
 * `dsh-surrogate-sanitizer-guard`, which is exactly what its repository is
 * called.
 */
const SELF_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

/**
 * The path fragment a frame must carry to prove the borrowed package is the
 * caller. Narrower than "somewhere in the harness install" on purpose: the
 * claim being made is about this package's own module instance, so only a frame
 * inside this package is evidence for it.
 */
const HOST_FRAME = join('node_modules', '@deepseek-ai', 'dsh-llm')

/**
 * What a successful resolution is evidence *of*.
 *
 * - `host-frame`: the base path was a file inside
 *   `node_modules/@deepseek-ai/dsh-llm`, so that package is on the stack and the
 *   module resolved from it is its own already-loaded instance.
 * - `fallback`: the base path was the process entry, the working directory or
 *   this package's own tree. The module may be the host's, or may be a second
 *   copy that happens to resolve; the plugin cannot tell from here.
 */
export const HOST_FRAME_KIND = 'host-frame'
export const FALLBACK_KIND = 'fallback'

/**
 * File paths named by the current stack that belong to the borrowed package.
 * @returns candidate anchors, outermost frame first.
 */
function stackAnchors() {
  const stack = String(new Error('anchor').stack ?? '')
  const found = []
  for (const line of stack.split('\n')) {
    const match = line.match(/\(?((?:file:\/\/)?\/[^():]+):\d+:\d+\)?$/)
    const frame = match?.[1]
    if (frame === undefined) continue
    const path = frame.startsWith('file://') ? fileURLToPath(frame) : frame
    if (!path.includes(HOST_FRAME)) continue
    if (path.startsWith(SELF_ROOT)) continue
    if (!found.some(candidate => candidate.path === path)) found.push({ path, kind: HOST_FRAME_KIND })
  }
  return found
}

/**
 * Every anchor to try, in the order that prefers the host over this package.
 *
 * De-duplication keeps the first occurrence, which is why the stack anchors come
 * first: the same path reached as a host frame and as a fallback is host-frame
 * evidence, and the weaker reading must not overwrite the stronger one.
 * @returns base file paths, de-duplicated, each with the evidence it carries.
 */
function anchorCandidates() {
  const candidates = [
    ...stackAnchors(),
    process.argv[1] === undefined ? undefined : { path: process.argv[1], kind: FALLBACK_KIND },
    { path: join(process.cwd(), 'index.js'), kind: FALLBACK_KIND },
    { path: fileURLToPath(import.meta.url), kind: FALLBACK_KIND },
  ]
  const seen = new Set()
  const ordered = []
  for (const candidate of candidates) {
    if (candidate === undefined || seen.has(candidate.path)) continue
    seen.add(candidate.path)
    ordered.push(candidate)
  }
  return ordered
}

/** Read the package's version through the same anchor that resolved it. */
function versionOf(require) {
  try {
    const manifest = JSON.parse(readFileSync(require.resolve(`${HOST_PACKAGE}/package.json`), 'utf8'))
    return typeof manifest.version === 'string' ? manifest.version : 'unknown'
  } catch {
    try {
      const directory = dirname(require.resolve(HOST_PACKAGE))
      const manifest = JSON.parse(readFileSync(join(directory, '..', 'package.json'), 'utf8'))
      return typeof manifest.version === 'string' ? manifest.version : 'unknown'
    } catch {
      return 'unknown'
    }
  }
}

/** Resolve the borrowed package through one anchor, or throw. */
function readFrom(candidate) {
  const require = createRequire(candidate.path)
  // `require()` of an ES module answers with the namespace object the host
  // already loaded: the same module record, not a copy of it.
  const llm = require(HOST_PACKAGE)
  // A namespace without both markers is not a usable answer, however
  // successfully it resolved: counting it as reached would report a working
  // guard over a package that cannot stamp anything.
  if (typeof llm?.isAgentLoopRequest !== 'function' || typeof llm?.markAgentLoopRequest !== 'function') {
    throw new TypeError(`${HOST_PACKAGE} resolved without the agent-loop marker pair`)
  }
  return {
    anchor: candidate.path,
    kind: candidate.kind,
    llm: {
      isAgentLoopRequest: llm.isAgentLoopRequest,
      markAgentLoopRequest: llm.markAgentLoopRequest,
      version: versionOf(require),
    },
  }
}

let cached

/** Running totals for this process: attempts made, and attempts that reached nothing. */
const counts = { attempts: 0, failures: 0 }

/**
 * How many resolutions have been attempted, and how many found nothing.
 *
 * A count rather than the last value: a guard that could not reach the host once
 * and a guard that has been failing on every repair all session are different
 * operational states, and only the count separates them.
 * @returns the running totals for this process.
 */
export function resolutionCounts() {
  return { attempts: counts.attempts, failures: counts.failures }
}

/**
 * What the resolver can currently reach, without ever throwing.
 *
 * This is the reading an operator needs when the guard looks inert: a resolution
 * that did not answer is `reached: false` with every anchor tried and a failure
 * counted, never an exception at the dispatch site and never a claim that the
 * request was clean.
 * @returns the reached module with its evidence, or the anchors that failed.
 */
export function resolutionReport() {
  counts.attempts += 1
  const tried = []
  for (const candidate of anchorCandidates()) {
    tried.push(candidate.path)
    try {
      const modules = readFrom(candidate)
      cached = modules
      return {
        reached: true,
        kind: modules.kind,
        anchor: modules.anchor,
        version: modules.llm.version,
        failures: counts.failures,
      }
    } catch {
      // This anchor is a candidate, not a verdict: the next one may resolve.
      continue
    }
  }
  if (cached !== undefined) {
    // Every anchor has since stopped resolving, but the cache still holds what
    // was reached: the report states what was obtained, not what is reachable
    // this instant.
    return {
      reached: true,
      kind: cached.kind,
      anchor: cached.anchor,
      version: cached.llm.version,
      failures: counts.failures,
    }
  }
  counts.failures += 1
  return {
    reached: false,
    inactive: true,
    tried,
    failures: counts.failures,
    reason:
      'surrogate-sanitizer-guard: no anchor reached the running host\'s '
      + `${HOST_PACKAGE}, so the agent-loop marker cannot be re-stamped on a repaired request.`
      + ' Lone surrogates are still repaired — that half needs nothing from the host — but the'
      + ' replacement is dispatched without the marker, so loop-aware listeners downstream of'
      + ' this plugin will not recognise it as a loop request. This is reported rather than'
      + ' swallowed because "the request carried no surrogate" and "the host could not be'
      + ' reached" are different facts, and only one of them is about the request.',
  }
}

/**
 * The host's module, resolved once and reused.
 *
 * The first call resolves and caches; a failure is not cached, so a later call
 * from a deeper host frame gets its own chance to find an anchor.
 * @returns the borrowed module and the anchor that answered.
 * @throws when no anchor resolves the package.
 */
export function hostModules() {
  if (cached !== undefined) return cached
  counts.attempts += 1
  const tried = []
  for (const candidate of anchorCandidates()) {
    tried.push(candidate.path)
    try {
      const modules = readFrom(candidate)
      cached = modules
      return modules
    } catch {
      continue
    }
  }
  counts.failures += 1
  const error = new Error(
    `surrogate-sanitizer-guard: could not reach ${HOST_PACKAGE} from any anchor. Tried:\n`
    + tried.map(anchor => `  - ${anchor}`).join('\n'),
  )
  error.anchors = tried
  throw error
}
