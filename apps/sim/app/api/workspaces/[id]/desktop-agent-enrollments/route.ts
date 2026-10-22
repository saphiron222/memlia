// Copyright (c) 2026 Memlia. All rights reserved.
import { createEnrollmentHttpHandlers } from '@/lib/desktop-automation/enrollment-http'
import {
  getEnrollmentOrigin,
  getEnrollmentService,
} from '@/lib/desktop-automation/enrollment-runtime'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'
export const POST = createEnrollmentHttpHandlers({
  getService: getEnrollmentService,
  getOrigin: getEnrollmentOrigin,
}).create
