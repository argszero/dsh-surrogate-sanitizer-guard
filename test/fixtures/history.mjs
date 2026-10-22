/** Request fixtures built from the published message factories, never hand-shaped. */
import { createToolResultMessage, createUserMessage } from '@deepseek-ai/dsh-llm'

/** Last code unit is an unpaired high surrogate (U+D83D), as `.slice()` leaves it. */
export const LONE_HIGH = 'tail \uD83D'

/** First code unit is an unpaired low surrogate (U+DE00), the truncation's mirror image. */
export const LONE_LOW = '\uDE00 head'

/** A well-formed astral character: two code units that belong together. */
export const PAIR = 'face \uD83D\uDE00'

/** Well-formed text that *spells* a surrogate escape without containing one. */
export const LITERAL_ESCAPE = String.raw`path a\ud83db path`

/** What `toWellFormed()` substitutes for an unpaired code unit. */
export const REPLACEMENT = '\uFFFD'

export const user = text => createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] })

export const toolResult = text => createToolResultMessage({
  source: { kind: 'tool' },
  callId: 'call-1',
  content: [{ type: 'text', text }],
})

/** The first block's text, for assertions on one path. */
export const textOf = message => message.content[0].text

/**
 * One request envelope in the shape the runtime dispatches.
 * @param messages - ordered conversation messages.
 * @param extra - fields merged over the envelope.
 */
export function request(messages, extra = {}) {
  return { provider: 'guarded', model: 'recording', messages, ...extra }
}

/** One tool declaration carrying `text` as its description. */
export const toolNamed = text => ({ name: 'read', description: text, parameters: { type: 'object', properties: {} } })
