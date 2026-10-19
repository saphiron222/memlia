// Modified by Memlia: qualify revision-bound imports and atomic variables.
import {
  apiClientRequestMock,
  apiClientRequestMockFns,
} from '@sim/testing/mocks/api-client-request.mock'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Import parsing migrates sub-block ids against each block's declared config,
 * which the global registry stub empties. Only the blocks the fixtures name are
 * registered.
 */
vi.unmock('@/blocks/registry')
vi.mock('@/blocks/registry-maps', async () => {
  const { partialBlockRegistry } = await import('@sim/testing/mocks/block-registry.mock')
  return partialBlockRegistry(
    await import('@/blocks/blocks/knowledge'),
    await import('@/blocks/blocks/agent'),
    await import('@/blocks/blocks/start_trigger')
  )
})

vi.mock('@/lib/api/client/request', () => apiClientRequestMock)

import { ApiClientError } from '@/lib/api/client/errors'
import { requestJson } from '@/lib/api/client/request'
import {
  getWorkflowStateContract,
  type WorkflowStateContractInput,
} from '@/lib/api/contracts/workflows'
import {
  parseWorkflowJson,
  persistImportedWorkflow,
  sanitizePathSegment,
} from '@/lib/workflows/operations/import-export'

beforeEach(() => {
  apiClientRequestMockFns.mockRequestJson.mockReset()
  apiClientRequestMockFns.mockRequestJson.mockImplementation(async (contract, input) =>
    contract === getWorkflowStateContract
      ? {
          data: {
            id: input.params.id,
            workspaceId: 'ws-1',
            draftRevision: 7,
            state: createLegacyState(),
          },
        }
      : { success: true, baseRevision: 7, draftRevision: 8, warnings: [] }
  )
})

function createLegacyState() {
  return {
    blocks: {
      'start-1': {
        id: 'start-1',
        type: 'start_trigger',
        name: 'Start',
        position: { x: 0, y: 0 },
        enabled: true,
        subBlocks: {
          inputFormat: {
            id: 'inputFormat',
            type: 'input-format',
            value: [],
          },
          undefined: {
            type: 'unknown',
            value: 'stale duplicate',
          },
        },
        outputs: {},
        data: {},
      },
    },
    edges: [],
    loops: {},
    parallels: {},
    variables: {},
    metadata: {
      name: 'Wrapped Workflow',
    },
  }
}

describe('workflow import/export parsing', () => {
  it('parses workflow exports wrapped in an API data envelope', () => {
    const content = JSON.stringify({
      data: {
        version: '1.0',
        exportedAt: '2026-05-07T06:45:06.892Z',
        workflow: {
          name: 'Wrapped Workflow',
        },
        state: createLegacyState(),
      },
    })

    const result = parseWorkflowJson(content, false)

    expect(result.errors).toEqual([])
    expect(result.data?.blocks['start-1']).toBeDefined()
    expect(result.data?.blocks['start-1'].subBlocks.inputFormat).toEqual({
      id: 'inputFormat',
      type: 'input-format',
      value: [],
    })
    expect(result.data?.blocks['start-1'].subBlocks.undefined).toBeUndefined()
  })

  it('preserves malformed legacy renamed subBlocks during import parsing', () => {
    const state = {
      ...createLegacyState(),
      blocks: {
        knowledge: {
          id: 'knowledge',
          type: 'knowledge',
          name: 'Knowledge',
          position: { x: 0, y: 0 },
          enabled: true,
          subBlocks: {
            operation: { id: 'operation', type: 'dropdown', value: 'search' },
            knowledgeBaseId: {
              id: 'knowledgeBaseId',
              type: 'unknown',
              value: 'kb-uuid-123',
            },
          },
          outputs: {},
          data: {},
        },
      },
    }
    const content = JSON.stringify({ data: { workflow: { name: 'Knowledge Workflow' }, state } })

    const result = parseWorkflowJson(content, false)

    expect(result.errors).toEqual([])
    expect(result.data?.blocks.knowledge.subBlocks.knowledgeBaseId).toBeUndefined()
    expect(result.data?.blocks.knowledge.subBlocks.knowledgeBaseSelector).toEqual({
      id: 'knowledgeBaseSelector',
      type: 'knowledge-base-selector',
      value: 'kb-uuid-123',
    })
  })
})

it('preserves variable permissions and the dormant selector through import', async () => {
  const state = createLegacyState()
  const tool = { type: 'function', usageControl: 'none', usageControlExpression: '<start.mode>' }
  const tools = { id: 'tools', type: 'tool-input', value: [tool] }
  const canonicalModes = { '0:agentToolUsageControl': 'advanced' }
  const content = JSON.stringify({
    state: {
      ...state,
      blocks: {
        ...state.blocks,
        agent: {
          ...state.blocks['start-1'],
          id: 'agent',
          name: 'Agent',
          type: 'agent',
          subBlocks: { tools },
          data: { canonicalModes },
        },
      },
    },
  })
  const createWorkflow = vi.fn().mockResolvedValue({ id: 'imported-workflow' })
  await expect(
    persistImportedWorkflow({
      content,
      filename: 'workflow.json',
      workspaceId: 'ws-1',
      createWorkflow,
    })
  ).resolves.toMatchObject({ workflowId: 'imported-workflow' })
  const written = vi.mocked(requestJson).mock.calls.at(-1)?.[1].body as WorkflowStateContractInput
  expect(Object.values(written.blocks)).toContainEqual(
    expect.objectContaining({
      type: 'agent',
      subBlocks: expect.objectContaining({ tools }),
      data: expect.objectContaining({ canonicalModes: expect.objectContaining(canonicalModes) }),
    })
  )
})

describe('persistImportedWorkflow description handling', () => {
  function buildContent(description?: string) {
    const state = createLegacyState()
    return JSON.stringify({
      data: {
        version: '1.0',
        workflow: { name: 'Imported Workflow' },
        state: {
          ...state,
          metadata: { name: 'Imported Workflow', description },
        },
      },
    })
  }

  async function importWithContent(content: string, descriptionOverride?: string) {
    const createWorkflow = vi.fn().mockResolvedValue({ id: 'wf-1' })
    await persistImportedWorkflow({
      content,
      filename: 'imported-workflow.json',
      workspaceId: 'ws-1',
      descriptionOverride,
      createWorkflow,
    })
    return createWorkflow.mock.calls[0][0].description as string
  }

  it('scrubs placeholder metadata descriptions to an empty string', async () => {
    expect(await importWithContent(buildContent('New workflow'))).toBe('')
    expect(
      await importWithContent(buildContent('Your first workflow - start building here!'))
    ).toBe('')
  })

  it('falls back to meaningful metadata when the override is a placeholder', async () => {
    expect(await importWithContent(buildContent('Metadata description'), 'New workflow')).toBe(
      'Metadata description'
    )
  })
})

describe('sanitizePathSegment', () => {
  it('should preserve Korean characters (BUG REPRODUCTION)', () => {
    expect(sanitizePathSegment('한글')).toBe('한글')
  })
})

describe('import revision and atomic replacement', () => {
  function input() {
    return {
      content: JSON.stringify({
        state: {
          ...createLegacyState(),
          variables: [
            { id: 'limit', name: 'Limit', type: 'number', value: 3 },
            { id: 'odd', name: 'Odd', type: 'unsupported', value: 'kept' },
          ],
        },
      }),
      filename: 'owned.json',
      workspaceId: 'ws-1',
      createWorkflow: vi.fn().mockResolvedValue({ id: 'new-destination' }),
    }
  }

  it.each([0, 27])(
    'uses revision %i of the created destination and writes variables with the graph once',
    async (revision) => {
      const options = input()
      apiClientRequestMockFns.mockRequestJson.mockImplementation(async (contract, request) => {
        if (contract === getWorkflowStateContract)
          return {
            data: {
              id: request.params.id,
              workspaceId: 'ws-1',
              draftRevision: revision,
              state: createLegacyState(),
            },
          }
        return { success: true, baseRevision: revision, draftRevision: revision + 1, warnings: [] }
      })
      await expect(persistImportedWorkflow(options)).resolves.toMatchObject({
        workflowId: 'new-destination',
      })
      const calls = vi.mocked(requestJson).mock.calls
      expect(
        calls.map(([contract, request]) => [contract.method, (request.params as { id: string }).id])
      ).toEqual([
        ['GET', 'new-destination'],
        ['PUT', 'new-destination'],
      ])
      expect(calls[1][1].body).toMatchObject({
        expectedRevision: revision,
        variables: {
          limit: { id: 'limit', name: 'Limit', type: 'number', value: 3 },
          odd: { id: 'odd', name: 'Odd', type: 'string', value: 'kept' },
        },
      })
      expect(Object.keys((calls[1][1].body as WorkflowStateContractInput).blocks)).not.toContain(
        'start-1'
      )
    }
  )

  it.each([
    { id: 'other', workspaceId: 'ws-1' },
    { id: 'new-destination', workspaceId: 'other' },
  ])('rejects a snapshot for another destination %j before PUT', async (identity) => {
    apiClientRequestMockFns.mockRequestJson.mockResolvedValue({
      data: { ...identity, draftRevision: 9, state: createLegacyState() },
    })
    await expect(persistImportedWorkflow(input())).rejects.toThrow()
    expect(vi.mocked(requestJson).mock.calls.map(([contract]) => contract.method)).toEqual(['GET'])
  })

  it.each([409, 503])(
    'preserves HTTP %i and never retries or deletes the destination',
    async (status) => {
      const error = new ApiClientError({
        status,
        message: 'Cannot save now',
        body: { error: 'Cannot save now' },
      })
      apiClientRequestMockFns.mockRequestJson.mockImplementation(async (contract) => {
        if (contract === getWorkflowStateContract)
          return {
            data: {
              id: 'new-destination',
              workspaceId: 'ws-1',
              draftRevision: 7,
              state: createLegacyState(),
            },
          }
        throw error
      })
      await expect(persistImportedWorkflow(input())).rejects.toBe(error)
      expect(vi.mocked(requestJson).mock.calls.map(([contract]) => contract.method)).toEqual([
        'GET',
        'PUT',
      ])
    }
  )

  it('owns the import intent and created identity while creation and GET are suspended', async () => {
    const options = input()
    let created!: (value: { id: string }) => void
    let read!: (value: unknown) => void
    const createdResponse = { id: 'new-destination' }
    options.createWorkflow.mockImplementation(
      () =>
        new Promise((resolve) => {
          created = resolve
        })
    )
    apiClientRequestMockFns.mockRequestJson.mockImplementation((contract) => {
      if (contract === getWorkflowStateContract)
        return new Promise((resolve) => {
          read = resolve
        })
      return Promise.resolve({ success: true, baseRevision: 23, draftRevision: 24, warnings: [] })
    })
    const pending = persistImportedWorkflow(options)
    options.content = JSON.stringify({ blocks: {}, edges: [], variables: {} })
    options.workspaceId = 'other-space'
    options.filename = 'changed.json'
    created(createdResponse)
    await vi.waitFor(() => expect(read).toBeTypeOf('function'))
    createdResponse.id = 'other-workflow'
    read({
      data: {
        id: 'new-destination',
        workspaceId: 'ws-1',
        draftRevision: 23,
        state: createLegacyState(),
      },
    })
    await expect(pending).resolves.toMatchObject({
      workflowId: 'new-destination',
      workflowName: 'Wrapped Workflow',
    })
    const request = vi.mocked(requestJson).mock.calls.at(-1)![1]
    expect(request.params).toEqual({ id: 'new-destination' })
    expect(request.body).toMatchObject({ expectedRevision: 23, variables: { limit: { value: 3 } } })
    expect(Object.keys((request.body as WorkflowStateContractInput).blocks)).toHaveLength(1)
  })
})
