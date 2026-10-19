// Copyright 2026 Memlia. All rights reserved.
// Conservative protection of existing directory-owned identities. Memlia exposes
// no provisioning endpoints; normal membership authorization remains with callers.
import { db } from '@sim/db'
import { scimConnection, scimUser } from '@sim/db/schema'
import { and, eq, sql, type AnyColumn } from 'drizzle-orm'
import { ForbiddenOperationError } from '@/lib/core/application/forbidden'
import type { DbOrTx } from '@/lib/db/types'

export function directoryManagedUserPredicate(organizationId: string, userId: AnyColumn) {
  return sql<boolean>`exists (
    select 1 from ${scimUser}
    inner join ${scimConnection} on ${scimConnection.id} = ${scimUser.connectionId}
    where ${scimConnection.organizationId} = ${organizationId} and ${scimUser.userId} = ${userId}
  )`
}

export function assertInviteeNotDirectoryManaged(input: { managed?: boolean; organizationId?: string }) {
  if (input.managed) throw new ForbiddenOperationError('SCIM_MANAGED_MEMBERSHIP', 'Cette identité est gérée par un annuaire. Une migration explicite est nécessaire.')
}

export async function assertMembershipNotDirectoryManaged(input: { organizationId: string; userId: string; executor?: DbOrTx }) {
  const [managed] = await (input.executor ?? db).select({ id: scimUser.id }).from(scimUser)
    .where(and(eq(scimUser.userId, input.userId), sql`exists (
      select 1 from ${scimConnection} where ${scimConnection.id} = ${scimUser.connectionId}
      and ${scimConnection.organizationId} = ${input.organizationId}
    )`)).limit(1)
  assertInviteeNotDirectoryManaged({ managed: Boolean(managed) })
}
