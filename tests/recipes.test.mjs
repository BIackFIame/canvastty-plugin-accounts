// L22 recipes (pure) and the account model: what each agent CLI receives for one account, and which accounts are valid.
import assert from 'node:assert/strict';
import test from 'node:test';
import { buildHarnessLaunch, codexTrustArguments, MODEL_KEY_ENV, openCodeAnthropicBase } from '../src/launch/harness.ts';
import { effortArguments } from '../src/launch/effort.ts';
import {
  accountKeyed, harnessSupport, loadSettings, newAccountId, normalizeOllamaServerUrl, ollamaWireModel, supportedHarnesses, validateAccount, validateSettings
} from '../src/shared/accounts.ts';
import { apiKeyProblem, envSubstitutionProblem } from '../src/shared/apiKeyHygiene.ts';

const HOME = '/data/homes/claude-glm';
const SECRET = 'key.glm';
const base = { providerId: 'canvastty_abc', home: HOME };
const flat = (plan) => JSON.stringify(plan);

test('Claude on local Ollama: server root, placeholder token, every model tier, own home, route repeated in --settings', () => {
  const plan = buildHarnessLaunch({ ...base, harness: 'claude', protocol: 'ollama', ollamaShape: 'local', baseUrl: 'http://127.0.0.1:11434', model: 'qwen3.5:9b:local', contextWindow: 65536, disableWebSearch: true });
  assert.equal(plan.env.ANTHROPIC_BASE_URL, 'http://127.0.0.1:11434');
  assert.equal(plan.env.ANTHROPIC_AUTH_TOKEN, 'ollama');
  assert.equal(plan.env.ANTHROPIC_API_KEY, '', 'set and empty so an inherited key cannot win');
  for (const name of ['ANTHROPIC_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL', 'CLAUDE_CODE_SUBAGENT_MODEL']) assert.equal(plan.env[name], 'qwen3.5:9b:local', name);
  for (const name of ['CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX']) assert.equal(plan.env[name], '', name);
  assert.equal(plan.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW, '65536');
  assert.equal(plan.env.CLAUDE_CONFIG_DIR, HOME);
  assert.deepEqual(plan.secretEnv, {});
  assert.deepEqual(JSON.parse(plan.args[1]), { env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:11434', ANTHROPIC_API_KEY: '' } });
  assert.deepEqual(plan.args.slice(2), ['--model', 'qwen3.5:9b:local', '--disallowedTools', 'WebSearch']);
  assert.ok(Object.keys(plan.env).length <= 32, 'CanvasTTY takes at most 32 variables');
  assert.ok(plan.args.every(arg => arg.length <= 1024), 'and arguments of at most 1024 characters');
});

test('Claude on an Anthropic-compatible API (Z.AI): the key only as a secret variable, never in argv or files', () => {
  const plan = buildHarnessLaunch({ ...base, harness: 'claude', protocol: 'anthropic', baseUrl: 'https://api.z.ai/api/anthropic', model: 'glm-4.6', secretKey: SECRET });
  assert.deepEqual(plan.secretEnv, { ANTHROPIC_AUTH_TOKEN: SECRET });
  assert.equal(plan.env.ANTHROPIC_AUTH_TOKEN, undefined);
  assert.equal(plan.env.ANTHROPIC_BASE_URL, 'https://api.z.ai/api/anthropic');
  assert.equal(JSON.parse(plan.args[1]).env.ANTHROPIC_BASE_URL, 'https://api.z.ai/api/anthropic', 'a project\'s settings cannot redirect the key');
  assert.ok(!plan.args.includes('--disallowedTools'));
  assert.deepEqual(plan.files, []);
});

test('Codex on local Ollama: -c provider with the Responses wire API, a private catalog, the account home, no auth', () => {
  const plan = buildHarnessLaunch({ ...base, home: '/data/homes/codex-q', harness: 'codex', protocol: 'ollama', ollamaShape: 'local', baseUrl: 'http://127.0.0.1:11434', model: 'qwen3.5:9b:local', contextWindow: 32768, disableWebSearch: true, trustedFolders: ['/work/app'] });
  assert.deepEqual(plan.args, [
    '-c', 'model_provider="canvastty_abc"',
    '-c', 'model_providers.canvastty_abc.name="CanvasTTY"',
    '-c', 'model_providers.canvastty_abc.base_url="http://127.0.0.1:11434/v1/"',
    '-c', 'model_providers.canvastty_abc.wire_api="responses"',
    '-c', "model_catalog_json='{launchFiles}/codex-model.json'",
    '-c', 'web_search="disabled"',
    '-c', 'projects={"/work/app"={trust_level="trusted"}}',
    '--model', 'qwen3.5:9b:local'
  ]);
  assert.deepEqual(plan.env, { CODEX_HOME: '/data/homes/codex-q', CODEX_API_KEY: '', CODEX_ACCESS_TOKEN: '' });
  assert.deepEqual(plan.secretEnv, {});
  const catalog = JSON.parse(plan.files[0].content);
  assert.equal(plan.files[0].relPath, 'codex-model.json');
  assert.equal(catalog.models[0].slug, 'qwen3.5:9b:local');
  assert.equal(catalog.models[0].context_window, 32768);
  assert.equal(catalog.models[0].truncation_policy.mode, 'bytes');
  assert.ok(!plan.args.some(arg => /--oss|--profile/u.test(arg)), 'never --oss (downloads) or --profile (a file in ~/.codex)');
});

test('Codex on a Responses endpoint with a key: env_key names the variable CanvasTTY fills from the secret', () => {
  const plan = buildHarnessLaunch({ ...base, harness: 'codex', protocol: 'openai', baseUrl: 'https://openrouter.ai/api/v1', model: 'z-ai/glm-4.6', secretKey: SECRET });
  assert.ok(plan.args.includes(`model_providers.canvastty_abc.env_key="${MODEL_KEY_ENV}"`));
  assert.ok(plan.args.includes('model_providers.canvastty_abc.base_url="https://openrouter.ai/api/v1"'));
  assert.deepEqual(plan.secretEnv, { [MODEL_KEY_ENV]: SECRET });
  assert.equal(JSON.parse(plan.files[0].content).models[0].context_window, 128000, 'Codex\'s own fallback when nothing is known');
  assert.deepEqual(codexTrustArguments([]), []);
});

test('OpenCode: a private OPENCODE_CONFIG (CanvasTTY owns OPENCODE_CONFIG_CONTENT); Anthropic APIs get /v1 (L28)', () => {
  const anthropic = buildHarnessLaunch({ ...base, harness: 'opencode', protocol: 'anthropic', baseUrl: 'https://api.minimax.io/anthropic', model: 'MiniMax-M2', secretKey: SECRET });
  assert.deepEqual(anthropic.env, { OPENCODE_CONFIG: '{launchFiles}/opencode.json' });
  assert.deepEqual(anthropic.secretEnv, { [MODEL_KEY_ENV]: SECRET });
  const config = JSON.parse(anthropic.files[0].content);
  assert.equal(config.provider.canvastty_abc.npm, '@ai-sdk/anthropic');
  assert.equal(config.provider.canvastty_abc.options.baseURL, 'https://api.minimax.io/anthropic/v1');
  assert.equal(config.provider.canvastty_abc.options.apiKey, `{env:${MODEL_KEY_ENV}}`);
  assert.equal(config.model, 'canvastty_abc/MiniMax-M2');
  assert.deepEqual(anthropic.args, ['--model', 'canvastty_abc/MiniMax-M2']);
  assert.equal(openCodeAnthropicBase('https://x.test/v1/'), 'https://x.test/v1');
  const ollama = buildHarnessLaunch({ ...base, harness: 'opencode', protocol: 'ollama', ollamaShape: 'local', baseUrl: 'http://127.0.0.1:11434', model: 'qwen3.5:9b:local', contextWindow: 65536 });
  const local = JSON.parse(ollama.files[0].content).provider.canvastty_abc;
  assert.equal(local.npm, '@ai-sdk/openai-compatible');
  assert.equal(local.options.baseURL, 'http://127.0.0.1:11434/v1');
  assert.equal(local.options.apiKey, undefined);
  assert.equal(local.models['qwen3.5:9b:local'].limit.context, 65536);
  assert.deepEqual(ollama.secretEnv, {});
});

test('Qwen Code and Kimi: OPENAI_* or an openai_legacy alias; Kimi\'s key only in a private run file', () => {
  const qwen = buildHarnessLaunch({ ...base, harness: 'qwen', protocol: 'ollama', ollamaShape: 'local', baseUrl: 'http://127.0.0.1:11434', model: 'qwen3.5:9b:local' });
  assert.deepEqual(qwen.args, ['--auth-type', 'openai', '--model', 'qwen3.5:9b:local']);
  assert.deepEqual(qwen.env, { OPENAI_BASE_URL: 'http://127.0.0.1:11434/v1', OPENAI_MODEL: 'qwen3.5:9b:local', OPENAI_API_KEY: 'ollama' });
  const keyedQwen = buildHarnessLaunch({ ...base, harness: 'qwen', protocol: 'openai', baseUrl: 'https://api.z.ai/api/paas/v4', model: 'glm-4.6', secretKey: SECRET });
  assert.deepEqual(keyedQwen.secretEnv, { OPENAI_API_KEY: SECRET });
  assert.equal(keyedQwen.env.OPENAI_API_KEY, undefined);
  const kimi = buildHarnessLaunch({ ...base, harness: 'kimi', protocol: 'ollama', ollamaShape: 'local', baseUrl: 'http://127.0.0.1:11434', model: 'qwen3.5:9b:local', contextWindow: 65536 });
  assert.equal(kimi.args[0], '--config');
  const config = JSON.parse(kimi.args[1]);
  assert.deepEqual(config.providers.canvastty, { type: 'openai_legacy', base_url: 'http://127.0.0.1:11434/v1', api_key: 'ollama' });
  assert.equal(config.models.canvastty.max_context_size, 65536);
  const key = ['fixture', 'kimi', 'key', '0123456789abcdef'].join('-');
  const keyedKimi = buildHarnessLaunch({ ...base, harness: 'kimi', protocol: 'openai', baseUrl: 'https://api.moonshot.ai/v1', model: 'kimi-k2', secretKey: SECRET, keyValue: key });
  assert.deepEqual(keyedKimi.args, ['--config-file', '{launchFiles}/kimi-config.json']);
  assert.ok(!keyedKimi.args.join(' ').includes(key));
  assert.equal(JSON.parse(keyedKimi.files[0].content).providers.canvastty.api_key, key);
  assert.throws(() => buildHarnessLaunch({ ...base, harness: 'kimi', protocol: 'openai', baseUrl: 'https://api.moonshot.ai/v1', model: 'kimi-k2', secretKey: SECRET }), /Kimi needs the account key/);
});

test('a keyed account never builds without its key; Ollama needs its checked shape', () => {
  assert.throws(() => buildHarnessLaunch({ ...base, harness: 'claude', protocol: 'anthropic', baseUrl: 'https://api.z.ai/api/anthropic', model: 'glm-4.6' }), /needs a key/);
  assert.throws(() => buildHarnessLaunch({ ...base, harness: 'claude', protocol: 'ollama', ollamaShape: 'cloud-direct', baseUrl: 'https://ollama.com', model: 'glm-4.6' }), /needs a key/);
  assert.throws(() => buildHarnessLaunch({ ...base, harness: 'claude', protocol: 'ollama', baseUrl: 'http://127.0.0.1:11434', model: 'x:local' }), /checked Ollama account/);
});

test('reasoning effort uses each CLI\'s verified flag and refuses levels an agent does not have', () => {
  assert.deepEqual(effortArguments('codex', 'high'), ['-c', 'model_reasoning_effort="high"']);
  assert.deepEqual(effortArguments('claude', 'max'), ['--effort', 'max']);
  assert.deepEqual(effortArguments('grok', 'xhigh'), ['--reasoning-effort', 'xhigh']);
  assert.deepEqual(effortArguments('opencode', 'default'), []);
  assert.throws(() => effortArguments('claude', 'minimal'), /no reasoning effort "minimal"/);
  assert.throws(() => effortArguments('qwen', 'high'), /through the model/);
  assert.throws(() => effortArguments('codex', 'turbo'), /Unknown reasoning effort/);
});

const account = (patch = {}) => ({ id: 'q', label: 'Qwen local', preset: 'ollama-local', baseUrl: 'http://127.0.0.1:11434', model: 'qwen3.5:9b', agents: ['claude', 'codex'], ...patch });

test('accounts: presets decide the protocol, the agents that can use it and whether a key is needed', () => {
  assert.deepEqual(validateAccount(account()), account());
  assert.equal(validateAccount(account({ baseUrl: 'localhost' })).baseUrl, 'http://127.0.0.1:11434');
  assert.equal(normalizeOllamaServerUrl('127.0.0.1:11500/'), 'http://127.0.0.1:11500');
  assert.throws(() => validateAccount(account({ baseUrl: 'http://10.0.0.5:11434' })), /loopback/);
  assert.throws(() => validateAccount(account({ model: 'gpt-oss:120b-cloud' })), /Ollama Cloud/);
  assert.throws(() => validateAccount(account({ preset: 'ollama-cloud-local', model: 'qwen3.5:9b' })), /not an Ollama Cloud name/);
  assert.equal(validateAccount(account({ preset: 'ollama-cloud-local', model: 'gpt-oss:120b-cloud' })).model, 'gpt-oss:120b-cloud');
  assert.throws(() => validateAccount(account({ preset: 'ollama-cloud', baseUrl: 'https://evil.test' })), /ollama\.com/);
  const glm = validateAccount({ id: 'glm', label: 'GLM', preset: 'zai-anthropic', baseUrl: 'https://api.z.ai/api/anthropic/', model: 'glm-4.6', agents: ['claude', 'opencode'] });
  assert.equal(glm.baseUrl, 'https://api.z.ai/api/anthropic');
  assert.equal(accountKeyed(glm), true);
  assert.equal(accountKeyed(account()), false);
  assert.throws(() => validateAccount({ ...glm, agents: ['codex'] }), /Codex cannot run on Z.AI · Anthropic API/);
  assert.throws(() => validateAccount({ ...glm, baseUrl: 'http://api.z.ai/api/anthropic' }), /https/);
  assert.throws(() => validateAccount({ ...glm, baseUrl: 'https://user:pw@api.z.ai' }), /user name or password/);
  const router = { id: 'or', label: 'OR', preset: 'openrouter-openai', baseUrl: 'https://openrouter.ai/api/v1', model: 'z-ai/glm-4.6', agents: ['codex'] };
  assert.throws(() => validateAccount(router), /Responses API/);
  assert.deepEqual(validateAccount({ ...router, responsesApi: true }).agents, ['codex']);
  assert.deepEqual(supportedHarnesses({ preset: 'openrouter-openai' }), ['opencode', 'qwen', 'kimi']);
  assert.equal(harnessSupport('claude', { preset: 'minimax-openai' }).ok, false);
  assert.throws(() => validateAccount(account({ agents: [] })), /at least one agent/);
  assert.throws(() => validateAccount(account({ extra: 1 })), /Unknown account field/);
  assert.throws(() => validateSettings({ accounts: [account(), account()] }), /Two accounts/);
  assert.deepEqual(loadSettings({ accounts: [account(), { id: 'bad' }] }).accounts.map(entry => entry.id), ['q']);
  assert.equal(newAccountId('Claude Code · GLM 4.6', new Set(['claude-code-glm-4-6'])), 'claude-code-glm-4-6-2');
});

test('Ollama model names: a local account pins name:local; cloud names never go through a local account', () => {
  assert.deepEqual(ollamaWireModel('local', 'qwen3.5:9b'), { ok: true, model: 'qwen3.5:9b:local' });
  assert.deepEqual(ollamaWireModel('local', 'gpt-oss:120b-cloud'), { ok: false, reason: 'cloud-on-local' });
  assert.deepEqual(ollamaWireModel('cloud-local', 'gpt-oss:120b-cloud'), { ok: true, model: 'gpt-oss:120b-cloud' });
  assert.deepEqual(ollamaWireModel('cloud-direct', 'gpt-oss:120b:cloud'), { ok: true, model: 'gpt-oss:120b' });
});

test('key hygiene (L27): a pasted key with a space, quote or backslash is refused; OpenCode substitution is checked', () => {
  const good = ['sk', 'or', 'v1', 'a'.repeat(32)].join('-');
  assert.equal(apiKeyProblem(good), null);
  assert.equal(apiKeyProblem(`${good} x`), 'whitespace');
  assert.equal(apiKeyProblem(`${good}"`), 'quote');
  assert.equal(apiKeyProblem(`${good}\\`), 'backslash');
  assert.equal(envSubstitutionProblem(good), null);
  assert.equal(envSubstitutionProblem(`${good}\u0001`), 'control');
  assert.ok(!flat(buildHarnessLaunch({ ...base, harness: 'codex', protocol: 'openai', baseUrl: 'https://x.test/v1', model: 'm', secretKey: SECRET })).includes(good));
});
