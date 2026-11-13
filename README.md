# claude-mods

Mods for Claude Code. Currently: **model-router**.

## model-router

Analyzes each prompt when you send it and tells you whether the selected model and effort are the right ones for it. If another model would do better, it interrupts the send, rewrites the prompt with a summary of the conversation, copies the result to your clipboard and asks you to open a new chat with the suggested model. It also logs, for every prompt, how many tokens and how much time the mod estimated against what the prompt actually used, so you can check whether the estimates hold up.

### Install

In a terminal:

```
/plugin install model-router --marketplace brunoleocam/claude-mods
```

In the desktop app, where `/plugin` does not run: click **+** next to the prompt box, then **Plugins**, **Add marketplace** with `brunoleocam/claude-mods`, then **Add plugin**.

### How it works

1. You send a prompt of 40 characters or more. The mod holds it and asks the current model to analyze it over the conversation (sharing the prompt cache). With no conversation yet, it uses Opus at medium effort.
2. The analysis follows the model-selection guide from Anthropic: Opus 5.5 at medium as the default, Sonnet for well-scoped code, Haiku for classification and extraction, Fable for large refactors, migrations and architecture.
3. If the current model fits, the prompt goes through. If another one would do better and the confidence is at least 75%, the mod interrupts, copies the refined prompt and shows three buttons above the prompt: **Send here anyway**, **Copy again** and **Discard**.
4. After each reply, a colored line shows the real usage next to the estimate, for example `⏱ 54s est 20s–70s ✓ · ↗ out 3.1k est 2k–6k ✓`.

The band above the prompt also shows the context used and the time left on the cache (`Cache · XXm`).

### Commands

| Command | What it does |
| --- | --- |
| `/router log` | Estimate accuracy (within, above and below the range), average analysis cost, and how many suggestions were followed |
| `/router send` | Sends the held prompt in this chat anyway |
| `/router on` / `/router off` | Turns the analysis on and off |
| `/router export` | Writes the log to `~/.claude/model-router-log.json` |
| `/router reset` | Clears the log |

### Good to know

- **Every analyzed prompt has a cost.** The analysis is a model call: it adds a few seconds to each send and uses a little of your usage window. `/router log` shows the real average.
- **The log keeps text from your conversation.** When the mod interrupts a prompt, the log includes the conversation summary and the refined prompt. It lives in the mod's storage and in `~/.claude/model-router-log.json`; it never leaves your computer, but clear it with `/router reset` before sharing the file.
- **The cache lifetime is an assumption.** Claude Code does not report how long the cache lasts; the mod assumes 60 minutes after the last reply. If yours is 5 minutes, change `CACHE_TTL_MS` in `plugins/model-router/hooks/register.tsx`.
- **The mod does not open a new chat.** It copies the refined prompt; opening the chat and picking the model is up to you.
- **Suggestions come from a model, not an exact rule.** Use the log to decide how far to trust them.
- **To change the minimum confidence** (75%), edit `MIN_CONFIDENCE` in `plugins/model-router/hooks/analyze.ts`.

### License

MIT.
