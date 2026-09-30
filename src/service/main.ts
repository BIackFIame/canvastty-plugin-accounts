// Service entry (bundled to services/accounts.mjs): wires the Accounts service to CanvasTTY's JSON-RPC protocol.
import { serve, type Host } from '../rpc.ts';
import { AccountsService, type LaunchContext } from './accounts.ts';

// Requests that arrive while the service is still reading its storage wait for it (CanvasTTY's own timeouts bound
// the wait; a launch that is not answered is refused there, never started without its account).
let resolveReady: (service: AccountsService) => void;
const ready = new Promise<AccountsService>(resolve => { resolveReady = resolve; });
const service = async (): Promise<AccountsService> => { const accounts = await ready; await accounts.load(); return accounts; };

serve({
  onInitialize: async (params, host: Host) => {
    const dataDir = typeof params.dataDir === 'string' ? params.dataDir : process.cwd();
    // A failed read is not "nothing saved": the service then reads again on each request and refuses until it can,
    // so an empty list is never shown or saved over the person's accounts.
    const read = await host.callHost('storage.get', { key: 'accounts' }).then(value => ({ value }), () => null);
    if (!read) host.log('warn', 'The saved accounts could not be read; reading them again on the next request.');
    resolveReady(new AccountsService({ host, dataDir, ...(read ? { saved: read.value } : { unread: true }) }));
  },
  methods: {
    // Host-only requests.
    'canvastty.launch.options': async params => (await service()).launchOptions(params.provider),
    'canvastty.launch.prepare': async params => (await service()).prepare(params as unknown as LaunchContext),
    'canvastty.tools.call': async params => (await service()).tool(String(params.tool), (params.input ?? {}) as Record<string, unknown>),
    // The settings page.
    state: async () => (await service()).state(),
    save: async params => (await service()).save(params.settings),
    check: async params => (await service()).check(params.accountId),
    keyChanged: async params => (await service()).keyChanged(params.accountId)
  }
});
