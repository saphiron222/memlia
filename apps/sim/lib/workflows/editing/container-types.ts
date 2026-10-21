// Modified by Memlia: share strict admission of native container counters.
import {
  parseWorkflowSearchSubflowReplacement,
  WORKFLOW_SEARCH_SUBFLOW_FIELD_IDS,
} from '@/lib/workflows/search-replace/subflow-fields'

/** Shared container vocabulary; reading it never loads the workflow mutation engine. */
export const VALID_LOOP_TYPES = ['for', 'forEach', 'while', 'doWhile'] as const
export const VALID_PARALLEL_TYPES = ['count', 'collection'] as const

/** Preserve the native decimal grammar; never coerce unrelated block inputs. */
export function parseContainerCounter(value: unknown): number | undefined {
  if (typeof value === 'string') {
    const parsed = parseWorkflowSearchSubflowReplacement({
      fieldId: WORKFLOW_SEARCH_SUBFLOW_FIELD_IDS.iterations,
      replacement: value,
    })
    if (!parsed.success) return undefined
    value = parsed.value
  }
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined
}
