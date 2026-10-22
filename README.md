# dsh-surrogate-sanitizer-guard

Repair lone UTF-16 surrogates on the outgoing model request, so one truncated
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

The plugin listens on the `llm/stream` waterfall, prepended. It walks the
request for a string carrying a lone surrogate.

- **Nothing found** — the caller's own request reaches `next()` untouched. This
  is the ordinary case and it is decided by identity, not by a copy.
- **Something found** — the request is rebuilt with
  `String.prototype.toWellFormed()` applied to every reachable string, which
  substitutes U+FFFD for each unpaired code unit, and the rebuilt request is
  re-dispatched through the runtime. That is what actually goes out.

It is provider-agnostic: a lone surrogate is invalid in any JSON API surface,
not only DeepSeek's.

## Boundary, stated plainly

This repairs the outgoing frame, not the producer.

- The durable session record is **not** rewritten: the report, the session log
  and the projection keep the bytes the producer wrote, so a later core fix
  still sees the real defect.
- The string is repaired on the way out, so the model reads U+FFFD where the
  cut happened. That is what the pi-ai routes already do; the DeepSeek Messages
  path does not.
- The structural fix — a sanitizer inside the DeepSeek serializer, where the
  body is built — belongs to the harness, not to a plugin.

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
npm i github:argszero/dsh-surrogate-sanitizer-guard
```

The package declares `dsh.bundle.patch`, so mounting it as a bundle is enough.
Mounted by hand instead:

```yaml
- insert:
    - id: surrogate-sanitizer-guard
      name: '@argszero/dsh-surrogate-sanitizer-guard'
```

The plugin requires the `llm` service; without it, the plugin stays pending
rather than loading inert.

## Verification

```sh
npm install
node --test --test-timeout=30000 test/*.spec.mjs   # 32 tests
node scripts/mount-smoke.mjs                       # mount on cordis 4.0.5, teardown observable
node scripts/inject-defects.mjs                    # 24 mutants, control first, all caught
```

`test/wire.spec.mjs` drives the real `@deepseek-ai/dsh-llm-deepseek` adapter
with a capturing `fetch`. The discriminator is one field,
`messages[0].content[0].text` — unguarded it leaves as `\ud83d`, guarded it
carries U+FFFD, and every other byte of the body is identical. A
well-formed request is dispatched untouched, and the durable record is
byte-identical after the guarded frame goes out.

## License

MIT
