import { accountFromHtml, type HtmlSource } from '../adapters/html.js';
import type { Account } from './state.js';
import { fail } from './failure.js';

/** Validates an `--expected-user-id` argument before any sign-in work starts. */
export function expectedUserIdArg(value: string): string {
  if (!/^\d+$/.test(value) || Number(value) <= 0) fail('INVALID_INPUT', '--expected-user-id must be your numeric Alza account ID.');
  return value;
}

export function verifyIdentity(html: HtmlSource, expected?: Account): 'signed_in' | 'anonymous' {
  const actual = accountFromHtml(html);
  if (expected && !actual.loggedIn) fail('AUTH_REQUIRED', 'The configured Alza session has expired or was not preserved. Import a valid session.');
  if (expected && actual.userId !== expected.expectedUserId) fail('AUTH_ACCOUNT_MISMATCH', 'The browser is signed into a different Alza account.');
  if (!expected && actual.loggedIn) fail('AUTH_ACCOUNT_MISMATCH', 'An anonymous operation unexpectedly received an authenticated session.');
  return expected ? 'signed_in' : 'anonymous';
}
