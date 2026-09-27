/**
 * Each account's own home for Claude Code (CLAUDE_CONFIG_DIR) and Codex (CODEX_HOME), under the plugin's data folder,
 * never ~/.claude or ~/.codex. It is kept between runs (L24), so the agent remembers there what the person answered
 * (folder trust, Codex's "Hooks need review") and keeps its conversations, which lets CanvasTTY continue a restored card.
 * The person's own sign-in never lives here, so it is never sent to the account's endpoint.
 */
import { createHash } from 'node:crypto';
import { chmod, lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';

export const homeFolder = (dataDir: string, harness: 'claude' | 'codex', accountId: string): string => join(dataDir, 'homes', `${harness}-${accountId}`);

/** The provider id inside Codex/OpenCode config for an account (stable, TOML-bare, not the account's name). */
export const providerIdOf = (accountId: string): string => `canvastty_${createHash('sha256').update(accountId).digest('hex').slice(0, 12)}`;

/** Creates the home (0700) and refuses a symlink or a file in its place. */
export async function ensureHome(path: string): Promise<string> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('The account\'s agent home is not a folder.');
  await chmod(path, 0o700);
  return path;
}

/**
 * Claude Code 2.1 skips its whole first-run flow (theme picker, sign-in screen) when hasCompletedOnboarding is set in
 * the config folder's .claude.json; folder trust is projects[<folder>].hasTrustDialogAccepted there (checked against
 * the claude 2.1.281 binary). Only folders the person trusted for a launch are added; anything Claude wrote is kept.
 */
export async function seedClaudeHome(home: string, trustedFolders: readonly string[]): Promise<void> {
  const path = join(home, '.claude.json');
  let current: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(await readFile(path, 'utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) current = parsed as Record<string, unknown>;
  } catch { /* first run, or unreadable: start from the seed */ }
  const projects = current.projects && typeof current.projects === 'object' && !Array.isArray(current.projects) ? { ...current.projects as Record<string, unknown> } : {};
  let changed = current.hasCompletedOnboarding !== true;
  for (const folder of trustedFolders.filter(entry => isAbsolute(entry))) {
    const entry = projects[folder] && typeof projects[folder] === 'object' ? projects[folder] as Record<string, unknown> : {};
    if (entry.hasTrustDialogAccepted === true) continue;
    projects[folder] = { ...entry, hasTrustDialogAccepted: true };
    changed = true;
  }
  if (!changed) return;
  const next = { ...current, hasCompletedOnboarding: true, ...(Object.keys(projects).length ? { projects } : {}) };
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(next), { mode: 0o600 });
  await rename(temporary, path);
}

/** Removes an account's homes when the person removes the account. */
export async function removeHomes(dataDir: string, accountId: string): Promise<void> {
  await Promise.all((['claude', 'codex'] as const).map(harness => rm(homeFolder(dataDir, harness, accountId), { recursive: true, force: true })));
}

const PROJECT_ROUTE_KEYS = /^(?:ANTHROPIC_|CLAUDE_CODE_USE_)/u;

/**
 * A keyed Claude account sends its key to ANTHROPIC_BASE_URL. `--settings` outranks a project's own settings, but a
 * project's `apiKeyHelper` or route variables would still be read with the key in place, so such a folder is refused
 * with the reason instead of being guessed about.
 */
export async function projectRouteProblem(cwd: string): Promise<string | null> {
  for (const name of ['settings.json', 'settings.local.json']) {
    let parsed: unknown;
    try { parsed = JSON.parse(await readFile(join(cwd, '.claude', name), 'utf8')); } catch { continue; }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
    const settings = parsed as Record<string, unknown>;
    if (settings.apiKeyHelper !== undefined) return `.claude/${name} in this folder sets apiKeyHelper; an account with a key is not started here.`;
    const env = settings.env && typeof settings.env === 'object' && !Array.isArray(settings.env) ? Object.keys(settings.env) : [];
    const route = env.find(key => PROJECT_ROUTE_KEYS.test(key));
    if (route) return `.claude/${name} in this folder sets ${route}; an account with a key is not started here.`;
  }
  return null;
}
