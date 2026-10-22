// Copyright (c) 2026 Memlia. All rights reserved.
import type { OfficeBackupBody } from '@/lib/api/contracts/excel-office-backups'
import { OrchestrationError } from '@/lib/core/orchestration/types'
import { persistOfficeCompressedCopy } from '@/lib/memlia/excel/office/backup.server'
import { loadActiveWorkspaceContext } from '@/lib/uploads/contexts/workspace/file-manager'
import { defineAuthorizedWorkspaceFileUseCase } from '@/lib/workspace-files/application/authorized-workspace-file-use-case'
import { fileOperations } from '@/lib/workspace-files/application/operations'

export const storeOfficeBackup = defineAuthorizedWorkspaceFileUseCase({
  operation: fileOperations.create,
  async resolveContext({ input }: { input: OfficeBackupBody & { workspaceId: string } }) {
    const context = await loadActiveWorkspaceContext(input.workspaceId)
    if (!context || context.workspaceId !== input.workspaceId) {
      throw new OrchestrationError('not_found', 'Workspace not found')
    }
    return context
  },
  async execute({ principal, input, request }) {
    return persistOfficeCompressedCopy(
      principal,
      {
        workspaceId: input.workspaceId,
        copyVersion: input.copyVersion,
        bytes: Buffer.from(input.contentBase64, 'base64'),
      },
      request?.signal
    )
  },
})
