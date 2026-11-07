import { credentials, expect, test } from 'e2e';

test('signs in with the demo account', async ({ screen }) => {
  const demo = credentials.user('demo');
  await screen.getByTestId('username').fill(demo.username);
  await screen.getByTestId('password').fill(demo.password);
  await screen.getByTestId('sign-in').tap();

  await expect(screen.getByRole('dialog', 'Signed in')).toBeVisible();
  await expect(screen.getByRole('dialog', 'Signed in').getByText('Welcome, demo!')).toBeVisible();
  await expect(screen.getByTestId('status')).toContainText('Signed in as demo');
  await expect(screen.getByRole('button', 'OK')).toBeVisible();

  await screen.getByRole('button', 'OK').tap();
  await expect(screen.getByRole('dialog', 'Signed in')).toBeHidden();
  await expect(screen.getByTestId('status')).toContainText('Signed in as demo');
});

test('shows an error for a wrong password', async ({ screen }) => {
  await screen.getByTestId('username').fill('invalid-user');
  await screen.getByTestId('password').fill('invalid-pw');
  await screen.getByTestId('sign-in').tap();

  await expect(screen.getByTestId('status')).toContainText('Invalid username or password.');
  await expect(screen.getByRole('dialog', 'Signed in')).not.toBeVisible();
});
