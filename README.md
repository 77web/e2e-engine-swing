# e2e-engine-swing

An experimental engine that lets [e2e](https://github.com/tester-army/e2e) test Java Swing desktop apps.

> **This is not an official TesterArmy project.** It is an independent, community-made engine built on e2e's public engine contract. It is not affiliated with or endorsed by TesterArmy, Inc.

> **Status: early and experimental.** It is not published to npm yet, and the API may change. The engine supports `tap`, `doubleTap`, `secondaryTap`, `fill`, `clear`, `press`, `check`, `uncheck`, `focus`, `selectOption`, `swipe`, and `scrollIntoView`, and keyboard input to the focused component. It does not support `longPress`, `hover`, `dragTo`, `setInputFiles`, tap modifiers, actions at a point, or screenshots yet.

## How it works

```
e2e runner ── swing() engine (TypeScript)
                  │  JSON over a localhost socket, with a per-launch token
                  ▼
   java -javaagent:e2e-swing-agent.jar -jar your-app.jar
        └─ Java agent: reads and drives the Swing tree on the event dispatch thread
```

- The engine starts your app's jar with a Java agent attached, so **the app needs no changes**.
- The agent reads the UI through Swing's accessibility tree. It does not use the OS accessibility APIs, so it needs no screen-recording or accessibility permissions.
- Each test attempt starts a fresh JVM.
- `Component.getName()` becomes the node's test id, so `screen.getByTestId('username')` finds `field.setName("username")`.
- Password fields (`JPasswordField`) are reported as secure, and their values are never read.

## Requirements

- Node.js `^22.22.3 || >=24.8.0`
- JDK 17 or later, with `java` on `PATH` or under `JAVA_HOME`
- Maven, to build the Java agent
- A desktop session. The app's windows are shown while tests run.

## Try it with the bundled sample app

```sh
git clone https://github.com/77web/e2e-engine-swing.git
cd e2e-engine-swing
npm install
npm run build:agent      # builds agent/target/e2e-swing-agent.jar
npm run build:test-app   # builds the sample app in swing-for-test/
npm run test:e2e         # builds the engine and runs tests/**/*.e2e.ts
```

## Use it with your own app

Build this repository as shown above, then point a target at your app's jar:

```ts
// e2e.config.ts
import type { E2EConfig } from 'e2e';
import { anthropic } from '@ai-sdk/anthropic';
import { swing } from 'path/to/e2e-engine-swing/dist/index.js';

export default {
  targets: [
    {
      name: 'desktop',
      engine: swing(),
      app: {
        appPath: 'build/libs/my-app.jar', // required: a runnable .jar, relative to the project root
        launchArguments: ['--demo'],      // optional: passed to the app's main method
      },
    },
  ],
  // optional: only tests with agent steps need a model
  agents: { default: { model: anthropic('claude-sonnet-5-5') } },
} satisfies E2EConfig;
```

`swing()` takes these options:

| Option | Default | Description |
| --- | --- | --- |
| `java` | `JAVA_HOME/bin/java`, then `java` on `PATH` | The `java` executable to use |
| `startTimeoutMs` | `20000` | Time allowed to start the JVM, connect to the agent, and show the first window |

A test looks like any other e2e test:

```ts
import { credentials, expect, test } from 'e2e';

test('signs in', async ({ screen }) => {
  const demo = credentials.user('demo');
  await screen.getByTestId('username').fill(demo.username);
  await screen.getByTestId('password').fill(demo.password);
  await screen.getByTestId('sign-in').tap();

  await expect(screen.getByRole('dialog', 'Signed in')).toBeVisible();
});
```

### Agent steps

Describe a goal in natural language and e2e's agent drives the app to reach it. Agent steps need a model in `agents` (above): install `ai` and a provider package such as `@ai-sdk/anthropic`, and set its API key. See e2e's [models](https://e2e.com/docs/models) docs.

```ts
import { credentials, expect, test } from 'e2e';

test('signs in, then adds a todo', async ({ agent, screen }) => {
  const demo = credentials.user('demo');
  // The model sees only the password's name; the runner types the value into the JPasswordField.
  await agent.act('Sign in', {
    params: { username: demo.username, password: demo.password },
  });
  await agent.assert('a dialog says the user signed in');

  await agent.act('Close the dialog, open the Todos tab, and add a todo "Buy milk"');

  // Mix agent steps with exact checks.
  await expect(screen.getByTestId('todo-count')).toContainText('1 item');
});
```

The agent reads the same Swing accessibility tree as the locators, as a redacted text snapshot. The engine offers it the tools those actions unlock, such as `tap`, `type` (`type_secret` for a `Secret` param), `press`, `select`, `check`, and `scroll`. It offers no screenshots yet, so `vision` is not available.

To make components easy to find, give them names (`setName`) and accessible names. A `JLabel` bound with `setLabelFor` supplies the accessible name of its field.

## Development

```sh
npm run check              # lint, type check, unit tests
npm run test:integration   # starts the real sample app under the real agent (opens windows)
npm run test:e2e           # the e2e suites in tests/
```

## License

[Apache License 2.0](LICENSE). See [NOTICE](NOTICE).
