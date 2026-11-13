import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { resolvePiRuntime } from './launch.js';
import { createPiCliRunner, resolvePiCliEntry, sanitizeOutput } from './packages-cli.js';

let root;

beforeAll(() => {
  root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'oc-pi-cli-'));
});
afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

/** A runner whose "Pi" is a script of ours, run on the runtime the server would use. */
const runnerFor = (source, baseEnv = { PATH: process.env.PATH }) => {
  const entry = path.join(root, `fake-${Math.random().toString(36).slice(2, 8)}.mjs`);
  fs.writeFileSync(entry, source);
  return createPiCliRunner({ baseEnv, resolveRuntime: resolvePiRuntime, resolveEntry: () => entry });
};

describe('createPiCliRunner', () => {
  it('runs the entry with the arguments, the folder and the environment it was given, and without a shell', async () => {
    const run = runnerFor(`
      process.stdout.write(JSON.stringify({
        args: process.argv.slice(2),
        cwd: process.cwd(),
        agentDir: process.env.PI_CODING_AGENT_DIR,
        noColor: process.env.NO_COLOR,
        forceColor: process.env.FORCE_COLOR ?? null,
        opencode: Object.keys(process.env).filter((name) => name.startsWith('OPENCODE_')),
        nodeOptions: process.env.NODE_OPTIONS ?? null,
        stdinTty: process.stdin.isTTY ?? false,
      }));
    `, { PATH: process.env.PATH, OPENCODE_SERVER_PASSWORD: 'secret', NODE_OPTIONS: '--inspect', FORCE_COLOR: '1' });

    const result = await run(['install', 'a b; echo hacked', '-l'], { cwd: root, env: { PI_CODING_AGENT_DIR: '/agent' } });

    expect(result).toMatchObject({ code: 0, signal: null, stderr: '', timedOut: false });
    expect(JSON.parse(result.stdout)).toEqual({
      args: ['install', 'a b; echo hacked', '-l'],
      cwd: root,
      agentDir: '/agent',
      noColor: '1',
      forceColor: null,
      opencode: [],
      nodeOptions: null,
      stdinTty: false,
    });
  });

  it('closes stdin so a command that waits for input ends instead of hanging', async () => {
    const run = runnerFor(`process.stdin.on('end', () => { process.stdout.write('eof'); }); process.stdin.resume();`);
    expect((await run([], { cwd: root, timeoutMs: 10_000 })).stdout).toBe('eof');
  });

  it('returns a failing exit code with what the process printed', async () => {
    const run = runnerFor(`process.stdout.write('Installing x...\\n'); process.stderr.write('Error: boom\\n'); process.exit(3);`);
    expect(await run([], { cwd: root })).toMatchObject({ code: 3, stdout: 'Installing x...\n', stderr: 'Error: boom\n', timedOut: false });
  });

  it('stops a process that runs too long, together with what it started', async () => {
    const pidFile = path.join(root, 'grandchild.pid');
    const run = runnerFor(`
      import { spawn } from 'node:child_process';
      import fs from 'node:fs';
      const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
      fs.writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));
      setInterval(() => {}, 1000);
    `);
    const startedAt = Date.now();

    const result = await run([], { cwd: root, timeoutMs: 500 });

    expect(result.timedOut).toBe(true);
    expect(Date.now() - startedAt).toBeLessThan(5_000);
    const grandchild = Number(fs.readFileSync(pidFile, 'utf8'));
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(() => process.kill(grandchild, 0)).toThrow();
  });

  it('does not wait for a leftover child that holds the pipes after Pi has exited', async () => {
    const run = runnerFor(`
      import { spawn } from 'node:child_process';
      spawn(process.execPath, ['-e', 'setTimeout(() => {}, 20000)'], { stdio: ['ignore', 'inherit', 'inherit'], detached: true }).unref();
      process.stdout.write('installed');
    `);
    const startedAt = Date.now();

    const result = await run([], { cwd: root, timeoutMs: 10_000 });

    expect(result).toMatchObject({ code: 0, stdout: 'installed', timedOut: false });
    expect(Date.now() - startedAt).toBeLessThan(5_000);
  });

  it('keeps the tail of a very long output, bounded', async () => {
    const run = runnerFor(`process.stdout.write('x'.repeat(300000) + 'THE END'); process.stderr.write('y'.repeat(200000) + 'LAST LINE');`);
    const result = await run([], { cwd: root });
    expect(result.stdout.length).toBeLessThanOrEqual(64 * 1024);
    expect(result.stdout.endsWith('THE END')).toBe(true);
    expect(result.stderr.endsWith('LAST LINE')).toBe(true);
  });

  it('masks credentials and colour codes in what it returns', async () => {
    const run = runnerFor(`process.stderr.write('\\u001b[31mError:\\u001b[39m clone https://user:hunter2@example.test/o/r failed; //r.test/:_authToken=npm_abcdef Authorization: Bearer abcdefghijklmnop');`);
    const { stderr } = await run([], { cwd: root });
    expect(stderr).toBe('Error: clone https://***@example.test/o/r failed; //r.test/:_authToken=*** Authorization: Bearer ***');
    expect(stderr).not.toContain('hunter2');
  });

  it('rejects when the process cannot start', async () => {
    const run = createPiCliRunner({ resolveRuntime: () => ({ command: path.join(root, 'no-such-runtime'), env: {} }), resolveEntry: () => 'x.js' });
    await expect(run([], { cwd: root })).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(runnerFor('')([], { cwd: path.join(root, 'no-such-folder') })).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('Pi\'s own CLI', () => {
  it('is found next to the RPC entry and answers --version', async () => {
    expect(path.basename(resolvePiCliEntry())).toBe('cli.js');
    expect(fs.existsSync(resolvePiCliEntry())).toBe(true);

    const result = await createPiCliRunner({ baseEnv: { PATH: process.env.PATH, HOME: root } })(['--version'], { cwd: root, timeoutMs: 30_000 });

    expect(result.code).toBe(0);
    expect(`${result.stdout}${result.stderr}`).toMatch(/\d+\.\d+\.\d+/);
  });
});

describe('sanitizeOutput', () => {
  it('leaves ordinary text alone', () => {
    expect(sanitizeOutput('npm error code E404\nnpm error 404 Not Found - GET https://registry.npmjs.org/x')).toBe('npm error code E404\nnpm error 404 Not Found - GET https://registry.npmjs.org/x');
    expect(sanitizeOutput(undefined)).toBe('');
  });

  it('masks the userinfo of every URL scheme', () => {
    expect(sanitizeOutput('ssh://git:pw@host/x git+https://tok@host/y')).toBe('ssh://***@host/x git+https://***@host/y');
  });
});
