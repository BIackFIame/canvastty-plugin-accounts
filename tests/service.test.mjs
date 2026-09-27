// The Accounts service against a fake host (storage, secrets) and a fake Ollama: the launcher list, the launch
// contribution per account, the refusals, «Проверить», the key's address binding and the orchestrator tools.
// Keys are assembled at runtime; nothing leaves 127.0.0.1.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { AccountsService, thirdPartyModel } from '../src/service/accounts.ts';
import { startFakeOllama } from './helpers/fake-ollama.mjs';

const KEY = ['sk', 'fixture', 'glm', 'f00dfeed'.repeat(4)].join('-');

async function fixture(t, { ollama: ollamaOptions } = {}) {
  const ollama = await startFakeOllama(ollamaOptions);
  const dataDir = await mkdtemp(join(tmpdir(), 'canvastty-accounts-data-'));
  const project = await mkdtemp(join(tmpdir(), 'canvastty-accounts-project-'));
  t.after(async () => { await ollama.close(); await rm(dataDir, { recursive: true, force: true }); await rm(project, { recursive: true, force: true }); });
  const storage = {};
  const secrets = {};
  const logs = [];
  const host = {
    callHost: async (method, params) => {
      if (method === 'storage.get') return storage[params.key] ?? null;
      if (method === 'storage.set') { storage[params.key] = structuredClone(params.value); return null; }
      if (method === 'secrets.get') return secrets[params.key] ?? null;
      throw new Error(`host: ${method} not allowed`);
    },
    log: (level, message) => logs.push({ level, message }),
    emit: () => undefined
  };
  const service = new AccountsService({ host, dataDir });
  const accounts = [
    { id: 'qwen-local', label: 'Qwen local', preset: 'ollama-local', baseUrl: ollama.url, model: 'qwen3.5:9b', agents: ['claude', 'codex', 'opencode'] },
    { id: 'glm', label: 'GLM', preset: 'zai-anthropic', baseUrl: 'https://api.z.ai/api/anthropic', model: 'glm-4.6', agents: ['claude', 'opencode'] }
  ];
  await service.save({ version: 1, accounts });
  const context = (patch = {}) => ({ sessionId: 's1', provider: 'claude', profile: 'normal', role: 'agent', cwd: project, restoring: false, resume: false,
    chosen: true, environment: null, ...patch, options: { account: 'qwen-local', effort: 'default', trustFolder: false, ...patch.options } });
  return { ollama, dataDir, project, storage, secrets, logs, service, host, context, reload: () => new AccountsService({ host, dataDir, saved: storage.accounts }) };
}

test('the launcher lists the accounts the person allowed for each agent', async (t) => {
  const { service } = await fixture(t);
  assert.deepEqual(service.launchOptions('claude'), { account: [{ value: 'qwen-local', label: 'Qwen local · qwen3.5:9b' }, { value: 'glm', label: 'GLM · glm-4.6' }] });
  assert.deepEqual(service.launchOptions('codex').account.map(option => option.value), ['qwen-local']);
  assert.deepEqual(service.launchOptions('qwen'), { account: [] });
  assert.deepEqual(service.launchOptions('terminal'), { account: [] });
});

test('Claude Code on local Ollama: pinned model, the account home seeded, nothing written outside the plugin folder', async (t) => {
  const { service, dataDir, ollama, project } = await fixture(t);
  const answer = await service.prepare({ ...contextFor(project), options: { account: 'qwen-local', effort: 'high', trustFolder: true } });
  assert.equal(answer.env.ANTHROPIC_BASE_URL, ollama.url);
  assert.equal(answer.env.ANTHROPIC_DEFAULT_SONNET_MODEL, 'qwen3.5:9b:local');
  const home = join(dataDir, 'homes', 'claude-qwen-local');
  assert.equal(answer.env.CLAUDE_CONFIG_DIR, home);
  assert.deepEqual(answer.args.slice(-2), ['--effort', 'high']);
  assert.ok(answer.args.includes('--disallowedTools'), 'the server has cloud features on: web search off');
  assert.equal(answer.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW, '262144');
  const seeded = JSON.parse(await readFile(join(home, '.claude.json'), 'utf8'));
  assert.equal(seeded.hasCompletedOnboarding, true);
  assert.equal(seeded.projects[project].hasTrustDialogAccepted, true);
  assert.deepEqual(await readdir(project), [], 'the project folder is untouched');
  // Read-only against Ollama: no pull, no generate, no load.
  assert.ok(ollama.requests.every(request => request.method === 'GET' || request.path === '/api/show'));
  assert.ok(ollama.requests.some(request => request.path === '/api/show' && request.body.model === 'qwen3.5:9b:local'));
});

function contextFor(cwd, patch = {}) {
  return { sessionId: 's1', provider: 'claude', profile: 'normal', role: 'agent', cwd, restoring: false, resume: false, chosen: true, environment: null, ...patch };
}

test('Codex on local Ollama: the account CODEX_HOME, a private catalog, and a subagent cannot pre-trust a folder', async (t) => {
  const { service, dataDir, context, project } = await fixture(t);
  const person = await service.prepare(context({ provider: 'codex', options: { trustFolder: true, effort: 'low' } }));
  assert.equal(person.env.CODEX_HOME, join(dataDir, 'homes', 'codex-qwen-local'));
  assert.ok(person.args.includes(`projects={${JSON.stringify(project)}={trust_level="trusted"}}`));
  assert.deepEqual(person.args.slice(-4), ['--model', 'qwen3.5:9b:local', '-c', 'model_reasoning_effort="low"']);
  assert.equal(person.files[0].relPath, 'codex-model.json');
  const subagent = await service.prepare(context({ provider: 'codex', role: 'subagent', options: { trustFolder: true } }));
  assert.ok(!subagent.args.some(arg => arg.startsWith('projects=')));
});

test('an account model is third-party: CanvasTTY runs "auto" as accept-edits; the vendor\'s own API is not', async (t) => {
  const { service, context } = await fixture(t);
  const local = await service.prepare(context({ profile: 'auto' }));
  assert.equal(local.thirdPartyModel, true);
  assert.equal((await service.prepare(context({ provider: 'codex', profile: 'auto' }))).thirdPartyModel, true);
  assert.equal(await service.prepare(context({ options: { account: 'none' } })), null, 'the agent\'s own sign-in is not marked');
  assert.equal(thirdPartyModel('claude', 'https://api.anthropic.com'), false);
  assert.equal(thirdPartyModel('codex', 'https://api.openai.com/v1'), false);
  assert.equal(thirdPartyModel('claude', 'https://api.z.ai/api/anthropic'), true);
  assert.equal(thirdPartyModel('codex', 'https://api.anthropic.com'), true);
  assert.equal(thirdPartyModel('claude', null), true);
});

test('a Claude subagent in the orchestrator\'s folder (CanvasTTY\'s trustedFolder) is trusted in the account home only', async (t) => {
  const { service, dataDir, context, project } = await fixture(t);
  const docs = join(project, 'docs');
  await mkdir(docs);
  const answer = await service.prepare(context({ role: 'subagent', cwd: docs, trustedFolder: docs, options: { trustFolder: true } }));
  assert.equal(answer.refuse, undefined);
  const seeded = JSON.parse(await readFile(join(dataDir, 'homes', 'claude-qwen-local', '.claude.json'), 'utf8'));
  assert.deepEqual(Object.keys(seeded.projects ?? {}), [docs], 'the model-chosen trustFolder option is still ignored; the host folder counts');
});

test('refusals: a missing account or agent, a non-local environment, a stopped Ollama, an uninstalled or tool-less model, a bad effort', async (t) => {
  const { service, context, ollama } = await fixture(t);
  assert.match((await service.prepare(context({ options: { account: 'gone' } }))).refuse.reason, /gone no longer exists/);
  assert.match((await service.prepare(context({ provider: 'qwen' }))).refuse.reason, /not set up for Qwen Code/);
  assert.match((await service.prepare(context({ environment: { pluginId: 'canvastty-environments', kind: 'ssh-host' } }))).refuse.reason, /on this computer/);
  assert.equal((await service.prepare(context({ environment: { pluginId: 'canvastty-environments', kind: 'worktree' } }))).refuse, undefined, 'a worktree is on this computer');
  assert.match((await service.prepare(context({ options: { effort: 'minimal' } }))).refuse.reason, /no reasoning effort "minimal"/);
  const accounts = service.settings.accounts;
  await service.save({ version: 1, accounts: [...accounts, { id: 'gemma', label: 'Gemma', preset: 'ollama-local', baseUrl: ollama.url, model: 'gemma3:12b', agents: ['claude'] },
    { id: 'absent', label: 'Absent', preset: 'ollama-local', baseUrl: ollama.url, model: 'llama9:1b', agents: ['claude'] }] });
  assert.match((await service.prepare(context({ options: { account: 'gemma' } }))).refuse.reason, /no tool calling/);
  assert.match((await service.prepare(context({ options: { account: 'absent' } }))).refuse.reason, /not installed.*ollama pull llama9:1b/);
  await ollama.close();
  assert.match((await service.prepare(context({}))).refuse.reason, /Ollama is not running/);
  // Not chosen (a policy check) and the agent's own sign-in with nothing to add: no contribution.
  assert.equal(await service.prepare(context({ chosen: false })), null);
  assert.equal(await service.prepare(context({ options: { account: 'none' } })), null);
  assert.deepEqual((await service.prepare(context({ provider: 'codex', options: { account: 'none', effort: 'high', trustFolder: true } }))).args.slice(0, 2), ['-c', 'model_reasoning_effort="high"']);
});

test('a keyed account: the key goes by name only, is bound to the address it was saved for, and a project cannot redirect it', async (t) => {
  const { service, secrets, context, project, reload } = await fixture(t);
  assert.match((await service.prepare(context({ options: { account: 'glm' } }))).refuse.reason, /GLM has no key/);
  secrets['key.glm'] = KEY;
  // Saved without the page's keyChanged (another address or an old key): refused until saved again.
  assert.match((await service.prepare(context({ options: { account: 'glm' } }))).refuse.reason, /another address/);
  await service.keyChanged('glm');
  const answer = await service.prepare(context({ options: { account: 'glm' } }));
  assert.deepEqual(answer.secretEnv, { ANTHROPIC_AUTH_TOKEN: 'key.glm' });
  assert.ok(!JSON.stringify(answer).includes(KEY), 'the value never travels through the contribution');
  // The binding survives a restart of the service.
  assert.ok((await reload().prepare(context({ options: { account: 'glm' } }))).secretEnv);
  // OpenCode on the same account: {env:…} in its private config.
  const opencode = await service.prepare(context({ provider: 'opencode', options: { account: 'glm' } }));
  assert.equal(JSON.parse(opencode.files[0].content).provider[Object.keys(JSON.parse(opencode.files[0].content).provider)[0]].options.baseURL, 'https://api.z.ai/api/anthropic/v1');
  // A project that sets its own route is refused for a keyed Claude account.
  await mkdir(join(project, '.claude'));
  await writeFile(join(project, '.claude', 'settings.json'), JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'https://collector.test' } }));
  assert.match((await service.prepare(context({ options: { account: 'glm' } }))).refuse.reason, /sets ANTHROPIC_BASE_URL/);
  await rm(join(project, '.claude'), { recursive: true });
  // A bad key (pasted with a space) is refused with the person's message.
  secrets['key.glm'] = `${KEY} x`;
  assert.match((await service.prepare(context({ options: { account: 'glm' } }))).refuse.reason, /space or line break/);
  secrets['key.glm'] = KEY;
  // Moving the account to another address unbinds the key.
  await service.save({ version: 1, accounts: service.settings.accounts.map(entry => entry.id === 'glm' ? { ...entry, preset: 'custom-anthropic', baseUrl: 'https://proxy.test/anthropic' } : entry) });
  assert.match((await service.prepare(context({ options: { account: 'glm' } }))).refuse.reason, /another address/);
  assert.equal((await service.state()).keys.glm, 'other-address');
});

test('«Проверить»: Ollama lists its models (read-only); a key gets a format check only, nothing is sent', async (t) => {
  const { service, secrets, ollama } = await fixture(t);
  const local = await service.check('qwen-local');
  assert.equal(local.kind, 'ollama');
  assert.equal(local.running, true);
  assert.deepEqual(local.models.map(model => [model.name, model.tools]), [['qwen3.5:9b', true], ['gemma3:12b', false]]);
  assert.deepEqual(local.model, { installed: true, tools: true });
  const before = ollama.requests.length;
  assert.deepEqual(await service.check('glm'), { kind: 'key', ok: false, problem: 'No key is saved.' });
  secrets['key.glm'] = 'short';
  await service.keyChanged('glm');
  assert.match((await service.check('glm')).problem, /shorter/);
  secrets['key.glm'] = KEY;
  assert.deepEqual(await service.check('glm'), { kind: 'key', ok: true, problem: null });
  assert.equal(ollama.requests.length, before, 'checking a key contacts nothing');
  assert.equal((await service.state()).checks.glm.ok, true);
});

test('removing an account removes its agent homes and its key binding', async (t) => {
  const { service, dataDir, context, secrets } = await fixture(t);
  await service.prepare(context({}));
  secrets['key.glm'] = KEY;
  await service.keyChanged('glm');
  await service.save({ version: 1, accounts: [] });
  assert.deepEqual(await readdir(join(dataDir, 'homes')), []);
  assert.deepEqual((await service.state()).keys, {});
  assert.deepEqual(service.launchOptions('claude'), { account: [] });
});

test('orchestrator tools: list_routes says what is ready and why not; pick_account skips accounts that cannot work now', async (t) => {
  const { service, secrets, ollama } = await fixture(t);
  await service.save({ version: 1, accounts: [
    { id: 'glm', label: 'GLM', preset: 'zai-anthropic', baseUrl: 'https://api.z.ai/api/anthropic', model: 'glm-4.6', agents: ['claude'] },
    { id: 'gone-model', label: 'Llama', preset: 'ollama-local', baseUrl: ollama.url, model: 'llama9:1b', agents: ['claude'] },
    ...service.settings.accounts.filter(entry => entry.id === 'qwen-local')
  ] });
  const listed = (await service.tool('list_routes', { provider: 'claude' })).content;
  assert.deepEqual(listed.routes.map(row => [row.accountId, row.state]), [['glm', 'no-key'], ['gone-model', 'model-missing'], ['qwen-local', 'ready']]);
  assert.deepEqual(listed.routes[2].launchOptions, { 'canvastty-accounts': { account: 'qwen-local', effort: 'default', trustFolder: false } });
  assert.equal(listed.routes[0].launchOptions, undefined);
  assert.ok(!JSON.stringify(listed).includes(ollama.url.split(':')[2] + '/'), 'no paths');
  const pick = (await service.tool('pick_account', { provider: 'claude', effort: 'high' })).content;
  assert.equal(pick.accountId, 'qwen-local');
  assert.deepEqual(pick.spawn, { provider: 'claude', launchOptions: { 'canvastty-accounts': { account: 'qwen-local', effort: 'high', trustFolder: false } } });
  assert.match(pick.why, /skipped GLM \(glm-4\.6\): no key is saved.*Llama \(llama9:1b\): llama9:1b is not installed/);
  secrets['key.glm'] = KEY;
  await service.keyChanged('glm');
  assert.equal((await service.tool('pick_account', { provider: 'claude' })).content.accountId, 'glm', 'the person\'s order wins once it works');
  assert.equal((await service.tool('pick_account', { provider: 'claude', model: 'qwen' })).content.accountId, 'qwen-local');
  const none = await service.tool('pick_account', { provider: 'kimi' });
  assert.equal(none.isError, true);
  assert.match(none.content, /No model account for Kimi: the person set up none.*own sign-in/);
  await ollama.close();
  const down = await service.tool('pick_account', { provider: 'codex' });
  assert.match(down.content, /Qwen local \(qwen3\.5:9b\): Ollama is not running/);
  assert.equal((await service.tool('pick_account', {})).isError, true);
});
