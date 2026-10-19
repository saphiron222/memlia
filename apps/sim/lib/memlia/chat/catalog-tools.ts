// Copyright (c) 2026 Memlia. All rights reserved.

import { z } from 'zod'
import {
  v2BlockDetailSchema,
  v2BlockSummarySchema,
  v2GetBlockParamsSchema,
  v2GetToolParamsSchema,
  v2ListBlocksQuerySchema,
  v2ListToolsQuerySchema,
  v2ToolDetailSchema,
  v2ToolSummarySchema,
} from '@/lib/api/contracts/v2/catalog'
import { getCatalogBlock } from '@/lib/catalog/application/get-block'
import { getCatalogTool } from '@/lib/catalog/application/get-tool'
import { listCatalogBlocks } from '@/lib/catalog/application/list-blocks'
import { listCatalogTools } from '@/lib/catalog/application/list-tools'
import { OrchestrationError } from '@/lib/core/orchestration/types'

const offset = z.number().int().min(0).max(10_000).default(0)

/** Native catalogue schemas narrowed to model-owned filters, not identity or workspace. */
export const catalogToolInputs = Object.freeze({
  list_blocks: v2ListBlocksQuerySchema.omit({ workspaceId: true, cursor: true }).extend({ offset }),
  get_block: v2GetBlockParamsSchema.strict(),
  list_tools: v2ListToolsQuerySchema.omit({ workspaceId: true, cursor: true }).extend({ offset }),
  get_tool: v2GetToolParamsSchema.strict(),
})

interface CatalogToolsContext {
  principal: Parameters<typeof listCatalogBlocks.execute>[0]['principal']
  workspaceId: string
}

/** Binds native catalogue reads to server-owned authority; model arguments cannot select it. */
export function createCatalogTools({ principal, workspaceId }: CatalogToolsContext) {
  async function read(toolId: string, params: unknown) {
    switch (toolId) {
      case 'list_blocks': {
        const page = await listCatalogBlocks.execute({
          principal,
          input: { ...parseInput(catalogToolInputs.list_blocks, params), workspaceId },
        })
        return { ...page, entries: z.array(v2BlockSummarySchema).parse(page.entries) }
      }
      case 'get_block': {
        const { block } = await getCatalogBlock.execute({
          principal,
          input: { ...parseInput(catalogToolInputs.get_block, params), workspaceId },
        })
        return { block: v2BlockDetailSchema.parse(block) }
      }
      case 'list_tools': {
        const page = await listCatalogTools.execute({
          principal,
          input: { ...parseInput(catalogToolInputs.list_tools, params), workspaceId },
        })
        return { ...page, entries: z.array(v2ToolSummarySchema).parse(page.entries) }
      }
      case 'get_tool': {
        const { tool } = await getCatalogTool.execute({
          principal,
          input: { ...parseInput(catalogToolInputs.get_tool, params), workspaceId },
        })
        return { tool: v2ToolDetailSchema.parse(tool) }
      }
      default:
        throw new CatalogToolError('tool_not_allowed')
    }
  }

  return {
    async dispatch(toolId: string, params: unknown, signal?: AbortSignal) {
      try {
        const data = await abortable(() => read(toolId, params), signal)
        if (signal?.aborted) return failure('cancelled')
        if (Buffer.byteLength(JSON.stringify(data), 'utf8') > 256 * 1024)
          return failure('result_too_large')
        return { ok: true as const, data }
      } catch (error) {
        if (error instanceof CatalogToolError) return failure(error.code)
        if (error instanceof OrchestrationError && error.code === 'forbidden')
          return failure('forbidden')
        if (error instanceof OrchestrationError && error.code === 'not_found')
          return failure('not_found')
        return failure('unavailable')
      }
    },
  }
}

function parseInput<T>(schema: z.ZodType<T>, params: unknown): T {
  const parsed = schema.safeParse(params)
  if (!parsed.success) throw new CatalogToolError('invalid_input')
  return parsed.data
}

/** Cancels delivery; existing use cases do not accept an AbortSignal for their DB reads. */
function abortable<T>(read: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return read()
  if (signal.aborted) return Promise.reject(new CatalogToolError('cancelled'))
  return new Promise((resolve, reject) => {
    const cancelled = () => {
      signal.removeEventListener('abort', cancelled)
      reject(new CatalogToolError('cancelled'))
    }
    signal.addEventListener('abort', cancelled, { once: true })
    read().then(
      (result) => {
        signal.removeEventListener('abort', cancelled)
        resolve(result)
      },
      (error) => {
        signal.removeEventListener('abort', cancelled)
        reject(error)
      }
    )
  })
}

type FailureCode =
  | 'tool_not_allowed'
  | 'invalid_input'
  | 'forbidden'
  | 'not_found'
  | 'unavailable'
  | 'cancelled'
  | 'result_too_large'

class CatalogToolError extends Error {
  constructor(readonly code: FailureCode) {
    super('Catalog read could not complete.')
  }
}

function failure(code: FailureCode) {
  return { ok: false as const, error: { code, message: 'Catalog read could not complete.' } }
}
