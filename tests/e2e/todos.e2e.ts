import { expect, test } from 'e2e';

test('switches to the Todos tab, which starts empty', async ({ screen }) => {
  await screen.getByRole('tab', 'Todos').tap();
  await expect(screen.getByRole('tab', 'Todos')).toBeSelected();
  await expect(screen.getByTestId('todo-input')).toBeVisible();
  await expect(screen.getByTestId('todo-count')).toHaveText('0 items');
});

test('adds todos with the button, Enter, and typed keys, removes the selected one, and clears all', async ({ screen }) => {
  await screen.getByRole('tab', 'Todos').tap();
  await expect(screen.getByRole('tab', 'Todos')).toBeSelected();

  await screen.getByTestId('todo-input').fill('Buy milk');
  await screen.getByTestId('todo-add').tap();
  await expect(screen.getByTestId('todo-count')).toHaveText('1 item');
  await expect(screen.getByRole('option')).toHaveCount(1);

  await screen.getByTestId('todo-input').fill('Buy egg');
  await screen.getByTestId('todo-input').press('Enter');
  await expect(screen.getByTestId('todo-count')).toHaveText('2 items');
  await expect(screen.getByRole('option')).toHaveCount(2);
  await expect(screen.getByRole('option').nth(0)).toHaveAccessibleName('Buy milk');
  await expect(screen.getByRole('option').nth(1)).toHaveAccessibleName('Buy egg');

  await screen.getByTestId('todo-input').pressSequentially('Buy bread');
  await screen.getByTestId('todo-input').press('Enter');
  await expect(screen.getByTestId('todo-count')).toHaveText('3 items');
  await expect(screen.getByRole('option').nth(2)).toHaveAccessibleName('Buy bread');

  const milk = screen.getByRole('option', 'Buy milk');
  await expect(milk).toBeVisible();
  await milk.tap();
  await expect(milk).toBeSelected();
  await screen.getByTestId('todo-remove').tap();
  await expect(screen.getByTestId('todo-count')).toHaveText('2 items');
  await expect(screen.getByRole('option')).toHaveCount(2);
  await expect(screen.getByRole('option').nth(0)).toHaveAccessibleName('Buy egg');

  await screen.getByTestId('todo-clear').tap();
  await expect(screen.getByTestId('todo-count')).toHaveText('0 items');
  await expect(screen.getByRole('option')).toHaveCount(0);
});

test('selects and removes the last of 15 todos, scrolled out of view', async ({ screen }) => {
  await screen.getByRole('tab', 'Todos').tap();
  await expect(screen.getByRole('tab', 'Todos')).toBeSelected();

  for (let i = 1; i <= 15; i++) {
    await screen.getByTestId('todo-input').fill('todo ' + i);
    await screen.getByTestId('todo-input').press('Enter');
  }
  await expect(screen.getByRole('option')).toHaveCount(15);

  const first = screen.getByRole('option', 'todo 1');
  const last = screen.getByRole('option', 'todo 15');
  await expect(last).toHaveCount(1);
  const before = (await last.boundingBox())!;
  const firstAtStart = (await first.boundingBox())!;
  await last.tap();
  await expect(last).toBeSelected();
  const after = (await last.boundingBox())!;
  expect(after.y).toBeLessThan(before.y);

  await first.scrollIntoView();
  expect((await first.boundingBox())!.y).toBe(firstAtStart.y);

  const top = (await first.boundingBox())!;
  await screen.swipe({ direction: 'down' });
  expect((await first.boundingBox())!.y).toBeLessThan(top.y);

  const scrolled = (await first.boundingBox())!;
  await screen.getByTestId('todo-list').swipe({ direction: 'up' });
  expect((await first.boundingBox())!.y).toBeGreaterThan(scrolled.y);

  await screen.getByTestId('todo-remove').tap();
  await expect(screen.getByRole('option')).toHaveCount(14);
  await expect(screen.getByRole('option', 'todo 15')).toHaveCount(0);
});
