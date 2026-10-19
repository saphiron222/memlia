// Copyright 2026 Memlia. All rights reserved.
import { defineConfig } from 'vitest/config'
import nativeConfig from './vitest.config'

/** PostgreSQL reader/writer qualification. No Redis or listening socket server is involved. */
export default defineConfig(async (environment) => {
  const config = await nativeConfig({ ...environment, mode: 'integration' })
  return {
    ...config,
    test: {
      ...config.test,
      setupFiles: ['../sim/vitest.integration.setup.ts'],
      include: [
        'src/database/draft-revision.integration.ts',
        'src/database/workflow-state-snapshot.integration.ts',
      ],
    },
  }
})
