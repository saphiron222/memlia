// Modified by Memlia: display and preserve limited Chat response notices.
import { buildCompletionNotice } from '@/lib/mothership/chat/completion-notice'
import type { StreamHandler } from './types'
import { addContentBlock, flushSubagentThinkingBlock, flushThinkingBlock } from './types'

export const handleCompleteEvent: StreamHandler = (event, context) => {
  flushSubagentThinkingBlock(context)
  flushThinkingBlock(context)
  if (event.type !== 'complete') {
    context.streamComplete = true
    return
  }

  if (event.payload.usage) {
    context.usage = {
      prompt: (context.usage?.prompt || 0) + (event.payload.usage.input_tokens || 0),
      completion: (context.usage?.completion || 0) + (event.payload.usage.output_tokens || 0),
    }
  }

  if (event.payload.cost) {
    context.cost = {
      input: (context.cost?.input || 0) + (event.payload.cost.input || 0),
      output: (context.cost?.output || 0) + (event.payload.cost.output || 0),
      total: (context.cost?.total || 0) + (event.payload.cost.total || 0),
    }
  }

  const notice = !context.streamComplete ? buildCompletionNotice(event.payload) : undefined
  if (notice) {
    // Persist the same local display text as the live reducer; raw metadata stays out.
    addContentBlock(context, { type: 'text', content: notice })
  }

  context.completionStatus = event.payload.status
  context.streamComplete = true
}
