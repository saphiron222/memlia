// Copyright 2026 Memlia. All rights reserved.
import { noInputSchema } from '@/lib/api/contracts/primitives'
import { defineRouteContract } from '@/lib/api/contracts/types'
import { workflowIdParamsSchema } from '@/lib/api/contracts/workflows'
import { privateCopyContract } from '@/app/api/v2/workflows/[workflowId]/private-copy/contracts'

export const internalPrivateCopyContract = defineRouteContract({
  method: 'POST',
  path: '/api/workflows/[id]/private-copy',
  params: workflowIdParamsSchema,
  query: noInputSchema,
  body: privateCopyContract.body,
  response: privateCopyContract.response,
})
