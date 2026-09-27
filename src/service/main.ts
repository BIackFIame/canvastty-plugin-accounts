// Service entry (bundled to services/accounts.mjs): wires the Accounts service to CanvasTTY's JSON-RPC protocol.
import { serve, type Host } from '../rpc.ts';
import { AccountsService, type LaunchContext } from './accounts.ts';

// Requests that arrive while the service is still reading its storage wait for it (CanvasTTY's own timeouts bound
// the wait; a launch that is not answered is refused there, never started without its account).
let resolveReady: (service: AccountsService) => void;
const ready = new Promise<AccountsService>(resolve => { resolveReady = resolve; });

serve({
  onInitialize: async (params, host: Host) => {
    const dataDir = typeof params.dataDir === 'string' ? params.dataDir : process.cwd();
    const saved = await host.callHost('storage.get', { key: 'accounts' }).catch(() => null);
    resolveReady(new AccountsService({ host, dataDir, saved }));
  },
  methods: {
    // Host-only requests.
    'canvastty.launch.options': async params => (await ready).launchOptions(params.provider),
    'canvastty.launch.prepare': async params => (await ready).prepare(params as unknown as LaunchContext),
    'canvastty.tools.call': async params => (await ready).tool(String(params.tool), (params.input ?? {}) as Record<string, unknown>),
    // The settings page.
    state: async () => (await ready).state(),
    save: async params => (await ready).save(params.settings),
    check: async params => (await ready).check(params.accountId),
    keyChanged: async params => (await ready).keyChanged(params.accountId)
  }
});
