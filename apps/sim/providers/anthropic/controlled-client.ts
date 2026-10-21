// Copyright (c) 2026 Memlia. All rights reserved.

import Anthropic from '@anthropic-ai/sdk'

export function createControlledAnthropicClient(
  apiKey: string,
  anthropicWorkspaceId?: string
): Anthropic {
  // The SDK always merges this environment variable, even with explicit options.
  if (
    typeof apiKey !== 'string' ||
    !apiKey.trim() ||
    process.env.ANTHROPIC_CUSTOM_HEADERS ||
    (anthropicWorkspaceId !== undefined &&
      (typeof anthropicWorkspaceId !== 'string' ||
        !/^wrkspc_[A-Za-z0-9]{8,100}$/.test(anthropicWorkspaceId)))
  )
    throw new Error('Controlled Anthropic transport is unavailable.')
  try {
    // Native validation before the SDK can echo an invalid header value in an error.
    new Headers({ 'x-api-key': apiKey })
    return new Anthropic({
      apiKey,
      baseURL: 'https://api.anthropic.com',
      authToken: null,
      webhookKey: null,
      logLevel: 'off',
      maxRetries: 0,
      fetchOptions: { redirect: 'error' },
      ...(anthropicWorkspaceId === undefined
        ? {}
        : {
            defaultHeaders: { 'anthropic-workspace-id': anthropicWorkspaceId },
          }),
    })
  } catch {
    throw new Error('Controlled Anthropic transport is unavailable.')
  }
}
