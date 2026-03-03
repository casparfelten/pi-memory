# Memory system v0 — fixes & clarifications
**Date:** 2026-02-21

Companion to `memory-system-v0.md`. Captures decisions that were underspecified or ambiguous.

---

## 1) System prompts are objects

System prompts are stored as objects in XTDB, linked to the session object. They are locked (cannot be deactivated). On rendering, the adapter reads the system prompt objects and produces whatever the harness expects (e.g. the `systemPrompt` string field in Pi, or equivalent in other harnesses).

This means:
- System prompts are versioned (XTDB bitemporality).
- They can be inspected, queried, compared across sessions.
- They have the same structure as any object (id, type, content, hashes).
- `type` = `"system_prompt"`.
- The session object holds refs to its system prompt objects.

---

## 2) Toolcall object identity

Toolcall objects use provider-native tool call IDs as their primary identifier when those IDs are unique and non-repeating (which they are in practice for all major providers — Anthropic, OpenAI, Google all emit unique IDs per tool call).

If a harness/provider does not guarantee unique tool call IDs, the adapter mints a UUIDv7 and stores the provider ID as a field.

Default (Pi/standard providers):
```
id:               string      (the provider's toolCallId — e.g. "toolu_01XFDUDYJgAACzvnptvVer6R")
type:             "toolcall"
...
```

This avoids maintaining a mapping between two ID systems. Our toolcall object IS the thing the provider emitted, enriched with our fields.

When rendering `ToolResultMessage` for the LLM, the `toolCallId` is just the object's `id` — no translation needed.

When the agent calls `activate("toolu_01XFDUDYJgAACzvnptvVer6R")`, it references the toolcall directly.

---

## 3) Toolcall `args`: stored as structured data

Tool call arguments are stored as structured data (the JSON object / `Record<string, any>` the provider emits), not stringified. The adapter renders them into whatever the harness or metadata view needs (e.g. a short string for metadata display: `bash: "ls -la"`, or the full JSON for reconstruction).

```
args:             Record<string, any>    (structured, as emitted by the provider)
args_display:     string?                (optional, short human-readable rendering for metadata)
```

This preserves fidelity. The metadata view can show `args_display` (a generated short string). The full `args` is available for reconstruction and inspection.

---

## 4) Chat `Turn` schema: provider-native toolcall linkage

The Turn struct preserves the provider's tool call structure for faithful reconstruction:

```
Turn {
  user:             string | (TextContent | ImageContent)[]
  assistant:        (TextContent | ThinkingContent | ToolCall)[]    // ToolCall includes provider id
  toolcall_ids:     string[]    // provider toolCallIds = our toolcall object ids (per §2)
  assistant_meta:   { api, provider, model, usage, stopReason, timestamp }
}
```

Since toolcall object IDs ARE provider toolCallIds (§2), `toolcall_ids` directly references our objects AND is valid for reconstructing `ToolResultMessage.toolCallId`. No mapping table needed.

Reconstruction of `Message[]` from a Turn:
1. `UserMessage` ← `turn.user` + timestamp
2. `AssistantMessage` ← `turn.assistant` (already contains `ToolCall` objects with provider IDs) + `turn.assistant_meta`
3. For each `toolcall_id`: `ToolResultMessage` ← `{ toolCallId: id, toolName: <from toolcall object>, content: <metadata reference>, isError: <from toolcall object> }`

---

## 5) `metadata_view_hash`: what it hashes (v0 defaults)

For v0, the metadata view per type is a fixed set of fields (see §24 in main doc). The `metadata_view_hash` is the SHA-256 of the concatenated values of those fields, in a deterministic order.

v0 defaults (what gets hashed):
- **File:** `id + type + path + file_type + char_count + nickname`
- **Toolcall:** `id + type + tool + args_display + status`
- **Chat:** `id + type + session_ref + turn_count`
- **Session:** not rendered as metadata (bookkeeping object)

The `view` field (per-object override) is not implemented in v0. When it is, `metadata_view_hash` will hash whichever fields the `view` specifies.

---

## 6) Non-text file activation

Activating an object with null content returns a short note: "Content unavailable (non-text file)" or similar. It is not a silent no-op — the agent should know the activation didn't load anything.

---

## 7) General pattern: store rich, adapt on output

We store our objects richly (structured args, full turn data, all provider metadata). The adapter translates into whatever the harness/provider expects on output. We don't lossy-compress on input to match a specific harness's format.

This means:
- Ingestion: capture everything the harness gives us, in our own structure.
- Rendering: translate from our structure into what the harness/provider needs.
- If a new harness needs different output, we write a new adapter. Our stored data supports it.

This is the general philosophy for all boundary interactions.
