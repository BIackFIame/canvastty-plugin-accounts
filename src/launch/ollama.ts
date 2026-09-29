/**
 * Reads an Ollama server for the settings page («Проверить» lists its models) and for the launch preflight (L22
 * OllamaDiscovery + the assistant's probe). Only on the person's action or a launch — nothing polls. Read-only:
 * GET /api/version, /api/status, /api/tags, /api/ps and POST /api/show; never `ollama serve`, `pull`, `signin` or a model
 * load. A loopback server gets no Authorization header. Redirects are errors; answers are bounded.
 */
import { AGENT_MIN_CONTEXT, OLLAMA_MIN_LOCAL_PIN, OLLAMA_MIN_MESSAGES, OLLAMA_MIN_RESPONSES, canonicalOllamaName, compareVersions, parseOllamaModelRef, validOllamaModelName } from '../shared/ollamaModelRef.ts';
import { loopbackServerRoot, ollamaWireModel, type Harness, type OllamaShape } from '../shared/accounts.ts';

const MAX_BODY = 4 * 1024 * 1024;
const MAX_MODELS = 200;

function isRecord(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value); }
const positive = (value: unknown): number | null => typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null;
const shortText = (value: unknown, limit = 40): string | null => typeof value === 'string' && value.length > 0 && value.length <= limit && !/[\u0000-\u001f\u007f]/u.test(value) ? value : null;
const remote = (entry: Record<string, unknown>): boolean => typeof entry.remote_host === 'string' && entry.remote_host.length > 0 || typeof entry.remote_model === 'string' && entry.remote_model.length > 0;

/** One JSON exchange; status 0 means unreachable. */
export type OllamaHttp = (method: 'GET' | 'POST', path: string, body?: unknown) => Promise<{ status: number; json: unknown }>;
export type OllamaFetch = (url: string, init: RequestInit) => Promise<Response>;

export function ollamaHttp(baseUrl: string, transport: OllamaFetch = fetch, timeoutMs = 3_000): OllamaHttp {
  return async (method, path, body) => {
    let response: Response;
    try {
      response = await transport(`${baseUrl}${path}`, {
        method, redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
        headers: { Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) })
      });
    } catch { return { status: 0, json: null }; }
    const length = Number(response.headers.get('content-length') ?? 0);
    if (length > MAX_BODY) { await response.body?.cancel().catch(() => undefined); return { status: response.status, json: null }; }
    const text = await response.text().catch(() => '');
    if (text.length > MAX_BODY) return { status: response.status, json: null };
    try { return { status: response.status, json: text ? JSON.parse(text) as unknown : null }; } catch { return { status: response.status, json: null }; }
  };
}

export interface OllamaModel {
  name: string;
  source: 'local' | 'cloud';
  parameterSize: string | null;
  capabilities: string[];
  /** tools + completion: can drive an agent CLI. */
  agentReady: boolean;
}

export interface OllamaDetection {
  running: boolean;
  version: string | null;
  /** ≥ 0.18.0: the server enforces `name:local`. */
  supportsLocalPin: boolean;
  cloudDisabled: boolean | null;
  models: OllamaModel[];
  problem: 'down' | 'not-ollama' | 'list-failed' | 'invalid-url' | null;
}

export function listedModel(entry: unknown): OllamaModel | null {
  if (!isRecord(entry)) return null;
  const name = typeof entry.name === 'string' ? entry.name : typeof entry.model === 'string' ? entry.model : null;
  if (!validOllamaModelName(name)) return null;
  const details = isRecord(entry.details) ? entry.details : {};
  const cloud = parseOllamaModelRef(name).source === 'cloud' || remote(entry);
  const capabilities = Array.isArray(entry.capabilities) ? entry.capabilities.filter((item): item is string => typeof item === 'string' && item.length <= 32).slice(0, 16) : [];
  return { name, source: cloud ? 'cloud' : 'local', parameterSize: shortText(details.parameter_size), capabilities, agentReady: capabilities.includes('tools') && capabilities.includes('completion') };
}

/** «Проверить» on an Ollama account on this computer: version, cloud status and models. */
export async function detectOllama(baseUrl: string, transport?: OllamaFetch, timeoutMs?: number): Promise<OllamaDetection> {
  const base = baseUrl.replace(/\/+$/u, '');
  const empty = (problem: OllamaDetection['problem'], extra: Partial<OllamaDetection> = {}): OllamaDetection => ({ running: false, version: null, supportsLocalPin: false, cloudDisabled: null, models: [], problem, ...extra });
  if (!loopbackServerRoot(base)) return empty('invalid-url');
  const http = ollamaHttp(base, transport, timeoutMs);
  const version = await http('GET', '/api/version');
  if (version.status === 0) return empty('down');
  const versionText = isRecord(version.json) ? shortText(version.json.version, 64) : null;
  if (version.status !== 200 || !versionText) return empty('not-ollama');
  const status = await http('GET', '/api/status');
  const cloud = status.status === 200 && isRecord(status.json) && isRecord(status.json.cloud) ? status.json.cloud : null;
  const cloudDisabled = cloud && typeof cloud.disabled === 'boolean' ? cloud.disabled : null;
  const tags = await http('GET', '/api/tags');
  const running = { running: true, version: versionText, supportsLocalPin: compareVersions(versionText, OLLAMA_MIN_LOCAL_PIN) >= 0, cloudDisabled };
  if (tags.status !== 200 || !isRecord(tags.json) || !Array.isArray(tags.json.models)) return { ...running, models: [], problem: 'list-failed' };
  const models = tags.json.models.slice(0, MAX_MODELS).map(listedModel).filter((model): model is OllamaModel => model !== null);
  return { ...running, models, problem: null };
}

interface ModelProbe {
  version: string | null;
  localPin: boolean;
  cloudDisabled: boolean | null;
  locality: 'local' | 'ollama-cloud';
  requestName: string;
  installed: boolean;
  capabilities: string[] | null;
  contextLength: number | null;
  modelfileNumCtx: number | null;
}

/**
 * The assistant's probe, trimmed to what a launch needs: the model counts as local only when its name is not cloud,
 * neither /api/tags nor /api/show reports remote_host, and the server enforces the `:local` pin (≥ 0.18.0).
 */
export async function probeModel(http: OllamaHttp, model: string): Promise<ModelProbe> {
  const ref = parseOllamaModelRef(model);
  if (ref.source === 'local') throw new Error('Give the model name without :local; the plugin adds the pin itself.');
  let cloud = ref.source === 'cloud';
  const versionReply = await http('GET', '/api/version');
  if (versionReply.status === 0) throw new Error('Ollama is not running. Open Ollama or run `ollama serve`.');
  if (versionReply.status !== 200) throw new Error('This address does not answer like an Ollama server.');
  const version = isRecord(versionReply.json) ? shortText(versionReply.json.version, 64) : null;
  const localPin = compareVersions(version, OLLAMA_MIN_LOCAL_PIN) >= 0;
  const statusReply = await http('GET', '/api/status');
  const cloudStatus = isRecord(statusReply.json) && isRecord(statusReply.json.cloud) ? statusReply.json.cloud : null;
  const cloudDisabled = statusReply.status === 200 && cloudStatus && typeof cloudStatus.disabled === 'boolean' ? cloudStatus.disabled : null;
  const tags = await http('GET', '/api/tags');
  if (tags.status !== 200) throw new Error('The Ollama server did not list its models.');
  const listed = isRecord(tags.json) && Array.isArray(tags.json.models) ? tags.json.models.filter(isRecord) : [];
  const wanted = canonicalOllamaName(model);
  const entry = listed.find(item => item.name === model || item.model === model || item.name === wanted || item.model === wanted) ?? null;
  if (entry && remote(entry)) cloud = true;
  let capabilities: string[] | null = entry && Array.isArray(entry.capabilities) ? entry.capabilities.filter((item): item is string => typeof item === 'string') : null;
  let contextLength: number | null = entry && isRecord(entry.details) ? positive(entry.details.context_length) : null;
  let modelfileNumCtx: number | null = null;
  if (!cloud && entry) {
    const show = await http('POST', '/api/show', { model: localPin ? `${model}:local` : model });
    if (show.status === 200 && isRecord(show.json)) {
      if (remote(show.json)) cloud = true;
      if (Array.isArray(show.json.capabilities)) capabilities = show.json.capabilities.filter((item): item is string => typeof item === 'string');
      const info = isRecord(show.json.model_info) ? show.json.model_info : null;
      const arch = info && typeof info['general.architecture'] === 'string' ? info['general.architecture'] : null;
      contextLength = (info && arch ? positive(info[`${arch}.context_length`]) : null) ?? contextLength;
      const numCtx = typeof show.json.parameters === 'string' ? /(?:^|\n)\s*num_ctx\s+(\d{1,9})\s*(?:\n|$)/u.exec(show.json.parameters) : null;
      modelfileNumCtx = numCtx ? positive(Number(numCtx[1])) : null;
    } else if (localPin && (show.status === 404 || show.status === 400)) {
      // The ≥ 0.18.0 guard: a pulled cloud stub requested as `name:local` is refused.
      cloud = true;
    } else throw new Error('The Ollama server could not describe the model.');
  }
  if (!localPin && cloudDisabled !== true) cloud = true;
  const locality = cloud ? 'ollama-cloud' : 'local';
  return { version, localPin, cloudDisabled, locality, requestName: locality === 'local' && localPin ? `${model}:local` : model, installed: !!entry, capabilities, contextLength, modelfileNumCtx };
}

export interface OllamaPreflight {
  /** The name the agent sends: `name:local` on a local account, the cloud name through the local server, the hosted id at ollama.com. */
  wireModel: string;
  /** The server runs Ollama Cloud features (web search on /v1/messages and /v1/responses): the agent's web search is
   *  switched off so no task text leaves this computer through it. */
  cloudFeatures: boolean;
  contextWindow: number | null;
  /** A short note for the log: the context is below what agents need, or unknown. */
  note: string | null;
}

const RUNTIME_MIN_VERSION: Partial<Record<Harness, string>> = { claude: OLLAMA_MIN_MESSAGES, codex: OLLAMA_MIN_RESPONSES };

/**
 * Why an Ollama server of `version` cannot run `harness` on an account of this shape, or null. One rule for the launch
 * preflight and for the routes orchestrators see, so a route is never "ready" for a launch that would be refused.
 */
export function ollamaVersionRefusal(shape: OllamaShape, harness: Harness, version: string | null): string | null {
  if (shape === 'cloud-direct') return null;
  if (compareVersions(version, OLLAMA_MIN_LOCAL_PIN) < 0) {
    return shape === 'cloud-local'
      ? `Ollama ${version ?? 'of unknown version'} is too old for cloud models without a pulled stub; update Ollama to ${OLLAMA_MIN_LOCAL_PIN} or later.`
      : `Ollama ${version ?? 'of unknown version'} cannot pin a model to this computer; update Ollama to ${OLLAMA_MIN_LOCAL_PIN} or later.`;
  }
  const minimum = shape === 'local' ? RUNTIME_MIN_VERSION[harness] : undefined;
  if (minimum && compareVersions(version, minimum) < 0) return `${harness} needs Ollama ${minimum} or later.`;
  return null;
}

/**
 * Checks one agent launch on an Ollama account before anything spawns (L22 preflight); refusals are plain sentences
 * for the card. The local account needs ≥ 0.18.0 (the server enforces `:local`), the model installed and local by
 * every check, and `tools` for an agent.
 */
export async function preflightOllama(input: { baseUrl: string; shape: OllamaShape; model: string; harness: Harness }, transport?: OllamaFetch, timeoutMs = 1_500): Promise<OllamaPreflight> {
  const wire = ollamaWireModel(input.shape, input.model);
  if (!wire.ok) throw new Error(wire.reason === 'cloud-on-local'
    ? `Model ${input.model} runs on Ollama Cloud; this account is for models on this computer.`
    : wire.reason === 'local-on-cloud' ? `Model ${input.model} is not an Ollama Cloud name; name it with -cloud (for example gpt-oss:120b-cloud).` : 'Choose an Ollama model.');
  if (input.shape === 'cloud-direct') return { wireModel: wire.model, cloudFeatures: true, contextWindow: null, note: null };
  const base = input.baseUrl.replace(/\/+$/u, '');
  if (!loopbackServerRoot(base)) throw new Error('An Ollama account on this computer needs a loopback server address.');
  const http = ollamaHttp(base, transport, timeoutMs);
  if (input.shape === 'cloud-local') {
    const version = await http('GET', '/api/version');
    if (version.status === 0) throw new Error('Ollama is not running. Open Ollama or run `ollama serve`.');
    const text = isRecord(version.json) ? shortText(version.json.version, 64) : null;
    const old = ollamaVersionRefusal('cloud-local', input.harness, text);
    if (old) throw new Error(old);
    const status = await http('GET', '/api/status');
    const cloud = status.status === 200 && isRecord(status.json) && isRecord(status.json.cloud) ? status.json.cloud : null;
    if (cloud?.disabled === true) throw new Error('Ollama Cloud is turned off on this server (OLLAMA_NO_CLOUD or disable_ollama_cloud).');
    return { wireModel: wire.model, cloudFeatures: true, contextWindow: null, note: null };
  }
  const probe = await probeModel(http, parseOllamaModelRef(input.model).base);
  const old = ollamaVersionRefusal('local', input.harness, probe.version);
  if (old) throw new Error(old);
  if (!probe.installed) throw new Error(`Model ${input.model} is not installed in Ollama. Run \`ollama pull ${parseOllamaModelRef(input.model).base}\` yourself, then try again.`);
  if (probe.locality !== 'local') throw new Error(`Model ${input.model} is served by Ollama Cloud (a pulled cloud model), not by this computer.`);
  const capabilities = probe.capabilities ?? [];
  if (!capabilities.includes('tools') || !capabilities.includes('completion')) throw new Error(`Model ${input.model} has no tool calling, so it cannot drive an agent. Choose a model with the «tools» badge.`);
  const ps = await http('GET', '/api/ps');
  const names = new Set([probe.requestName.replace(/:local$/u, ''), canonicalOllamaName(probe.requestName.replace(/:local$/u, ''))]);
  const running = ps.status === 200 && isRecord(ps.json) && Array.isArray(ps.json.models)
    ? ps.json.models.filter(isRecord).find(entry => names.has(String(entry.name)) || names.has(String(entry.model))) : undefined;
  const effective = (running ? positive(running.context_length) : null) ?? probe.modelfileNumCtx;
  const note = effective === null
    ? `Context of ${input.model}: the server default (4k, 32k or 256k by memory, or OLLAMA_CONTEXT_LENGTH); agents need at least ${AGENT_MIN_CONTEXT / 1000}k.`
    : effective < AGENT_MIN_CONTEXT ? `Context of ${input.model} is ${effective} tokens; agents need at least ${AGENT_MIN_CONTEXT / 1000}k.` : null;
  return { wireModel: probe.requestName, cloudFeatures: probe.cloudDisabled !== true, contextWindow: effective ?? probe.contextLength, note };
}
