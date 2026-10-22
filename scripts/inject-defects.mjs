/**
 * Mutation gate for the guard.
 *
 * Each mutant is one deliberate defect injected into `lib/index.js`; the whole
 * test suite then runs against it. A mutant the suite still passes is a gap in
 * the suite, not a better plugin, so this script fails when any mutant
 * survives.
 *
 * Two properties this script owes the reader, learned the hard way:
 *   - the unmutated control runs first and must be green with zero failures
 *     before any mutant is scored, or a control failing for an unrelated
 *     reason would mark every mutant "caught";
 *   - every run is bounded and `lib/index.js` is restored in a `finally`, so a
 *     killed or hung run cannot leave the shipped source mutated.
 *
 * Run: node scripts/inject-defects.mjs
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const TARGET = resolve(ROOT, 'lib/index.js')
const original = readFileSync(TARGET, 'utf8')
const digest = text => createHash('sha256').update(text).digest('hex').slice(0, 12)

/** One replacement each: `find` must occur exactly once in the source. */
const MUTANTS = [
  ['recursion guard removed', 'if (dispatched.has(options)) return next()', 'if (false) return next()'],
  ['redispatch is not recorded', 'dispatched.add(replacement)\n', ''],
  ['predicate disabled: every request rebuilt', 'if (!containsLoneSurrogate(options)) return next()', 'if (false) return next()'],
  ['predicate disabled: nothing is ever rebuilt', 'if (!containsLoneSurrogate(options)) return next()', 'if (true) return next()'],
  ['no substitution is made', 'return text.isWellFormed() ? text : text.toWellFormed()', 'return text'],
  ['non-strings reported as defects', "return typeof text === 'string' && !text.isWellFormed()", 'return !text'],
  ['the walk skips strings', "if (typeof value === 'string') return !value.isWellFormed()", "if (typeof value === 'string') return false"],
  ['cycle guard removed from the walk', 'if (visited.has(value)) return false', ''],
  ['opaque objects reported as defects', 'if (!isPlainRecord(value)) return false', 'if (!isPlainRecord(value)) return true'],
  ['arrays rebuilt unfrozen', 'return Object.freeze(items)', 'return items'],
  ['records rebuilt unfrozen', 'return Object.freeze(fields)', 'return fields'],
  ['shared nodes duplicated', 'if (seen.has(value)) return seen.get(value)', ''],
  ['different strings in one message are not all repaired', 'for (const key of Object.keys(value)) fields[key] = rebuild(value[key])', 'for (const key of Object.keys(value).slice(0, 1)) fields[key] = rebuild(value[key])'],
  ['tool declarations left unrepaired', 'for (const key of Object.keys(value)) fields[key] = rebuild(value[key])', 'for (const key of Object.keys(value)) fields[key] = key === \'tools\' ? value[key] : rebuild(value[key])'],
  ['loop marker dropped from the replacement', 'if (isAgentLoopRequest(options)) markAgentLoopRequest(replacement)', 'void isAgentLoopRequest'],
  ['loop marker invented for hand-built requests', 'if (isAgentLoopRequest(options)) markAgentLoopRequest(replacement)', 'markAgentLoopRequest(replacement)'],
  ['a failure rejects the request', '      return next()\n    }\n  }\n\n  function warnOnce', '      throw _sanitizerFailed\n    }\n  }\n\n  function warnOnce'],
  ['listener not prepended', ', { prepend: true })', ')'],
  ['service requirement dropped', "export const inject = ['llm']", 'export const inject = []'],
  ['default export loses its inject', 'export default { name, inject, apply }', 'export default { name, apply }'],
  ['warning repeated every request', 'if (reported.has(key)) return', ''],
  ['warning key collapses to one route', 'const key = `${String(options.provider)}\\u0000${String(options.model)}`', "const key = 'route'"],
  ['request counter never moves', 'stats.requests += 1', ''],
  ['repair counter never moves', 'stats.repaired += 1', 'stats.repaired += 0'],
]

/** Every run is bounded, so a hung mutant costs one arm rather than the harness. */
const TIMEOUT_MS = 120_000

/**
 * Run the suite once.
 * @returns whether it exited 0, plus the reported test and failure counts.
 */
function runSuite() {
  let output
  let ok = true
  try {
    output = execFileSync(process.execPath, ['--test', '--test-timeout=20000', 'test/guard.spec.mjs', 'test/wire.spec.mjs'], {
      cwd: ROOT,
      encoding: 'utf8',
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: TIMEOUT_MS,
      killSignal: 'SIGKILL',
      env: process.env,
    })
  } catch (error) {
    ok = false
    output = `${error.stdout ?? ''}${error.stderr ?? ''}`
  }
  const normalised = output.replace(/^ℹ /gmu, '# ')
  const total = /^# tests (\d+)$/mu.exec(normalised)?.[1]
  const failed = /^# fail (\d+)$/mu.exec(normalised)?.[1]
  return { ok, total: Number(total), failed: Number(failed) }
}

/**
 * Run the suite against one injected defect, restoring the source afterwards.
 * @param find - exact source text to replace.
 * @param replace - the defective replacement.
 */
function runMutant(find, replace) {
  writeFileSync(TARGET, original.replace(find, replace))
  try {
    return runSuite()
  } finally {
    writeFileSync(TARGET, original)
  }
}

// A `find` that does not occur exactly once would silently mutate nothing, and
// the arm would then score the control's own result.
for (const [label, find] of MUTANTS) {
  const occurrences = original.split(find).length - 1
  if (occurrences !== 1) {
    console.error(`mutation gate: anchor for "${label}" occurs ${occurrences} times, expected exactly 1`)
    process.exitCode = 1
  }
}
if (process.exitCode === 1) {
  writeFileSync(TARGET, original)
  process.exit(1)
}

const control = runSuite()
if (!control.ok || control.failed !== 0) {
  writeFileSync(TARGET, original)
  console.error(`mutation gate: the unmutated control is red (${control.failed}/${control.total} failing); refusing to score mutants`)
  process.exit(1)
}
console.log(`control: ${control.total}/${control.total} pass`)

const survivors = []
for (const [label, find, replace] of MUTANTS) {
  const result = runMutant(find, replace)
  const caught = !result.ok && result.failed > 0
  console.log(`${caught ? 'CAUGHT  ' : 'SURVIVED'}  ${label}${caught ? ` (${result.failed}/${result.total} failing)` : ''}`)
  if (!caught) survivors.push(label)
}

// A killed run can leave the source mutated, so prove it did not before trusting the verdict.
if (digest(readFileSync(TARGET, 'utf8')) !== digest(original)) {
  writeFileSync(TARGET, original)
  console.error('mutation gate: lib/index.js did not survive the run; restored from the in-memory original')
  process.exit(1)
}

console.log(`\n${MUTANTS.length - survivors.length}/${MUTANTS.length} mutants caught; source intact (${digest(original)})`)
if (survivors.length > 0) {
  console.error(`surviving mutants are suite gaps, not acceptable results: ${survivors.join('; ')}`)
  process.exit(1)
}
