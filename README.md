# dsh-surrogate-sanitizer-guard

Repair lone UTF-16 surrogates on the outgoing DeepSeek request — both halves of
it, the model request and the extension fields merged into it — so one truncated
string in a session's durable history cannot make every later turn fail.

## The failure

A model-authored tool call can cut a string through a surrogate pair — a
`JSON.stringify` in generated code, a `.slice(0, 120)` on a label, a
byte-bounded truncation. The cut string is well formed to nobody: it ends (or
begins) with an unpaired UTF-16 code unit.

That string is written into the durable session record, and the record is
replayed into every later request. The Messages API rejects a body carrying a
lone surrogate, so the session fails permanently: the defect is in the history,
and the history never changes. Nothing the user types afterwards can help,
because the poison is in the part of the request the user does not write.

## What it does

The outgoing body has **two authors**, and only one of them goes through
`llm/stream`. The plugin covers both.

**1. The model request** — the plugin listens on the `llm/stream` waterfall,
prepended, and walks the request for a string carrying a lone surrogate.

- **Nothing found** — the caller's own request reaches `next()` untouched. This
  is the ordinary case and it is decided by identity, not by a copy.
- **Something found** — the request is rebuilt with
  `String.prototype.toWellFormed()` applied to every reachable string, which
  substitutes U+FFFD for each unpaired code unit, and the rebuilt request is
  re-dispatched through the runtime. That is what actually goes out.

**2. The extension fields** — the top-level fields contributed by
`ctx.deepseekLlmApiExtensions` are *not* part of the model request: each provider
prepares its own field, and the adapter merges the prepared record into the
serialized body. `dsh_session_log` — the session's own durable log, replayed on
every request — is one such field, and a lone surrogate there fails every turn
exactly as one in the messages would.

So the plugin also shadows `deepseekLlmApiExtensions.prepare` on the registry
instance. When a prepared field carries a lone surrogate, the frozen
null-prototype record is **rebuilt** rather than mutated (a frozen record cannot
be mutated, and the record is spread into the body, so it may not gain a
prototype it never had), a field that is already clean is carried by reference,
and the acceptance transaction — `accept` — is carried through by reference too:
dropping it would leave the delivery watermark uncommitted on a request that
otherwise succeeded.

The registry is **optional**. `llm-deepseek` reads it with
`ctx.get('deepseekLlmApiExtensions')?.prepare(...)`, and a profile may not mount
it at all, so the plugin attaches the second seam through `ctx.inject`: it is
installed when the registry is present, when it mounts later, and removed when
either goes away. Only `llm` is a hard requirement.

It is provider-agnostic: a lone surrogate is invalid in any JSON API surface,
not only DeepSeek's.

### Why the second seam exists

An earlier version of this plugin walked `llm/stream` alone, on the reading that
the request is the body. Measured against the real adapter, that is wrong, and
the failure is subtler than it looks:

- The serializer emits `"dsh_session_log":{"texts":["tail \ud83d"]}` — a
  **complete, valid** four-hex escape. The payload parses.
- The provider then rejects the **value**: it is an unpaired surrogate. It words
  the rejection as an unexpected end of a hex escape and names a position, which
  is why the original report points at `texts[0]` and reads like a
  serialization bug.

The defect is in the value, so the repair belongs at the value — not in the
serializer, and not in the encoding layer.

## Boundary, stated plainly

This repairs the outgoing frame, not the producer.

- The durable session record is **not** rewritten: the report, the session log
  and the projection keep the bytes the producer wrote, so a later core fix
  still sees the real defect.
- A surrogate pair **split across two strings** becomes two U+FFFD, not a
  rejoined character. Rejoining would mean guessing that two fragments of a
  session log were one string, and a wrong guess corrupts content that was
  never broken.
- The string is repaired on the way out, so the model reads U+FFFD where the
  cut happened. That is what the pi-ai routes already do; the DeepSeek Messages
  path does not.
- Core-side acceptance and watermark behaviour is untouched: the plugin repairs
  what goes out, and leaves the acceptance transaction exactly as the registry
  built it.
- The structural fix — a sanitizer inside the DeepSeek serializer and inside the
  extension registry — belongs to the harness, not to a plugin.

## Why the predicate is a walk

Two cheaper-looking predicates were measured and both are wrong:

- `JSON.stringify(request).isWellFormed()` is **always true**. `JSON.stringify`
  escapes a lone surrogate into the well-formed text `\ud83d`, so the
  serialized form is structurally unable to witness the defect.
- Scanning the serialized text for surrogate escapes **invents** defects. Text
  that literally contains the six characters `\ud83d` — a quoted stack trace, a
  `run_code` snippet — is well formed, and such content is ordinary in a coding
  agent's history.

A per-string `isWellFormed()` walk has neither failure mode: it answers about
the strings the adapter will serialize, and an engine-native check allocates
nothing.

## Install

```sh
dsh plugin --profile <profile> add github:argszero/dsh-surrogate-sanitizer-guard
```

That single command is the whole install: it installs the package into the
profile and adds it to the profile's bundle list. A plain `npm i` of the same
spec is **inert on its own** — a bundle becomes a layer only when the profile's
`package.json` lists it under `dsh.profile.bundles`
(`packages/boot/app-boot/src/profile.ts`), and the plugin manager is what writes
that list after an install (`packages/boot/plugin-manager/src/operations.ts`).

The package declares `dsh.bundle.patch`. Mounted by hand instead:

```yaml
- insert:
    - id: surrogate-sanitizer-guard
      name: '@argszero/dsh-surrogate-sanitizer-guard'
```

The plugin requires the `llm` service; without it, the plugin stays pending
rather than loading inert. The extension registry is **not** required — it is
attached when present, so a profile that never mounts it still gets the
`llm/stream` half.

## Verification

```sh
npm install
node --test --test-timeout=30000 test/*.spec.mjs   # 44 tests
node scripts/mount-smoke.mjs                       # mount on cordis 4.0.5, teardown observable
node scripts/inject-defects.mjs                    # 32 mutants, control first, 31 caught + 1 named equivalent
```

`test/wire.spec.mjs` drives the real `@deepseek-ai/dsh-llm-deepseek` adapter
with a capturing `fetch`. The discriminator is one field,
`messages[0].content[0].text` — unguarded it leaves as `\ud83d`, guarded it
carries U+FFFD, and every other byte of the body is identical. A
well-formed request is dispatched untouched, and the durable record is
byte-identical after the guarded frame goes out.

`test/extensions.spec.mjs` takes the same reading for the second seam. It mounts
the real `@deepseek-ai/dsh-deepseek-llm-api-extensions` registry, registers a
poisoned `dsh_session_log`, and drives the adapter through the expression the
shipped host uses — `ctx.get('deepseekLlmApiExtensions')?.prepare(...)` — then
asserts the HTTP body carries U+FFFD and no unpaired surrogate. Its negative arm
is asserted by identity: a prepared result carrying no defect must reach the
adapter as the registry's own object. Further arms cover a registry mounted
*after* the plugin, the null prototype of the rebuilt record, a clean sibling
field carried by reference, and `accept` still running after a rebuild.

The mutation gate names its one surviving mutant rather than deleting it:
Cordis forwards a property write on a service view to the service instance, so
installing the shadow on either spelling reaches the same seam. The instance
form is kept because `Object.hasOwn` on a view reports false for a property the
instance already owns, which would make the disposer mis-restore.

## License

MIT
