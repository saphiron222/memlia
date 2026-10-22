// Copyright (c) 2026 Memlia. All rights reserved.
import { getBaseUrl } from '@/lib/core/utils/urls'
import { createOfficeAddinManifest } from '@/lib/memlia/excel/office/manifest'

export const dynamic = 'force-dynamic'

/** The same generic add-in points to this cabinet's configured HTTPS application. */
export function GET() {
  try {
    return new Response(createOfficeAddinManifest(getBaseUrl()), {
      headers: {
        'Content-Type': 'application/xml; charset=utf-8',
        'Content-Disposition': 'attachment; filename="memlia-excel.xml"',
        'Cache-Control': 'private, no-store',
      },
    })
  } catch {
    return Response.json(
      { error: 'office_manifest_unavailable' },
      { status: 503, headers: { 'Cache-Control': 'private, no-store' } }
    )
  }
}
