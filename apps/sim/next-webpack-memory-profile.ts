// Copyright (c) 2026 Memlia. All rights reserved.
/** Build with explicit --webpack; this callback does not configure the default Turbopack engine. */
export function getMemliaWebpackBuildProfile(enabled: boolean) {
  if (!enabled) return {}
  return {
    webpack(config: { cache?: unknown }, { dev }: { dev: boolean }) {
      // Next's documented memory profile replaces the production filesystem cache.
      // https://nextjs.org/docs/app/guides/memory-usage#disable-webpack-cache
      if (config.cache && !dev) config.cache = Object.freeze({ type: 'memory' })
      return config
    },
    // A custom callback otherwise disables Next's automatic separate build worker.
    experimental: { webpackBuildWorker: true },
  }
}
