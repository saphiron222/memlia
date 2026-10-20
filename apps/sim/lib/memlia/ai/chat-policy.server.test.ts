// Copyright 2026 Memlia. All rights reserved.
import { expect, it } from 'vitest'
import { getModelSunsetStatus, getProviderModels } from '@/providers/models'
import { parseChatInstallationPolicy, selectWorkflowReadPolicy } from './chat-policy.server'

const models = {
  openai: getProviderModels('openai').find(
    (model) => getModelSunsetStatus(model) !== 'deprecated'
  )!,
  anthropic: getProviderModels('anthropic').find(
    (model) => getModelSunsetStatus(model) !== 'deprecated'
  )!,
}
function configuration(provider: 'openai' | 'anthropic' = 'openai') {
  return {
    enabled: true,
    provider,
    model: models[provider],
    destination: 'official',
    data: { conversation: true, catalogue: true, workflow: 'catalogue_only' },
  }
}

it.each(['openai', 'anthropic'] as const)(
  'records the exact configured %s model without activating a transport',
  (provider) => {
    const decision = parseChatInstallationPolicy(configuration(provider))
    expect(decision).toEqual({
      ...configuration(provider),
      kind: 'configuration_decision',
      activation: 'blocked',
    })
    expect(models[provider]).toBeTypeOf('string')
    expect(models[provider].length).toBeGreaterThan(0)
  }
)

it.each([
  ['catalogue_only', undefined],
  ['summary_only', { workflowId: 'server-workflow', policy: 'summary_only' }],
  ['sanitized_details', { workflowId: 'server-workflow', policy: 'sanitized_details' }],
] as const)(
  'selects only the server workflow and the configured %s ceiling',
  (workflow, expected) => {
    const input = configuration()
    input.data.workflow = workflow
    const decision = parseChatInstallationPolicy(input)
    expect(selectWorkflowReadPolicy(decision, 'server-workflow')).toEqual(expected)
    expect(selectWorkflowReadPolicy(decision)).toBeUndefined()
    expect(decision.activation).toBe('blocked')
  }
)

it.each([
  undefined,
  null,
  false,
  [],
  '{}',
  {},
  { ...configuration(), enabled: false },
  { ...configuration(), enabled: 'true' },
  { ...configuration(), provider: 'ollama' },
  { ...configuration(), provider: 'anthropic' },
  { ...configuration(), model: 'unregistered-model' },
  { ...configuration(), model: '' },
  { ...configuration(), model: 'x'.repeat(257) },
  { ...configuration(), model: `${models.openai}*` },
  { ...configuration(), model: ` ${models.openai}` },
  { ...configuration(), destination: 'https://model.example.invalid' },
  { ...configuration(), data: { catalogue: true, workflow: 'summary_only' } },
  { ...configuration(), data: { conversation: false, catalogue: true, workflow: 'summary_only' } },
  { ...configuration(), data: { conversation: true, catalogue: false, workflow: 'summary_only' } },
  { ...configuration(), data: { conversation: true, catalogue: true } },
  { ...configuration(), data: { conversation: true, catalogue: true, workflow: 'full' } },
])('refuses incomplete or unsupported configuration without fallback (%#)', (input) => {
  expect(() => parseChatInstallationPolicy(input)).toThrowError(
    'Chat installation policy is unavailable.'
  )
})

it.each(['apiKey', 'baseURL', 'headers', 'endpoint', 'tools', 'limits', 'workflowId', 'principal'])(
  'rejects unrecognized configuration key %s without returning its value',
  (key) => {
    const canary = 'FICTITIOUS_PRIVATE_CONFIGURATION_VALUE'
    expect(() => parseChatInstallationPolicy({ ...configuration(), [key]: canary })).toThrowError(
      new Error('Chat installation policy is unavailable.')
    )
    expect(() =>
      parseChatInstallationPolicy({
        ...configuration(),
        data: { ...configuration().data, [key]: canary },
      })
    ).toThrowError(new Error('Chat installation policy is unavailable.'))
  }
)

it('refuses a deprecated native model instead of substituting another model', () => {
  const retired = getProviderModels('openai').find(
    (model) => getModelSunsetStatus(model) === 'deprecated'
  )
  expect(retired).toBeTypeOf('string')
  expect(() => parseChatInstallationPolicy({ ...configuration(), model: retired })).toThrowError(
    new Error('Chat installation policy is unavailable.')
  )
})

it('holds an immutable decision independent of later configuration edits and other decisions', () => {
  const input = configuration()
  input.data.workflow = 'summary_only'
  const first = parseChatInstallationPolicy(input)
  const second = parseChatInstallationPolicy(configuration('anthropic'))
  input.provider = 'anthropic'
  input.model = models.anthropic
  input.data.workflow = 'sanitized_details'
  expect(first.provider).toBe('openai')
  expect(first.model).toBe(models.openai)
  expect(selectWorkflowReadPolicy(first, 'first-workflow')).toEqual({
    workflowId: 'first-workflow',
    policy: 'summary_only',
  })
  expect(second.provider).toBe('anthropic')
  expect(selectWorkflowReadPolicy(second, 'second-workflow')).toBeUndefined()
  expect(Reflect.set(first, 'model', models.anthropic)).toBe(false)
  expect(Reflect.set(first.data, 'workflow', 'sanitized_details')).toBe(false)
  const selected = selectWorkflowReadPolicy(first, 'first-workflow')!
  expect(Reflect.set(selected, 'workflowId', 'foreign-workflow')).toBe(false)
})

it.each([null, '', 42, 'x'.repeat(513), { workflowId: 'client', model: models.anthropic }])(
  'refuses an invalid server workflow identifier without accepting request options (%#)',
  (id) => {
    const policy = parseChatInstallationPolicy(configuration())
    expect(() => selectWorkflowReadPolicy(policy, id)).toThrowError(
      new Error('Chat installation policy is unavailable.')
    )
  }
)

it('does not silently truncate the maximum server workflow identifier', () => {
  const input = configuration()
  input.data.workflow = 'summary_only'
  expect(selectWorkflowReadPolicy(parseChatInstallationPolicy(input), 'x'.repeat(512))).toEqual({
    workflowId: 'x'.repeat(512),
    policy: 'summary_only',
  })
})

it.each(['apiKey', 'baseURL', 'modelOverride', 'policy', 'systemPrompt', 'tools'])(
  'refuses a decision extended by caller-owned %s options',
  (key) => {
    const policy = parseChatInstallationPolicy(configuration())
    expect(() =>
      selectWorkflowReadPolicy({ ...policy, [key]: 'FICTITIOUS_VALUE' }, 'server')
    ).toThrowError(new Error('Chat installation policy is unavailable.'))
  }
)

it('refuses an allegedly active or unparsed decision instead of treating it as authorization', () => {
  const policy = parseChatInstallationPolicy(configuration())
  for (const input of [undefined, configuration(), { ...policy, activation: 'ready' }])
    expect(() => selectWorkflowReadPolicy(input, 'server')).toThrowError(
      new Error('Chat installation policy is unavailable.')
    )
})

it('refuses accessors without evaluating them or leaking arbitrary thrown values', () => {
  let reads = 0
  const input = configuration()
  Object.defineProperty(input, 'model', {
    enumerable: true,
    get() {
      reads++
      throw new Error('FICTITIOUS_PRIVATE_GETTER_VALUE')
    },
  })
  expect(() => parseChatInstallationPolicy(input)).toThrowError(
    new Error('Chat installation policy is unavailable.')
  )
  expect(reads).toBe(0)
})

it('refuses hidden keys, symbols and inherited configuration fields', () => {
  const hidden = configuration()
  Object.defineProperty(hidden, 'apiKey', { value: 'FICTITIOUS_PRIVATE_VALUE' })
  const symbol = { ...configuration(), [Symbol('private')]: 'FICTITIOUS_PRIVATE_VALUE' }
  for (const value of [hidden, symbol, Object.create(configuration())])
    expect(() => parseChatInstallationPolicy(value)).toThrowError(
      new Error('Chat installation policy is unavailable.')
    )
})

it('does not evaluate a nested permission getter during either decision operation', () => {
  let reads = 0
  const input = configuration()
  Object.defineProperty(input.data, 'workflow', {
    enumerable: true,
    get() {
      reads++
      return 'sanitized_details'
    },
  })
  for (const run of [
    () => parseChatInstallationPolicy(input),
    () =>
      selectWorkflowReadPolicy(
        { ...input, kind: 'configuration_decision', activation: 'blocked' },
        'server'
      ),
  ])
    expect(run).toThrowError(new Error('Chat installation policy is unavailable.'))
  expect(reads).toBe(0)
})

it('uses fixed errors even when an object inspection throws', () => {
  const input = new Proxy(configuration(), {
    getPrototypeOf() {
      throw new Error('FICTITIOUS_PRIVATE_PROXY_VALUE')
    },
  })
  expect(() => parseChatInstallationPolicy(input)).toThrowError(
    new Error('Chat installation policy is unavailable.')
  )
  expect(() => selectWorkflowReadPolicy(input, 'server')).toThrowError(
    new Error('Chat installation policy is unavailable.')
  )
})

it('accepts plain JSON records without requiring a prototype or altering selected data', () => {
  const input = Object.assign(Object.create(null), configuration())
  input.data = Object.assign(Object.create(null), input.data)
  const decision = parseChatInstallationPolicy(input)
  expect(decision.model).toBe(models.openai)
  expect(decision.data.workflow).toBe('catalogue_only')
  expect(decision.activation).toBe('blocked')
})

// A wrong backend/window selection would let the HTTP composer choose a worker
// or budget that the installation administrator did not explicitly select.
function localConfiguration() {
  return {
    ...configuration(),
    localBackend: {
      kind: 'memlia_local_chat',
      version: 1,
      budgetWindow: { id: 'cabinet_chat_v1', version: 7 },
    },
  }
}
it('captures the exact local backend and window without authorizing a transport', () => {
  const input = localConfiguration()
  input.data.workflow = 'summary_only'
  const result = parseChatInstallationPolicy(input)
  expect(result).toEqual({
    ...input,
    kind: 'configuration_decision',
    activation: 'blocked',
  })
  expect(selectWorkflowReadPolicy(result, 'server-workflow')).toEqual({
    workflowId: 'server-workflow',
    policy: 'summary_only',
  })
  input.localBackend.budgetWindow.id = 'later_window'
  input.localBackend.budgetWindow.version = 99
  expect(result.localBackend).toEqual({
    kind: 'memlia_local_chat',
    version: 1,
    budgetWindow: { id: 'cabinet_chat_v1', version: 7 },
  })
  expect(Object.isFrozen(result.localBackend)).toBe(true)
  expect(Object.isFrozen(result.localBackend!.budgetWindow)).toBe(true)
})
it.each([
  undefined,
  null,
  {},
  { kind: 'worker', version: 1, budgetWindow: { id: 'window', version: 1 } },
  { kind: 'memlia_local_chat', version: 2, budgetWindow: { id: 'window', version: 1 } },
  { kind: 'memlia_local_chat', version: 1 },
  { kind: 'memlia_local_chat', version: 1, budgetWindow: null },
  { kind: 'memlia_local_chat', version: 1, budgetWindow: { id: '', version: 1 } },
  { kind: 'memlia_local_chat', version: 1, budgetWindow: { id: ' window', version: 1 } },
  { kind: 'memlia_local_chat', version: 1, budgetWindow: { id: 'w'.repeat(129), version: 1 } },
  ...[0, -1, 1.5, '1', 2147483648].map((version) => ({
    kind: 'memlia_local_chat',
    version: 1,
    budgetWindow: { id: 'window', version },
  })),
  {
    kind: 'memlia_local_chat',
    version: 1,
    budgetWindow: { id: 'window', version: 1, userId: 'foreign' },
  },
  {
    kind: 'memlia_local_chat',
    version: 1,
    budgetWindow: { id: 'window', version: 1 },
    apiKey: 'FICTITIOUS_KEY',
  },
])('rejects a present malformed local backend instead of falling back (%#)', (localBackend) => {
  expect(() => parseChatInstallationPolicy({ ...configuration(), localBackend })).toThrowError(
    new Error('Chat installation policy is unavailable.')
  )
})
it('selects the strict Anthropic local backend and its server-only API workspace', () => {
  const decision = parseChatInstallationPolicy({
    ...localConfiguration(),
    provider: 'anthropic',
    model: 'claude-haiku-4-5',
    anthropicWorkspaceId: 'wrkspc_Fictitious1234',
  })
  expect(decision).toMatchObject({
    provider: 'anthropic',
    model: 'claude-haiku-4-5',
    activation: 'blocked',
    anthropicWorkspaceId: 'wrkspc_Fictitious1234',
  })
})
it('refuses nested backend accessors and hidden authority without evaluating them', () => {
  let reads = 0
  for (const level of ['localBackend', 'budgetWindow'] as const) {
    const input = localConfiguration()
    const target = level === 'localBackend' ? input.localBackend : input.localBackend.budgetWindow
    Object.defineProperty(target, level === 'localBackend' ? 'kind' : 'id', {
      enumerable: true,
      get() {
        reads++
        throw new Error('FICTITIOUS_PRIVATE_GETTER')
      },
    })
    expect(() => parseChatInstallationPolicy(input)).toThrowError(
      new Error('Chat installation policy is unavailable.')
    )
  }
  for (const decorate of [
    (value: object) => Object.defineProperty(value, 'apiKey', { value: 'FICTITIOUS_PRIVATE' }),
    (value: object) => Object.assign(value, { [Symbol('authority')]: 'FICTITIOUS_PRIVATE' }),
  ]) {
    const input = localConfiguration()
    decorate(input.localBackend.budgetWindow)
    expect(() => parseChatInstallationPolicy(input)).toThrowError(
      new Error('Chat installation policy is unavailable.')
    )
  }
  expect(reads).toBe(0)
})

it.each([
  '',
  'workspace',
  'wrkspc_short',
  'wrkspc_Fictitious1234\r\nx-test: value',
  null,
  undefined,
])(
  'refuses malformed server API workspace without changing provider selection (%#)',
  (anthropicWorkspaceId) => {
    expect(() =>
      parseChatInstallationPolicy({
        ...localConfiguration(),
        provider: 'anthropic',
        model: 'claude-haiku-4-5',
        anthropicWorkspaceId,
      })
    ).toThrow('Chat installation policy is unavailable.')
  }
)
it('refuses Anthropic workspace on OpenAI before any credentials or transport', () => {
  expect(() =>
    parseChatInstallationPolicy({
      ...localConfiguration(),
      anthropicWorkspaceId: 'wrkspc_Fictitious1234',
    })
  ).toThrow('Chat installation policy is unavailable.')
})
