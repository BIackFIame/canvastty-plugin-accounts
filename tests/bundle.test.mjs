// The installable package as CanvasTTY runs it: the manifest's file integrity, the manifest against CanvasTTY's own
// validator, and the bundled service as a child process speaking JSON-RPC lines (with the host's calls answered by the
// test, or — when CANVASTTY_REPO points at a checkout — CanvasTTY's own supervisor and launch pipeline).
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import test from 'node:test';
import { startFakeOllama } from './helpers/fake-ollama.mjs';

const root = new URL('../', import.meta.url).pathname;
const manifest = JSON.parse(readFileSync(join(root, 'canvastty.plugin.json'), 'utf8'));
const base = realpathSync(mkdtempSync(join(tmpdir(), 'canvastty-accounts-bundle-')));
const project = join(base, 'project');
mkdirSync(project, { recursive: true });
process.on('exit', () => rmSync(base, { recursive: true, force: true }));
const KEY = ['sk', 'bundle', 'fixture', '0123456789abcdef'].join('-');

test('the manifest\'s coreFiles match the package bytes, and the service and page are single bundled files', () => {
  for (const file of manifest.coreFiles) {
    const bytes = readFileSync(join(root, file.path));
    assert.equal(bytes.length, file.bytes, file.path);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), file.sha256, `${file.path}: run npm run build`);
  }
  for (const path of ['services/accounts.mjs', 'settings/accounts.js']) {
    assert.ok(manifest.coreFiles.some(file => file.path === path), path);
    assert.doesNotMatch(readFileSync(join(root, path), 'utf8'), /^import .* from ["']\.\.?\//mu, `${path} is bundled`);
  }
  assert.equal(manifest.id, 'canvastty-accounts');
  assert.ok(!manifest.permissions.includes('network'), 'a service needs no surface network permission');
});

test('the manifest passes CanvasTTY\'s own validator (when CANVASTTY_REPO points at a checkout)', { skip: !process.env.CANVASTTY_REPO }, async () => {
  const { validatePluginManifest } = await import(join(process.env.CANVASTTY_REPO, 'src/main/services/PluginManager.ts'));
  const checked = validatePluginManifest(manifest);
  assert.equal(checked.services[0].launch.fields[0].optionsFrom, 'service');
  assert.deepEqual(checked.services[0].tools.map(tool => tool.name), ['list_routes', 'pick_account']);
});

function startService(t, { dataDir, host = {} }) {
  const child = spawn(process.execPath, [join(root, 'services', 'accounts.mjs')], { cwd: root, env: { PATH: process.env.PATH, HOME: base }, stdio: ['pipe', 'pipe', 'inherit'] });
  t.after(() => child.kill());
  const waiting = new Map();
  let nextId = 1;
  const write = message => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
  createInterface({ input: child.stdout }).on('line', async line => {
    const message = JSON.parse(line);
    if (message.method && message.id !== undefined) {
      try {
        const handler = host[message.method];
        if (!handler) throw new Error(`host: ${message.method} not allowed`);
        write({ id: message.id, result: (await handler(message.params)) ?? null });
      } catch (error) {
        write({ id: message.id, error: { code: -32000, message: error.message } });
      }
      return;
    }
    if (message.method) return;
    const waiter = waiting.get(message.id);
    waiting.delete(message.id);
    if (message.error) waiter?.reject(new Error(message.error.message));
    else waiter?.resolve(message.result);
  });
  write({ method: 'canvastty.initialize', params: { apiVersion: 2, pluginId: manifest.id, serviceId: 'accounts', dataDir, locale: 'ru', hostVersion: 'test' } });
  return {
    request: (method, params) => new Promise((resolve, reject) => {
      const id = `t${nextId++}`;
      waiting.set(id, { resolve, reject });
      write({ id, method, params });
    })
  };
}

test('end to end over JSON-RPC: the page saves accounts, the launcher lists them, a launch is prepared, tools answer', async (t) => {
  const ollama = await startFakeOllama();
  t.after(() => ollama.close());
  const storage = {};
  const secrets = { 'key.glm': KEY };
  const dataDir = join(base, 'data');
  const service = startService(t, { dataDir, host: {
    'storage.get': ({ key }) => storage[key] ?? null,
    'storage.set': ({ key, value }) => { storage[key] = value; },
    'secrets.get': ({ key }) => secrets[key] ?? null
  } });
  assert.deepEqual((await service.request('state')).settings.accounts, []);
  await service.request('save', { settings: { version: 1, accounts: [
    { id: 'qwen', label: 'Qwen', preset: 'ollama-local', baseUrl: ollama.url, model: 'qwen3.5:9b', agents: ['claude', 'codex'] },
    { id: 'glm', label: 'GLM', preset: 'zai-anthropic', baseUrl: 'https://api.z.ai/api/anthropic', model: 'glm-4.6', agents: ['claude'] }
  ] } });
  await service.request('keyChanged', { accountId: 'glm' });
  assert.equal(storage.accounts.keyOrigins.glm, 'https://api.z.ai');
  assert.deepEqual((await service.request('canvastty.launch.options', { provider: 'codex', fields: ['account'] })).account, [{ value: 'qwen', label: 'Qwen · qwen3.5:9b' }]);
  const launch = await service.request('canvastty.launch.prepare', { sessionId: 's', provider: 'codex', profile: 'normal', role: 'agent', cwd: project, restoring: false, resume: false,
    options: { account: 'qwen', effort: 'default', trustFolder: false }, chosen: true, environment: null });
  assert.equal(launch.env.CODEX_HOME, join(dataDir, 'homes', 'codex-qwen'));
  assert.deepEqual(readdirSync(join(dataDir, 'homes')), ['codex-qwen']);
  const keyed = await service.request('canvastty.launch.prepare', { sessionId: 's', provider: 'claude', profile: 'normal', role: 'agent', cwd: project, restoring: false, resume: false,
    options: { account: 'glm', effort: 'default', trustFolder: false }, chosen: true, environment: null });
  assert.deepEqual(keyed.secretEnv, { ANTHROPIC_AUTH_TOKEN: 'key.glm' });
  assert.ok(!JSON.stringify(keyed).includes(KEY));
  const check = await service.request('check', { accountId: 'qwen' });
  assert.equal(check.models[0].name, 'qwen3.5:9b');
  const routes = await service.request('canvastty.tools.call', { tool: 'list_routes', caller: { id: 'o', role: 'orchestrator' }, input: {} });
  assert.deepEqual(routes.content.routes.map(row => `${row.provider}:${row.accountId}:${row.state}`), ['claude:qwen:ready', 'codex:qwen:ready', 'claude:glm:ready']);
});

test('through CanvasTTY\'s own supervisor and launch pipeline: the launcher list and a prepared launch (CANVASTTY_REPO)', { skip: !process.env.CANVASTTY_REPO }, async (t) => {
  const repo = process.env.CANVASTTY_REPO;
  const { LaunchPipeline } = await import(join(repo, 'src/main/services/LaunchPipeline.ts'));
  const { PluginServiceSupervisor } = await import(join(repo, 'src/main/services/PluginServiceSupervisor.ts'));
  const { validatePluginManifest } = await import(join(repo, 'src/main/services/PluginManager.ts'));
  const ollama = await startFakeOllama();
  t.after(() => ollama.close());
  const checked = validatePluginManifest(manifest);
  const storage = { accounts: { settings: { version: 1, accounts: [{ id: 'qwen', label: 'Qwen', preset: 'ollama-local', baseUrl: ollama.url, model: 'qwen3.5:9b', agents: ['claude'] }] }, keyOrigins: {} } };
  const supervisor = new PluginServiceSupervisor({
    command: process.execPath, hostVersion: '9.9.9', locale: () => 'en', stopGraceMs: 300,
    host: { storageGet: async (_plugin, key) => storage[key] ?? null, storageSet: async (_plugin, key, value) => { storage[key] = value; }, emit: () => undefined }
  });
  t.after(() => supervisor.dispose());
  const entryPath = join(root, 'services', 'accounts.mjs');
  await supervisor.sync([{ pluginId: checked.id, serviceId: 'accounts', root, entryPath, sha256: createHash('sha256').update(readFileSync(entryPath)).digest('hex'),
    dataDir: join(base, 'core-data'), permissions: checked.permissions }]);
  const pipeline = new LaunchPipeline({
    contributors: () => [{ pluginId: checked.id, pluginName: checked.name, serviceId: 'accounts', launch: checked.services[0].launch, secrets: true }],
    call: (pluginId, serviceId, method, params, timeoutMs) => supervisor.hostCall(pluginId, serviceId, method, params, timeoutMs),
    secret: async () => null,
    runsRoot: join(base, 'runs')
  });
  assert.deepEqual(await pipeline.fieldOptions(checked.id, 'claude'), { account: [{ value: 'qwen', label: 'Qwen · qwen3.5:9b' }] });
  const options = pipeline.normalizeOptions('claude', { [checked.id]: { account: 'qwen' } });
  assert.deepEqual(options, { [checked.id]: { account: 'qwen', effort: 'default', trustFolder: false } });
  const prepared = await pipeline.prepare({ sessionId: 'e2e', provider: 'claude', profile: 'normal', role: 'agent', cwd: project, restoring: false, resume: false, environment: null, options });
  assert.equal(prepared.ok, true, prepared.reason);
  assert.equal(prepared.env.ANTHROPIC_BASE_URL, ollama.url);
  assert.equal(prepared.env.ANTHROPIC_DEFAULT_SONNET_MODEL, 'qwen3.5:9b:local');
  assert.ok(prepared.args.includes('--model'));
  await prepared.cleanup();
});
