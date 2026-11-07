#!/usr/bin/env node
/**
 * Stage 0 check: starts swing-for-test under the agent, asks you to put the app in each state,
 * saves a snapshot of each to samples/, and checks the stage's completion criteria.
 *
 * Build both jars first:
 *   mvn -f agent package && mvn -f swing-for-test package
 * Then, from the repository root:
 *   node agent/scripts/capture-samples.mjs
 */
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import net from 'node:net';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const agentDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = join(agentDir, '..');
const agentJar = join(agentDir, 'target', 'e2e-swing-agent.jar');
const appJar = join(repoRoot, 'swing-for-test', 'target', 'swing-for-test-0.1.0.jar');

const PASSWORD = 'secret';
const STATES = [
  { file: 'initial', prompt: 'Leave the window on the "Sign in" tab.', check: checkInitial },
  { file: 'todos', prompt: 'Switch to the "Todos" tab.', check: checkTodos },
  {
    file: 'dialog',
    prompt: `On "Sign in", enter demo / ${PASSWORD} and click "Sign in". Keep the dialog open.`,
    check: checkDialog,
  },
];

/** Flattens a tree into a list of its nodes. */
function allNodes(nodes) {
  return nodes.flatMap((node) => [node, ...allNodes(node.children)]);
}

/** Finds a node by test id, reporting a failure when it is missing. */
function requireTestId(nodes, testId, fail) {
  const node = nodes.find((candidate) => candidate.testId === testId);
  if (!node) {
    fail(`no node with testId "${testId}"`);
  } else if (!node.name || !node.rect) {
    fail(`"${testId}" has no name or no rect`);
  }
  return node;
}

function checkInitial(result, fail) {
  const nodes = allNodes(result.windows);
  for (const testId of ['username', 'password', 'role', 'remember', 'sign-in', 'status']) {
    requireTestId(nodes, testId, fail);
  }
  const password = nodes.find((node) => node.testId === 'password');
  if (password?.secure !== true) fail('"password" is not secure');
  if (password && ('text' in password || 'value' in password)) fail('"password" exposes a value');
}

function checkTodos(result, fail) {
  const nodes = allNodes(result.windows);
  for (const testId of ['todo-list', 'todo-input', 'todo-add', 'todo-remove', 'todo-clear', 'todo-count']) {
    requireTestId(nodes, testId, fail);
  }
}

function checkDialog(result, fail) {
  if (result.windows.length !== 2) fail(`expected 2 windows, got ${result.windows.length}`);
  const dialog = result.windows.find((window) => window.name === 'Signed in');
  if (!dialog) {
    fail('no window named "Signed in"');
    return;
  }
  const nodes = allNodes([dialog]);
  if (!nodes.some((node) => node.name === 'Welcome, demo!' || node.text === 'Welcome, demo!')) {
    fail('the dialog has no "Welcome, demo!"');
  }
  if (!nodes.some((node) => node.role === 'push button' && node.name === 'OK')) {
    fail('the dialog has no OK button');
  }
}

/** Starts the app and resolves with the agent's connection details. Never logs the token line. */
function startApp() {
  const app = spawn('java', [`-javaagent:${agentJar}`, '-jar', appJar], {
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const connection = new Promise((resolve, reject) => {
    app.once('error', reject);
    app.once('exit', (code) => reject(new Error(`the app exited with code ${code} before the agent was ready`)));
    createInterface({ input: app.stdout }).on('line', (line) => {
      if (line.startsWith('E2E_SWING_AGENT ')) {
        resolve(JSON.parse(line.slice('E2E_SWING_AGENT '.length)));
      } else {
        console.log(`[app] ${line}`);
      }
    });
  });
  return { app, connection };
}

/** Opens a connection and returns a function that sends one request and awaits its response. */
function connect(port) {
  const socket = net.connect(port, '127.0.0.1');
  const lines = createInterface({ input: socket })[Symbol.asyncIterator]();
  let nextId = 1;
  const call = async (method, params) => {
    const id = nextId++;
    socket.write(`${JSON.stringify({ id, method, ...(params ? { params } : {}) })}\n`);
    const { value, done } = await lines.next();
    if (done) throw new Error(`the agent closed the connection during "${method}"`);
    const response = JSON.parse(value);
    if (response.id !== id) throw new Error(`expected response ${id}, got ${response.id}`);
    return response;
  };
  return { socket, call };
}

const { app, connection } = startApp();
let failures = 0;
try {
  const { port, token } = await connection;
  const { socket, call } = connect(port);
  await call('auth', { token });

  const unknown = await call('no-such-method');
  if (unknown.error?.code !== -32601) {
    failures++;
    console.log(`FAIL unknown method: ${JSON.stringify(unknown)}`);
  }

  const prompts = createInterface({ input: process.stdin, output: process.stdout });
  const ask = (question) => new Promise((resolve) => prompts.question(question, resolve));
  for (const state of STATES) {
    await ask(`\n${state.prompt}\nPress Enter when ready. `);
    const started = Date.now();
    const response = await call('snapshot');
    if (response.error) throw new Error(`snapshot failed: ${JSON.stringify(response.error)}`);

    const reasons = [];
    state.check(response.result, (reason) => reasons.push(reason));
    const text = JSON.stringify(response.result, null, 2);
    if (text.includes(`"${PASSWORD}"`) || text.includes(token)) reasons.push('the output contains a secret');
    writeFileSync(join(agentDir, 'samples', `${state.file}.json`), `${text}\n`);

    failures += reasons.length;
    console.log(`${reasons.length === 0 ? 'ok  ' : 'FAIL'} ${state.file} (${Date.now() - started} ms)`);
    for (const reason of reasons) console.log(`     ${reason}`);
  }
  prompts.close();
  socket.destroy();
} catch (error) {
  failures++;
  console.error(`FAIL ${error.message}`);
} finally {
  app.removeAllListeners('exit');
  app.kill();
}
console.log(failures === 0 ? '\nALL OK' : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
