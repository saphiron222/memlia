// Copyright 2026 Memlia. All rights reserved.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_PERMISSION_GROUP_CONFIG } from './fields'
const mocks = vi.hoisted(() => ({ config: vi.fn(), organization: vi.fn(), membership: vi.fn() }))
vi.mock('@/lib/permission-groups/resolve.server', () => ({
  getUserPermissionConfig: mocks.config, getUserPermissionConfigForOrganization: mocks.organization,
  mergeEnvAllowlist: () => ({ allowedIntegrations: [] }), resolveVerifiedUserAccessControlContext: vi.fn(),
}))
vi.mock('@/lib/billing/organizations/membership', () => ({ getUserOrganization: mocks.membership }))
vi.mock('@/lib/permission-groups/block-access', () => ({ isBlockTypeAccessControlExempt: (type: string) => type === 'start_trigger' }))
vi.mock('@/providers/models', () => ({ findProviderFromModel: (model: string) => model.startsWith('gpt-') ? 'openai' : null }))
import {
  assertPermissionsAllowed, validateBlockType, validateModelProvider, validateInvitationsAllowed,
  validatePublicApiAllowed, validateChatDeployAuth, validatePublicFileSharing,
  IntegrationNotAllowedError, ToolNotAllowedError, ModelNotAllowedError, ProviderNotAllowedError,
  InvitationsNotAllowedError, CustomToolsNotAllowedError, McpToolsNotAllowedError, SkillsNotAllowedError,
} from './permission-check'
beforeEach(() => {
  vi.clearAllMocks()
  mocks.config.mockResolvedValue({ ...DEFAULT_PERMISSION_GROUP_CONFIG })
  mocks.organization.mockResolvedValue({ ...DEFAULT_PERMISSION_GROUP_CONFIG })
  mocks.membership.mockResolvedValue({ organizationId: 'org-a' })
})
describe('gardes Memlia avec les règles Apache', () => {
  it('charge le groupe du bon utilisateur et espace', async () => {
    await validateBlockType('user-a', 'space-a', 'slack_v2')
    expect(mocks.config).toHaveBeenCalledWith('user-a', 'space-a', undefined)
  })
  it('refuse une intégration absente et accepte son successeur canonique', async () => {
    mocks.config.mockResolvedValue({ ...DEFAULT_PERMISSION_GROUP_CONFIG, allowedIntegrations: ['slack'] })
    await expect(validateBlockType('u', 'w', 'slack_v2')).resolves.toBeUndefined()
    await expect(validateBlockType('u', 'w', 'gmail')).rejects.toBeInstanceOf(IntegrationNotAllowedError)
  })
  it('une allowlist vide refuse les intégrations mais conserve le point d’entrée natif', async () => {
    mocks.config.mockResolvedValue({ ...DEFAULT_PERMISSION_GROUP_CONFIG, allowedIntegrations: [] })
    await expect(validateBlockType('u', 'w', 'slack')).rejects.toBeInstanceOf(IntegrationNotAllowedError)
    await expect(validateBlockType('u', 'w', 'start_trigger')).resolves.toBeUndefined()
  })
  it('ne convertit jamais une panne du résolveur en autorisation', async () => {
    mocks.config.mockRejectedValue(new Error('lookup failed'))
    await expect(validateModelProvider('u', 'w', 'gpt-test')).rejects.toThrow('lookup failed')
  })
  it('applique la denylist de modèles et la liste de fournisseurs', async () => {
    mocks.config.mockResolvedValue({ ...DEFAULT_PERMISSION_GROUP_CONFIG, deniedModels: ['gpt-test'] })
    await expect(validateModelProvider('u', 'w', 'GPT-test')).rejects.toBeInstanceOf(ModelNotAllowedError)
    mocks.config.mockResolvedValue({ ...DEFAULT_PERMISSION_GROUP_CONFIG, allowedModelProviders: [] })
    await expect(validateModelProvider('u', 'w', 'gpt-test')).rejects.toBeInstanceOf(ProviderNotAllowedError)
  })
  it.each([
    ['custom', 'disableCustomTools', CustomToolsNotAllowedError],
    ['mcp', 'disableMcpTools', McpToolsNotAllowedError],
    ['skill', 'disableSkills', SkillsNotAllowedError],
  ] as const)('refuse la catégorie %s désactivée', async (toolKind, key, error) => {
    mocks.config.mockResolvedValue({ ...DEFAULT_PERMISSION_GROUP_CONFIG, [key]: true })
    await expect(assertPermissionsAllowed({ userId: 'u', workspaceId: 'w', toolKind })).rejects.toBeInstanceOf(error)
  })
  it('refuse un outil précis même si sa catégorie est disponible', async () => {
    mocks.config.mockResolvedValue({ ...DEFAULT_PERMISSION_GROUP_CONFIG, deniedTools: ['slack_send'] })
    await expect(assertPermissionsAllowed({ userId: 'u', workspaceId: 'w', toolId: 'slack_send' })).rejects.toBeInstanceOf(ToolNotAllowedError)
  })
  it('propage la transaction aux invitations et refuse leur désactivation', async () => {
    mocks.organization.mockResolvedValue({ ...DEFAULT_PERMISSION_GROUP_CONFIG, disableInvitations: true })
    const tx = {} as Parameters<typeof validateInvitationsAllowed>[2]
    await expect(validateInvitationsAllowed('u', { organizationId: 'org-b' }, tx)).rejects.toBeInstanceOf(InvitationsNotAllowedError)
    expect(mocks.organization).toHaveBeenCalledWith('org-b', tx)
  })
  it('refuse l’API publique, le partage et les modes non autorisés', async () => {
    mocks.config.mockResolvedValue({ ...DEFAULT_PERMISSION_GROUP_CONFIG, disablePublicApi: true, disablePublicFileSharing: true, allowedChatDeployAuthTypes: ['password'] })
    await expect(validatePublicApiAllowed('u', 'w')).rejects.toMatchObject({ code: 'forbidden' })
    await expect(validatePublicFileSharing('u', 'w', 'public')).rejects.toMatchObject({ detailCode: 'PUBLIC_SHARING_NOT_ALLOWED' })
    await expect(validateChatDeployAuth('u', 'w', 'public')).rejects.toMatchObject({ detailCode: 'CHAT_AUTH_MODE_NOT_PERMITTED' })
    await expect(validateChatDeployAuth('u', 'w', 'password')).resolves.toBeUndefined()
  })
  it('conserve la contrainte de déploiement pour un exécuteur sans utilisateur', async () => {
    await expect(validateBlockType(undefined, 'w', 'slack')).rejects.toBeInstanceOf(IntegrationNotAllowedError)
    expect(mocks.config).not.toHaveBeenCalled()
  })
  it('charge le groupe organisationnel pour une action personnelle sans espace', async () => {
    await validateModelProvider('u', undefined, 'gpt-test')
    expect(mocks.membership).toHaveBeenCalledWith('u')
    expect(mocks.organization).toHaveBeenCalledWith('org-a', undefined)
  })
  it('honore une annulation avant la lecture des droits', async () => {
    const controller = new AbortController(); controller.abort()
    await expect(assertPermissionsAllowed({ userId: 'u', workspaceId: 'w', signal: controller.signal })).rejects.toThrow()
    expect(mocks.config).not.toHaveBeenCalled()
  })
})
