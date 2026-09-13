---
summary: "Codex auth selection order, credential handling, and environment isolation"
read_when:
  - You need the Codex auth selection order
  - You are sharing or isolating the native Codex home
  - You are migrating Codex credentials or assets into an agent
title: "Codex auth and environment isolation"
sidebarTitle: "Auth and isolation"
---

Which credential a Codex turn uses, and what the app-server child process inherits. Part of the [Codex harness reference](/plugins/codex-harness-reference); [Where each section moved](/plugins/codex-harness-reference#where-each-section-moved) lists every section.

## Auth and environment isolation

In the default per-agent home, stdio launches use Codex's ephemeral credential
store, including custom commands selected by `appServer.command` or
`OPENCLAW_CODEX_APP_SERVER_BIN`. Command wrappers must forward Codex's `-c`
configuration arguments. For stdio launches with an explicit `app-server`
subcommand, OpenClaw groups `-c` / `--config` overrides before that subcommand,
preserving their order and leaving wrapper prefixes and other arguments in place.
This prevents Codex from dropping earlier overrides when flags appear on both
sides of `app-server`. OpenClaw's ephemeral credential-store override remains
last when OpenClaw owns auth; native user-home auth is unchanged.
Workspace-write turns also preserve explicit `sandbox_workspace_write` temporary
root exclusions from these arguments, including attached `-ckey=value` flags
and TOML comments after boolean values. The last explicit value wins.
Explicit turn sandbox policies and network-proxy permission profiles keep their
existing precedence.

OpenClaw supplies auth in this order:

1. An explicit or ordered OpenClaw auth profile for the agent.
2. For an API-key route only, a prepared key or local stdio fallback from
   `CODEX_API_KEY`, then `OPENAI_API_KEY`.

The app-server does not read an existing `codex-home/auth.json` in
this mode. Import that file explicitly as described below. Set
`appServer.homeScope: "user"` only when the app-server should instead own and
use the operator's native Codex account.

No credential file is written in this mode, in either home. A subscription
profile is handed over as an `account/login/start` request of type
`chatgptAuthTokens`, which Codex installs as in-memory external auth rather
than persisting; the ephemeral credential store covers the API-key login,
which would otherwise write `CODEX_HOME/auth.json`.

Token refresh is inverted so the long-lived secret never leaves OpenClaw. Codex
holds only a short-lived access token, and on an unauthorized response it sends
an `account/chatgptAuthTokens/refresh` request back to OpenClaw over the same
connection. OpenClaw refreshes against its own auth profile store and returns a
fresh access token, so the refresh token stays in SQLite. A refresh that does
not answer within the app-server's timeout fails that turn rather than falling
back to another credential. A failed refresh retires the shared client from
reuse; existing leases drain, and the next request starts a fresh client. If the
workspace changed, retry the request. If credentials cannot refresh, sign in
again with `openclaw models auth login --provider openai` and select that profile.
Shared clients recheck the selected profile before reuse so changing accounts
under the same profile ID also selects a new client.

When OpenClaw sees a ChatGPT subscription-style Codex auth profile (OAuth or
token credential type), it removes `CODEX_API_KEY` and `OPENAI_API_KEY` from
the spawned Codex child process. That keeps Gateway-level API keys available
for embeddings or direct OpenAI models without making native Codex app-server
turns bill through the API by accident.

Explicit Codex API-key profiles and local stdio env-key fallback use
app-server login instead of inherited child-process env. WebSocket app-server
connections do not receive Gateway env API-key fallback; use an explicit auth
profile or the remote app-server's own account.

Stdio app-server launches inherit OpenClaw's process environment by default.
OpenClaw owns the Codex app-server account bridge and sets `CODEX_HOME` to a
per-agent directory under that agent's OpenClaw state. That keeps Codex
config, accounts, plugin cache/data, and thread state scoped to the OpenClaw
agent instead of leaking in from the operator's personal `~/.codex` home.

Set `appServer.homeScope: "user"` to share native Codex state with Codex
Desktop and the CLI. This local user-home mode supports managed stdio and
explicit Unix transport. It uses `$CODEX_HOME` when set and `~/.codex`
otherwise, including native auth, config, plugins, and threads.
OpenClaw skips its auth-profile bridge for the app-server. Verified owner
turns can use `codex_threads` to list (with an optional `search` filter),
read, queue attributed work, inspect queued work, fork, rename, archive, and
unarchive those threads. Queue actions additionally require enabled supervision
and its dedicated local Unix endpoint. Fork a thread before continuing it in
OpenClaw; independent Codex processes do not coordinate concurrent writers for
the same thread.

For bounded transcript reads, call `codex_threads` with `action: "read"`,
`thread_id`, `include_turns: true`, and `item_limit` (1–50). This requires native
item-pagination support. The result contains complete `items` in newest-first
order and an opaque `nextCursor`; pass that value as `cursor` to read older
items, stopping when it is `null`. A continuation without `item_limit` requests
up to 10 items. Pages may contain fewer items to keep the complete raw and
sanitized JSON within 16,000 weighted characters. If one item or its metadata
exceeds that bound, the tool fails without returning items or advancing the
cursor; inspect that content in Codex. Smaller model-context limits can still
truncate a page. Reads without `item_limit` or `cursor` retain the existing
metadata/full-transcript behavior.

To contribute to an existing task through its native owner, configure
`supervision.queueEndpoint` with a trusted absolute local `unix://` URL and set
`supervision.allowQueueControls: true`. Call `codex_threads` with
`action: "queue"`, the selected `thread_id`, attributed `text`, and a
`client_user_message_id`. The returned native submission is queued; it does not
prove that the owner consumed or completed it. The client message id is a
correlation value, not a deduplication key, so an uncertain acknowledgment must
be reconciled before another enqueue.

Use `action: "queue_list"` with the same task and optional opaque `cursor` and
`limit` (1–50) to inspect complete pending submissions. Queue readback requires
`allowRawTranscripts` because it exposes message content, but remains available
when `allowQueueControls` is revoked. Pages default to 10 entries and may return
fewer to stay within the complete-result budget. If one submission cannot fit,
the action fails without advancing the cursor.

Queueing a request to create another task is still only a queued request. The
selected native task may use its own Codex task-creation tool, but OpenClaw does
not report the new task as created until that native tool returns a real task id
and host. `codex_threads` does not expose a create action or map creation to
`thread/start`.

That `homeScope` opt-in applies to ordinary harness sessions. Hosted web search
and settled-turn finalization use private temporary homes and OpenClaw auth
even when ordinary sessions share the user home. A Chat created
through Codex Sessions uses its private supervision connection instead, which
preserves the native connection's auth and provider configuration for the
canonical branch and future resumes. If that supervised turn finishes tool work
without a final answer, OpenClaw does not borrow host credentials to generate
one. It delivers the [settled-tool fallback](/plugins/codex-harness-runtime#final-answers-after-settled-tool-work)
without repeating completed actions.

In a model-locked supervised Chat, `codex_threads` cannot attach a different
fork or archive the Chat's bound native thread. List and metadata-only read
remain available. Raw transcript reads require `allowRawTranscripts`; when it
is disabled, list search is also rejected because native search can match
transcript previews. Rename, unarchive, detached fork, and archive of an
unrelated thread not owned by another OpenClaw Chat require
`allowWriteControls`. Neither option bypasses a locked binding.
Queue writes instead require `allowQueueControls` and `queueEndpoint`; queue
readback requires `allowRawTranscripts` and the same endpoint. These queue
permissions do not attach or replace the Chat's binding.

OpenClaw does not rewrite `HOME` for normal local app-server launches.
Codex-run subprocesses such as `openclaw`, `gh`, `git`, cloud CLIs, and shell
commands see the normal process home and can find user-home config and
tokens. Codex may also discover `$HOME/.agents/skills` and
`$HOME/.agents/plugins/marketplace.json`; that `.agents` discovery is
intentionally shared with the operator home and is separate from isolated
`~/.codex` state.

In the default agent scope, OpenClaw plugins and OpenClaw skill snapshots
still flow through OpenClaw's own plugin registry and skill loader; personal
Codex `~/.codex` assets do not. If you have useful Codex CLI skills or
plugins from a Codex home that should become part of an isolated OpenClaw
agent, inventory them explicitly:

```bash
openclaw migrate codex --dry-run
openclaw migrate apply codex --yes
```

Credentials need the sensitive migration path because the default agent scope
does not consume a copied or mounted `codex-home/auth.json` directly. Replace
`<agent-id>` with the configured agent that owns this Codex home:

```bash
openclaw migrate plan codex --from <codex-home> --agent <agent-id> --include-secrets --item auth:openai
openclaw migrate apply codex --from <codex-home> --agent <agent-id> --include-secrets --item auth:openai --yes
```

If a deployment needs additional environment isolation, add those variables
to `appServer.clearEnv`:

```json5
{
  plugins: {
    entries: {
      codex: {
        enabled: true,
        config: {
          appServer: {
            clearEnv: ["CODEX_API_KEY", "OPENAI_API_KEY"],
          },
        },
      },
    },
  },
}
```

`appServer.clearEnv` only affects the spawned Codex app-server child process.
OpenClaw removes `CODEX_HOME` and `HOME` from this list during local launch
normalization: `CODEX_HOME` stays pointed at the selected agent or user scope,
and `HOME` stays inherited so subprocesses can use normal user-home state.
