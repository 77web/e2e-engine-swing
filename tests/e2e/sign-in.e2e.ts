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

test('signs in with the role and remember me chosen', async ({ screen }) => {
  const demo = credentials.user('demo');
  await screen.getByTestId('username').fill(demo.username);
  await screen.getByTestId('password').fill(demo.password);
  await screen.getByTestId('role').selectOption('Admin');
  await expect(screen.getByTestId('role')).toHaveValue('Admin');
  await screen.getByTestId('remember').check();
  await expect(screen.getByTestId('remember')).toBeChecked();
  await screen.getByTestId('sign-in').tap();

  await expect(screen.getByTestId('status')).toHaveText('Signed in as demo (Admin), remembered');
  await screen.getByRole('button', 'OK').tap();
  await expect(screen.getByRole('dialog', 'Signed in')).toBeHidden();
});

test('chooses the role by index, unchecks remember me, and closes the dialog with Escape', async ({ screen }) => {
  const demo = credentials.user('demo');
  await screen.getByTestId('username').fill(demo.username);
  await screen.getByTestId('password').fill(demo.password);
  await screen.getByTestId('role').selectOption({ index: 1 });
  await expect(screen.getByTestId('role')).toHaveValue('Editor');
  await screen.getByTestId('remember').check();
  await screen.getByTestId('remember').uncheck();
  await expect(screen.getByTestId('remember')).not.toBeChecked();
  await screen.getByTestId('sign-in').tap();

  await expect(screen.getByTestId('status')).toHaveText('Signed in as demo (Editor)');
  await screen.getByRole('button', 'OK').press('Escape');
  await expect(screen.getByRole('dialog', 'Signed in')).toBeHidden();
});

test('signs in from the keyboard', async ({ screen }) => {
  const demo = credentials.user('demo');
  // Typed as key events; the password is a Secret, which is only ever filled.
  await screen.getByTestId('username').pressSequentially(demo.username);
  await expect(screen.getByTestId('username')).toHaveValue('demo');
  await screen.getByTestId('password').fill(demo.password);
  // The form has no default button, so Enter does not submit; Space presses the focused button.
  await screen.getByTestId('sign-in').press('Space');

  await expect(screen.getByRole('dialog', 'Signed in')).toBeVisible();
  await expect(screen.getByTestId('status')).toHaveText('Signed in as demo (Viewer)');
  await screen.getByRole('button', 'OK').tap();
});

test('asks for both fields after the username is cleared', async ({ screen }) => {
  const demo = credentials.user('demo');
  await screen.getByTestId('username').fill(demo.username);
  await screen.getByTestId('username').clear();
  await expect(screen.getByTestId('username')).toHaveValue('');
  await screen.getByTestId('password').fill(demo.password);
  await screen.getByTestId('sign-in').tap();

  await expect(screen.getByTestId('status')).toHaveText('Enter a username and password.');
  await expect(screen.getByRole('dialog', 'Signed in')).toHaveCount(0);
});
