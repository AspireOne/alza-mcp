import { accountFromHtml } from '../adapters/html.js';
import type { Account } from './state.js';
import { fail } from './failure.js';

export function verifyIdentity(html: string, expected?: Account): 'signed_in' | 'anonymous' {
  const actual = accountFromHtml(html);
  if (expected && !actual.loggedIn) fail('AUTH_REQUIRED', 'The configured Alza session has expired or was not preserved. Import a valid session.');
  if (expected && actual.userId !== expected.expectedUserId) fail('AUTH_ACCOUNT_MISMATCH', 'The browser is signed into a different Alza account.');
  if (!expected && actual.loggedIn) fail('AUTH_ACCOUNT_MISMATCH', 'An anonymous operation unexpectedly received an authenticated session.');
  return expected ? 'signed_in' : 'anonymous';
}
