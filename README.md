# CanvasTTY Accounts

> **Status: preview.** This plugin needs CanvasTTY plugin API v2 (plugin services, launch contributors, session environments, decision hooks, plugin tools and card actions). Those extension points are proposed upstream and are not in a released CanvasTTY yet, so installing it on a current release fails the manifest check.

[Русский](README.ru.md)

Any agent on any model. Run **Claude Code, Codex, OpenCode, Qwen Code or Kimi** on a model of your choice — a local
Ollama model, Ollama Cloud, Z.AI, MiniMax, OpenRouter or any Anthropic- or OpenAI-compatible API — chosen per launch.

## Use

1. Install the plugin, then trust its native code in **Settings → Agents → Extension native code**.
2. Open **Model accounts** (the plugin's settings page) and add an account: provider (the address is filled in),
   name, model, which agents may use it. For an API, save its key (write-only). **Check** lists the models of an
   Ollama server on this computer, or checks a saved key's format — nothing is sent to a paid API.
3. In the agent launcher: **Advanced → Use CanvasTTY Accounts**, choose the **Model account**, optionally a
   **Reasoning effort** and **I trust this folder**.

Orchestrators get two tools: `canvastty-accounts__list_routes` (every account × agent, ready or why not) and
`canvastty-accounts__pick_account` (the first ready account for an agent, skipping ones that cannot work now). Both
answer with `launchOptions` to pass to `spawn_agent`.

## What it does to a launch

- Claude Code: `ANTHROPIC_BASE_URL` (Ollama gets its server root), `ANTHROPIC_AUTH_TOKEN` (the key, or `ollama` for a
  local server), every model tier set to the account's model, `--model`, and the base URL repeated in `--settings` so a
  project's settings cannot redirect the key. Claude runs in the account's own `CLAUDE_CONFIG_DIR` under the plugin's
  data folder, with onboarding done.
- Codex: a provider given only by `-c` overrides (Responses wire API), a one-model catalog in the run's private
  folder, the account's own `CODEX_HOME`, and the key's variable named by `env_key`.
- OpenCode: a private `OPENCODE_CONFIG` file (Anthropic APIs get `/v1`), the key as `{env:…}`.
- Qwen Code: `--auth-type openai` with `OPENAI_*`. Kimi: an `openai_legacy` provider in `--config` (keyless) or a
  private `--config-file`.
- Ollama on this computer: the model is pinned `name:local`, so the server itself refuses to forward it to the cloud;
  the launch checks first that Ollama runs, the model is installed and can call tools.
- Every account launch is marked `thirdPartyModel` (unless it is the agent's own vendor API: Anthropic for Claude Code,
  OpenAI for Codex), so CanvasTTY runs the **Auto** profile as accept-edits in the CLI's sandbox: the CLI's own auto
  reviewer would be the account's model, and a weak model's classifier is not a safety boundary.
- A subagent in (or below) the folder the person chose for its orchestrator: the folder CanvasTTY hands over as
  `trustedFolder` is marked trusted in the account's own Claude config (Codex gets it from CanvasTTY directly).

Keys stay in CanvasTTY's encrypted plugin secrets; CanvasTTY puts them into the agent's environment itself and masks
them in everything other agents read. Nothing is written to `~/.claude`, `~/.codex`, `~/.qwen`, `~/.kimi` or
`~/.ollama`, and the agents' own sign-ins are never used for an account's endpoint.

Needs CanvasTTY with the account launch points (`optionsFrom` launcher lists, `spawn_agent` `launchOptions`, merged
Claude `--settings`); the Auto downgrade and `trustedFolder` need the Auto profile points (older CanvasTTY ignores them).

## Develop

`ESBUILD=/path/to/esbuild node scripts/build.mjs` builds `services/accounts.mjs` and `settings/accounts.js` and stamps
the manifest. `npm test` runs the tests (set `CANVASTTY_REPO` to a CanvasTTY checkout to also run its manifest
validator).
