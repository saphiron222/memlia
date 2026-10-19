// Copyright (c) 2026 Memlia. All rights reserved.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { getMemliaWebpackBuildProfile } from './next-webpack-memory-profile'

test('disabled profile adds neither a Webpack callback nor a worker override', () => {
  assert.deepEqual(getMemliaWebpackBuildProfile(false), {})
})

test('production cache replacement preserves the rest of the compiler configuration', () => {
  const profile = getMemliaWebpackBuildProfile(true)
  assert.ok(profile.webpack)
  const cache = {
    type: 'filesystem',
    maxMemoryGenerations: Number.POSITIVE_INFINITY,
    cacheDirectory: '/fixture/cache',
  }
  const plugins = [Object.freeze({ fixture: 'plugin' })]
  const config = { cache, plugins, mode: 'production', name: 'server' }
  assert.equal(profile.webpack(config, { dev: false }), config)
  assert.deepEqual(config.cache, { type: 'memory' })
  assert.equal(Object.isFrozen(config.cache), true)
  assert.equal(Reflect.set(config.cache, 'maxGenerations', 1), false)
  assert.equal(config.plugins, plugins)
  assert.equal(config.mode, 'production')
  assert.equal(config.name, 'server')
  assert.equal(cache.type, 'filesystem')
})

test('development keeps its original cache even when the local build profile is enabled', () => {
  const profile = getMemliaWebpackBuildProfile(true)
  assert.ok(profile.webpack)
  const cache = { type: 'filesystem', maxMemoryGenerations: 0 }
  const config = Object.freeze({ cache })
  assert.equal(profile.webpack(config, { dev: true }), config)
  assert.equal(config.cache, cache)
})

test('disabled and absent caches are not turned back on', () => {
  const profile = getMemliaWebpackBuildProfile(true)
  assert.ok(profile.webpack)
  for (const config of [Object.freeze({ cache: false }), Object.freeze({})]) {
    assert.equal(profile.webpack(config, { dev: false }), config)
  }
})

test('the custom callback opts into the existing separate Webpack build worker', () => {
  const profile = getMemliaWebpackBuildProfile(true)
  assert.equal(typeof profile.webpack, 'function')
  assert.equal(profile.experimental?.webpackBuildWorker, true)
})
