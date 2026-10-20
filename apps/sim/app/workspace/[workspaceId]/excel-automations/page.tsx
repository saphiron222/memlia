// Copyright (c) 2026 Memlia. All rights reserved.
import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import { getSession } from '@/lib/auth'
import { ExcelAutomations } from './excel-automations'

export const metadata: Metadata = { title: 'Automatiser Excel', robots: { index: false } }

export default async function ExcelAutomationsPage({
  params,
}: {
  params: Promise<{ workspaceId: string }>
}) {
  // Pages and their authenticated layout resolve concurrently. Never prefetch as an anonymous user.
  const session = await getSession()
  if (!session?.user?.id) redirect('/login')
  const { workspaceId } = await params
  return <ExcelAutomations workspaceId={workspaceId} userId={session.user.id} />
}
