// Copyright 2026 Memlia. All rights reserved.
import { sql } from 'drizzle-orm'
import { type AnyPgColumn, check, index, pgTable, text, timestamp } from 'drizzle-orm/pg-core'
import { user, workflow } from './schema'

/** Private-copy provenance; source identity is historical, never an access grant or live binding. */
export const memliaWorkflowCopy = pgTable(
  'memlia_workflow_copy',
  {
    workflowId: text('workflow_id')
      .primaryKey()
      .references((): AnyPgColumn => workflow.id, { onDelete: 'cascade' }),
    sourceWorkflowId: text('source_workflow_id').notNull(),
    sourceStateDigest: text('source_state_digest').notNull(),
    createdByUserId: text('created_by_user_id').references((): AnyPgColumn => user.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check(
      'memlia_workflow_copy_source_digest_sha256',
      sql`${table.sourceStateDigest} ~ '^[a-f0-9]{64}$'`
    ),
    index('memlia_workflow_copy_created_by_idx').on(table.createdByUserId),
  ]
)
