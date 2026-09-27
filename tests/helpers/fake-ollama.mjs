// A stand-in for an Ollama server (v0.34.x answers) on 127.0.0.1:0: /api/version, /api/status, /api/tags, /api/show
// and /api/ps. Read-only like the plugin's own use of it; every request is recorded.
import { createServer } from 'node:http';

export const MODELS = [
  { name: 'qwen3.5:9b', capabilities: ['completion', 'tools', 'thinking'], details: { parameter_size: '9.7B', context_length: 262144 } },
  { name: 'gemma3:12b', capabilities: ['completion', 'vision'], details: { parameter_size: '12.2B' } },
  { name: 'gpt-oss:120b-cloud', capabilities: ['completion', 'tools'], remote_host: 'https://ollama.com:443', details: {} }
];

export async function startFakeOllama({ version = '0.34.4', models = MODELS, cloudDisabled = false, numCtx = null, loaded = [] } = {}) {
  const requests = [];
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      requests.push({ method: request.method, path: request.url, body: body ? JSON.parse(body) : null, authorization: request.headers.authorization ?? null });
      const send = (status, value) => { response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(value)); };
      if (request.url === '/api/version') return send(200, { version });
      if (request.url === '/api/status') return send(200, { cloud: { disabled: cloudDisabled } });
      if (request.url === '/api/tags') return send(200, { models: models.map(model => ({ name: model.name, model: model.name, digest: 'f'.repeat(64), ...model })) });
      if (request.url === '/api/ps') return send(200, { models: loaded });
      if (request.url === '/api/show' && request.method === 'POST') {
        const wanted = JSON.parse(body).model.replace(/:local$/u, '');
        const model = models.find(entry => entry.name === wanted);
        if (!model) return send(404, { error: 'model not found' });
        if (model.remote_host) return send(404, { error: 'model is not local' });
        return send(200, { capabilities: model.capabilities, model_info: { 'general.architecture': 'qwen3', 'qwen3.context_length': model.details.context_length ?? 32768 },
          parameters: numCtx ? `num_ctx ${numCtx}` : '' });
      }
      send(404, { error: 'not found' });
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${server.address().port}`, requests, close: () => new Promise(resolve => server.close(resolve)) };
}
