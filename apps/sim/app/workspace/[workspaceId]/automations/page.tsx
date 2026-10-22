// Copyright (c) 2026 Memlia. All rights reserved.
import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import { getSession } from '@/lib/auth'
import { SoftwareAutomations } from './automations'

export const metadata: Metadata = { title: 'Automatiser un logiciel', robots: { index: false } }

export default async function SoftwareAutomationsPage({
  params,
}: {
  params: Promise<{ workspaceId: string }>
}) {
  const session = await getSession()
  if (!session?.user?.id) redirect('/login')
  const { workspaceId } = await params
  return <SoftwareAutomations workspaceId={workspaceId} userId={session.user.id} />
}
