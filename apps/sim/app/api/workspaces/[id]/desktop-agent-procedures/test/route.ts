// Copyright (c) 2026 Memlia. All rights reserved.
import { createAgentProcedureHttpHandlers } from '@/lib/desktop-automation/agent-procedure-http'
import { getEnrollmentOrigin } from '@/lib/desktop-automation/enrollment-runtime'
export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'
const handlers = createAgentProcedureHttpHandlers({
  getOrigin: getEnrollmentOrigin,
  getService: async () => {
    const { createAgentControlService } = await import(
      '@/lib/desktop-automation/agent-control-service'
    )
    return createAgentControlService()
  },
})
export const POST = handlers.TEST
