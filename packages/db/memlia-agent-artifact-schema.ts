// Copyright (c) 2026 Memlia. All rights reserved.
import { sql } from 'drizzle-orm'
import { boolean, check, foreignKey, integer, pgTable, primaryKey, text } from 'drizzle-orm/pg-core'
import { memliaDesktopAgentCommand } from './memlia-agent-schema'

/** Private bytes belong to a command, never to a public URL or filesystem path.
 * The migration defers the command FK until commit: server-authored manifests
 * and the browser intent are created atomically, in that order.
 */
export const memliaDesktopAgentArtifact = pgTable(
  'memlia_desktop_agent_artifact',
  {
    commandId: text('command_id').notNull(),
    artifactId: text('artifact_id').notNull(),
    sha256: text('sha256').notNull(),
    origin: text('origin').notNull(),
    totalBytes: integer('total_bytes').notNull(),
    nextOffset: integer('next_offset').notNull().default(0),
    complete: boolean('complete').notNull().default(false),
  },
  (t) => [
    primaryKey({ columns: [t.commandId, t.artifactId] }),
    foreignKey({
      name: 'memlia_agent_artifact_command_fk',
      columns: [t.commandId],
      foreignColumns: [memliaDesktopAgentCommand.id],
    }).onDelete('cascade'),
    check('memlia_agent_artifact_digest', sql`${t.sha256} ~ '^sha256:[a-f0-9]{64}$'`),
    check('memlia_agent_artifact_origin', sql`${t.origin} IN ('server','agent')`),
    check(
      'memlia_agent_artifact_bounds',
      sql`${t.totalBytes} BETWEEN 0 AND 34603008 AND ${t.nextOffset} BETWEEN 0 AND ${t.totalBytes} AND (${t.complete} = (${t.nextOffset} = ${t.totalBytes}))`
    ),
  ]
)

export const memliaDesktopAgentArtifactChunk = pgTable(
  'memlia_desktop_agent_artifact_chunk',
  {
    commandId: text('command_id').notNull(),
    artifactId: text('artifact_id').notNull(),
    offset: integer('offset').notNull(),
    byteCount: integer('byte_count').notNull(),
    dataBase64: text('data_base64').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.commandId, t.artifactId, t.offset] }),
    foreignKey({
      name: 'memlia_agent_artifact_chunk_fk',
      columns: [t.commandId, t.artifactId],
      foreignColumns: [memliaDesktopAgentArtifact.commandId, memliaDesktopAgentArtifact.artifactId],
    }).onDelete('cascade'),
    check(
      'memlia_agent_artifact_chunk_bounds',
      sql`${t.offset} BETWEEN 0 AND 34603008 AND ${t.offset} % 262144 = 0 AND ${t.byteCount} BETWEEN 0 AND 262144 AND octet_length(${t.dataBase64}) <= 349528 AND octet_length(decode(${t.dataBase64}, 'base64')) = ${t.byteCount}`
    ),
  ]
)
