// Starts the Kinowrap server and the Angular page together, then opens the browser.
// Usage: npm start   (Ctrl+C stops both)
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const isWin = process.platform === 'win32';
const root = path.dirname(fileURLToPath(import.meta.url));
const SERVER_PORT = 3000;
const CLIENT_PORT = 4200;

if (!existsSync(path.join(root, 'server', '.env'))) {
  console.error('Missing server/.env. Copy server/.env.example to server/.env and add your MiniMax API key.');
  process.exit(1);
}

const inUse = (port) =>
  new Promise((resolve) => {
    // 'localhost' (not 127.0.0.1): on Windows ng serve may listen on IPv6 (::1) only.
    const s = net.connect(port, 'localhost');
    s.on('connect', () => { s.destroy(); resolve(true); });
    s.on('error', () => resolve(false));
  });

for (const [name, port] of [['server', SERVER_PORT], ['page', CLIENT_PORT]]) {
  if (await inUse(port)) {
    console.error(`Port ${port} is already in use, so the ${name} is probably already running. Stop it first (Ctrl+C in its terminal).`);
    process.exit(1);
  }
}

const children = [];
let stopping = false;

function start(name, color, cmd, args, cwd) {
  // detached = its own process group, so Ctrl+C can stop the whole tree (ng serve spawns children).
  // On Windows, npm is a .cmd file (needs a shell) and the tree is stopped with taskkill instead.
  const child = spawn(cmd, args, { cwd, detached: !isWin, shell: isWin, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const tag = `\x1b[${color}m[${name}]\x1b[0m `;
  const relay = (out) => (data) => out.write(data.toString().split('\n').filter(Boolean).map((l) => tag + l).join('\n') + '\n');
  child.stdout.on('data', relay(process.stdout));
  child.stderr.on('data', relay(process.stderr));
  child.on('exit', (code) => {
    if (!stopping) console.error(`${tag}stopped (exit ${code}). Shutting down.`);
    stop();
  });
  children.push(child);
}

function stop() {
  if (stopping) return;
  stopping = true;
  for (const c of children) {
    try {
      if (isWin) spawn('taskkill', ['/pid', String(c.pid), '/T', '/F'], { stdio: 'ignore' });
      else process.kill(-c.pid, 'SIGTERM');
    } catch { /* already gone */ }
  }
  setTimeout(() => process.exit(0), 500);
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);

start('server', 35, 'node', ['--env-file=.env', 'server.mjs'], path.join(root, 'server'));
start('page', 36, 'npm', ['start'], path.join(root, 'client'));

// Open the browser once the page answers.
const url = `http://localhost:${CLIENT_PORT}`;
for (let i = 0; i < 120 && !stopping; i++) {
  if (await inUse(CLIENT_PORT)) {
    console.log(`\nKinowrap is ready: ${url}`);
    if (isWin) spawn('cmd', ['/c', 'start', '', url], { stdio: 'ignore' });
    else spawn('open', [url], { stdio: 'ignore' });
    break;
  }
  await new Promise((r) => setTimeout(r, 1000));
}
