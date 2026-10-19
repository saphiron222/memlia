// Copyright 2026 Memlia. All rights reserved.
// Enterprise-only UI modules are absent. Their Apache APIs remain available
// where retained; this list must shrink as independent Memlia screens are delivered.
const UNPORTED_SETTINGS = new Set([
  'access-control', 'audit-logs', 'sso', 'data-retention', 'data-drains',
  'usage', 'whitelabeling', 'forks', 'requests', 'custom-blocks', 'connected-accounts',
])
export function isUnportedSetting(section: string): boolean {
  return UNPORTED_SETTINGS.has(section)
}
