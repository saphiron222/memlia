// Modified by Memlia: test additive draft-origin persistence without changing legacy migrations.
import { describe, expect, it } from 'vitest'
import {
  dropLegacyWorkflowCopilotDrafts,
  readDraftLocalOrigin,
  useMothershipDraftsStore,
} from '@/stores/mothership-drafts/store'

const payload = { text: 'unsent' }

describe('dropLegacyWorkflowCopilotDrafts', () => {
  it('drops workflow-only copilot keys that no surface reads anymore', () => {
    const { drafts } = dropLegacyWorkflowCopilotDrafts({
      drafts: { 'ws-1:workflow-copilot:wf-1': payload },
    })

    expect(drafts).toEqual({})
  })

  it('keeps per-chat copilot keys, including the unselected-chat slot', () => {
    const drafts = {
      'ws-1:workflow-copilot:wf-1:chat-1': payload,
      'ws-1:workflow-copilot:wf-1:new': payload,
    }

    expect(dropLegacyWorkflowCopilotDrafts({ drafts }).drafts).toEqual(drafts)
  })
})

describe('restrictive local draft origin', () => {
  it('keeps legacy drafts unchanged and distinguishes only a present true marker', () => {
    expect(readDraftLocalOrigin({ text: 'legacy' })).toBe('none')
    expect(readDraftLocalOrigin({ text: 'local', localOrigin: true })).toBe('local')
    const drafts = { 'ws:workflow-copilot:wf:new': { text: 'local', localOrigin: true } }
    expect(dropLegacyWorkflowCopilotDrafts({ drafts }).drafts).toEqual(drafts)
  })
  it.each([false, null, undefined, 'true', 1, {}])(
    'never treats malformed marker %s as legacy',
    (value) => {
      const payload = { text: 'keep', localOrigin: value }
      expect(readDraftLocalOrigin(payload)).toBe('invalid')
      useMothershipDraftsStore.getState().setDraft('test-origin', payload)
      const copied = JSON.parse(
        JSON.stringify(useMothershipDraftsStore.getState().drafts['test-origin'])
      )
      expect(copied.text).toBe('keep')
      expect(readDraftLocalOrigin(copied)).toBe('invalid')
      useMothershipDraftsStore.getState().clearDraft('test-origin')
    }
  )
  it('does not invoke an origin accessor', () => {
    let reads = 0
    const payload = {
      get localOrigin() {
        reads++
        return true
      },
    }
    expect(readDraftLocalOrigin(payload)).toBe('invalid')
    expect(reads).toBe(0)
  })
})
