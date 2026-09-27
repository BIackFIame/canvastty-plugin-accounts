/**
 * Reasoning effort per launch (#69): how hard a reasoning model thinks. Only levels verified against each CLI
 * (`claude --help`, `grok --help`, Codex's `model_reasoning_effort` config reference); other agents select effort
 * through the model, so asking for one there refuses the launch instead of being ignored.
 */
export const REASONING_EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
export type ReasoningEffort = typeof REASONING_EFFORTS[number];

export const PROVIDER_EFFORTS: Readonly<Record<string, readonly ReasoningEffort[]>> = Object.freeze({
  codex: ['minimal', 'low', 'medium', 'high', 'xhigh'],
  claude: ['low', 'medium', 'high', 'xhigh', 'max'],
  grok: ['low', 'medium', 'high', 'xhigh']
});

export const isEffort = (value: unknown): value is ReasoningEffort => typeof value === 'string' && (REASONING_EFFORTS as readonly string[]).includes(value);

/** The CLI's own flag for `effort`; "default" adds nothing. Throws a sentence for the card when the agent has no such level. */
export function effortArguments(provider: string, effort: string): string[] {
  if (effort === 'default' || effort === '') return [];
  if (!isEffort(effort)) throw new Error(`Unknown reasoning effort ${effort.slice(0, 20)}.`);
  const levels = PROVIDER_EFFORTS[provider];
  if (!levels) throw new Error(`${provider} sets its reasoning effort through the model; choose "Default" for it.`);
  if (!levels.includes(effort)) throw new Error(`${provider} has no reasoning effort "${effort}"; it takes ${levels.join(', ')}.`);
  if (provider === 'codex') return ['-c', `model_reasoning_effort="${effort}"`];
  if (provider === 'claude') return ['--effort', effort];
  return ['--reasoning-effort', effort];
}
