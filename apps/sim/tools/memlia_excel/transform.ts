// Copyright (c) 2026 Memlia. All rights reserved.
import type { InternalToolConfig, ToolResponse } from '@/tools/types'

/** A native workflow tool. This descriptor contains no worker runtime or user authority. */
export const memliaExcelTransformTool: InternalToolConfig<{ request: unknown }, ToolResponse> = {
  id: 'memlia_excel_transform',
  name: 'Memlia Excel Transform',
  description:
    'Prepare a new Excel execution file from a canonical procedure and authorized workspace source files. Requires an operator-configured isolated worker.',
  version: '1.0.0',
  params: {
    request: {
      type: 'object',
      required: true,
      visibility: 'user-only',
      description:
        'Canonical Excel procedure, source file selections, and new output name. No runtime or execution identity.',
    },
  },
  operation: { input: (params) => params.request },
  transformResponse: async (response) => {
    const data = await response.json()
    if (!response.ok || data.success !== true) {
      return {
        success: false,
        output: {},
        error: response.status === 503 ? 'excel_tool_unavailable' : 'excel_tool_refused',
        retryable: false,
      }
    }
    return { success: true, output: data.output }
  },
  outputs: {
    file: {
      type: 'file',
      description: 'New execution file; publication revalidates source and authority.',
    },
  },
}
