// Copyright (c) 2026 Memlia. All rights reserved.
import { describe, expect, it } from 'vitest'
import { getContainerBlockDetail } from '@/lib/catalog/projection/container-blocks'
import { ApiBlock } from '@/blocks/blocks/api'
import { ConditionBlock } from '@/blocks/blocks/condition'
import { FunctionBlock } from '@/blocks/blocks/function'
import { GmailV2Block } from '@/blocks/blocks/gmail'
import { GoogleSheetsV2Block } from '@/blocks/blocks/google_sheets'
import { HumanInTheLoopV2Block } from '@/blocks/blocks/human_in_the_loop'
import { MemliaExcelBlock } from '@/blocks/blocks/memlia_excel'
import { NoteBlock } from '@/blocks/blocks/note'
import { ResponseBlock } from '@/blocks/blocks/response'
import { RouterV2Block } from '@/blocks/blocks/router'
import { SlackV2Block } from '@/blocks/blocks/slack'
import { StartTriggerBlock } from '@/blocks/blocks/start_trigger'
import { VariablesBlock } from '@/blocks/blocks/variables'
import { chatCorpus } from './corpus'

// Native static definitions, not the globally mocked registry and not authorization.
const native = [
  ApiBlock,
  ConditionBlock,
  FunctionBlock,
  GmailV2Block,
  GoogleSheetsV2Block,
  HumanInTheLoopV2Block,
  MemliaExcelBlock,
  NoteBlock,
  ResponseBlock,
  RouterV2Block,
  SlackV2Block,
  StartTriggerBlock,
  VariablesBlock,
]
describe('corpus vocabulary against native catalogue definitions', () => {
  it.each([...new Set(chatCorpus.map((c) => c.blockType))])(
    'resolves %s without inventing a block type',
    (type) => {
      const block = native.find((b) => b.type === type)
      if (block) {
        expect(block.hideFromToolbar).not.toBe(true)
        expect(block.subBlocks.length).toBeGreaterThan(0)
      } else expect(getContainerBlockDetail(type)?.id).toBe(type)
    }
  )
  it('anchors the generated structured reference to the real Function output', () => {
    expect(FunctionBlock.outputs.result.type).toBe('json')
    expect(FunctionBlock.outputs.stdout.type).not.toBe('json')
    expect(FunctionBlock.outputs.files.type).not.toBe('json')
    expect(FunctionBlock.outputs).not.toHaveProperty('output')
  })
})
