// Copyright (c) 2026 Memlia. All rights reserved.
import { createAgentCaptureHttpHandlers } from '@/lib/desktop-automation/agent-capture-http'
import { getEnrollmentOrigin } from '@/lib/desktop-automation/enrollment-runtime'
export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'
const handlers = createAgentCaptureHttpHandlers({
  getOrigin: getEnrollmentOrigin,
  getService: async () => {
    const { createAgentControlService } = await import(
      '@/lib/desktop-automation/agent-control-service'
    )
    return createAgentControlService()
  },
})
export const GET = handlers.GET
export const POST = handlers.POST
