/** A recording adapter whose only job is to capture the request it is dispatched. */
import { LlmAdapter } from '@deepseek-ai/dsh-llm'

export class RecordingAdapter extends LlmAdapter {
  constructor() {
    super()
    this.requests = []
  }

  providerInfo(provider) {
    return { id: provider, name: `Recording ${provider}` }
  }

  async resolveModel(provider, model) {
    return { provider, id: model, name: model }
  }

  async *stream(options) {
    this.requests.push(options)
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}
