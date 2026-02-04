import { describe, it, expectTypeOf } from 'vitest';
import type { PermissionMode, AgentType, LastUsage } from '../../../opencode/src/types.js';

describe('types', () => {
  it('PermissionMode matches expected union', () => {
    expectTypeOf<PermissionMode>().toMatchTypeOf<'plan' | 'default' | 'bypassPermissions'>();
  });

  it('AgentType matches expected union', () => {
    expectTypeOf<AgentType>().toMatchTypeOf<'plan' | 'build' | 'explore'>();
  });

  it('LastUsage includes model and tokens', () => {
    expectTypeOf<LastUsage>().toHaveProperty('model');
    expectTypeOf<LastUsage>().toHaveProperty('inputTokens');
  });
});
