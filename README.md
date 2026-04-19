# context-lookup

OpenClaw plugin that registers a single function-call style tool —
`context_lookup` — for agents to fetch shared documentation, tool guides,
and any other topic-indexed reference material **on demand**.

## Why

Auto-injection plugins (such as the predecessor `progressive-context`)
push large blocks of shared context into every agent prompt up-front,
even when the agent doesn't need it. `context-lookup` flips the model:
agents query by topic name, the plugin returns just that file (or a
single section of it).

This plugin **does not** touch OpenClaw core's standard bootstrap files
(`AGENTS.md`, `TOOLS.md`, `MEMORY.md`, `USER.md`, `IDENTITY.md`,
`SOUL.md`, `HEARTBEAT.md`) — core injects those natively each turn.

## Tool spec

```
context_lookup({
  topic?:         string,   // topic name from registry (or alias)
  section?:       string,   // optional heading substring to slice
  list_topics?:   boolean,  // enumerate all topics
  list_sections?: boolean   // list headings of the resolved file
})
```

Returns one of:

- `{ topic, file, content, section?, truncated? }` — body (full file or
  section). `truncated:true` means the response was clipped at
  `maxBytes`.
- `{ topic, file, sections: [...] }` — when `list_sections:true`.
- `{ topics: [{ name, description, file, default_section, aliases }] }` —
  when `list_topics:true`.
- `{ error: string }` — on failure (unknown topic, missing file, etc.).
  Errors include the available topic list so the agent can self-correct.

The tool description registered with the host dynamically lists every
configured topic + its description, so agents see options without
needing to call `list_topics` first.

## Topic registry

Topics live in a JSON file (default: `topics.json` at workspace root,
overridable via `topicsFile` config). Schema:

```json
{
  "topics": {
    "<name>": {
      "file": "shared/foo.md",
      "section": "Optional default heading substring",
      "description": "Optional human-readable description",
      "aliases": ["optional", "alternate-names"]
    }
  }
}
```

Edit the registry freely; the plugin reads it on gateway startup. A
`_readme` key at top level is ignored.

## Plugin config (`openclaw.json`)

```json
"context-lookup": {
  "topicsFile": "topics.json",
  "toolName": "context_lookup",
  "maxBytes": 64000,
  "skipAgents": []
}
```

All fields optional — defaults shown.

## Build

```sh
npm run build
```

Produces `index.js` (CommonJS, bundled, `fs`/`path` external).

## Compared to `progressive-context`

| feature | progressive-context | context-lookup |
| --- | --- | --- |
| auto-inject standard 6 bootstrap files | filters/compacts | leaves alone (core handles it) |
| inject shared on first turn | yes (`injectSharedOnFirstTurn`) | no |
| inject shared every turn | yes (`injectSharedEveryTurn`) | no |
| compact reminder turn 2+ | yes | no |
| on-demand `workspace_context` tool | yes (path-based: `workspace:<key>`, `shared:<name>`) | replaced by `context_lookup` (topic-based) |

`context-lookup` does only the last row — and does it via a topic
registry instead of file paths, so the agent sees semantic names.
