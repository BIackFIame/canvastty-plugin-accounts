/**
 * L27: what an API key may contain. A real key is one run of printable characters; a stray space, line break, quote or
 * backslash comes from copying it badly. OpenCode substitutes `{env:…}` into its JSON config as raw text, so a
 * backslash or a quote made the config invalid and OpenCode printed the whole config, key included, on its screen.
 *
 * Shared by main and renderer: no Node APIs.
 */

export type ApiKeyProblem = "whitespace" | "control" | "quote" | "backslash";

/** The first problem of an already trimmed key, or null when it can be stored and substituted as it is. */
export function apiKeyProblem(key: string): ApiKeyProblem | null {
  if (/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(key)) return /[\t\n\r]/u.test(key) ? "whitespace" : "control";
  if (/\s/u.test(key)) return "whitespace";
  if (key.includes('"')) return "quote";
  if (key.includes("\\")) return "backslash";
  return null;
}

const WHAT: Record<ApiKeyProblem, string> = {
  whitespace: "a space or line break",
  control: "a control character",
  quote: "a double quote",
  backslash: "a backslash"
};

/** The person's message (English; the renderer shows its own translation of the same check). */
export function apiKeyProblemMessage(problem: ApiKeyProblem): string {
  return `The key contains ${WHAT[problem]}; copy it again from the provider's page.`;
}

/** A key the person saves (the secret IPC): trimmed, and refused with the person's message when it still has a
 * problem. Anything but a string is left to the vault's own checks. */
export function cleanApiKey<T>(value: T): T {
  if (typeof value !== "string") return value;
  const key = value.trim();
  const problem = apiKeyProblem(key);
  if (problem) throw new Error(apiKeyProblemMessage(problem));
  return key as T;
}

/** Why a stored key would break OpenCode's `{env:…}` substitution (it changes when written into a JSON string), or
 * null. Keys saved before L27 were not checked, so launches check again. */
export function envSubstitutionProblem(key: string): ApiKeyProblem | null {
  if (JSON.stringify(key).slice(1, -1) === key) return null;
  return apiKeyProblem(key) ?? "control";
}

/** The launch refusal for such a key: OpenCode is not started, so it cannot print its config with the key. */
export function openCodeKeyRefusal(problem: ApiKeyProblem): string {
  return `OpenCode was not started: ${apiKeyProblemMessage(problem).replace(/^The key/u, "the API key")} Save it again in Settings.`;
}
