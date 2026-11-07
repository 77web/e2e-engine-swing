/**
 * The form behind the "Signed in" dialog refuses input: the agent answers
 * NOT_ACTIONABLE, which the runner reports as ACTION_FAILED.
 */

import { credentials, expect, test } from 'e2e';

test('a modal dialog blocks the form behind it', async ({ screen }) => {
  const demo = credentials.user('demo');
  await screen.getByTestId('username').fill(demo.username);
  await screen.getByTestId('password').fill(demo.password);
  await screen.getByTestId('sign-in').tap();
  await expect(screen.getByRole('button', 'OK')).toBeVisible();

  let code: string | undefined;
  try {
    await screen.getByTestId('username').tap({ timeout: 3_000 });
  } catch (error) {
    code = (error as { code?: string }).code;
  }
  expect(code).toBe('ACTION_FAILED');

  await screen.getByRole('button', 'OK').tap();
  await expect(screen.getByRole('button', 'OK')).toHaveCount(0);
  await screen.getByTestId('username').tap();
});
