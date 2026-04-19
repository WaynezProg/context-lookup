# context-lookup

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![OpenClaw Plugin](https://img.shields.io/badge/OpenClaw-plugin-blue.svg)](https://github.com/openclaw)

> An OpenClaw plugin that registers a single function-call style tool
> (`context_lookup`) for agents to fetch shared docs, tool guides, and any
> topic-indexed reference material **on demand** — instead of injecting
> everything every turn.

## TL;DR

- One tool, one job: agents query by topic name, the plugin returns the file
  (or a single section of it).
- **No auto-injection** — no first-turn dump, no compact reminders, no
  bootstrap filtering. The host (e.g. OpenClaw core) keeps its own injection
  for `AGENTS.md / TOOLS.md / SOUL.md / IDENTITY.md / USER.md / MEMORY.md /
  HEARTBEAT.md`; this plugin handles everything else.
- Topic registry lives in a single JSON file outside `openclaw.json` so it
  can be edited and version-controlled separately.
- Tool description is short (≤ 8 lines) and locale-aware. Agents call
  `list_topics` to enumerate when they need to.

## Why

Many context-injection plugins push large blocks of shared documentation into
every prompt, even when the agent doesn't need them. `context-lookup` flips
the model: agents query when they need something, by name. This trades a
small extra round-trip (when a topic is needed) for a substantial reduction
in baseline prompt size on every other turn.

## Quick Start

```bash
# 1. Clone into your OpenClaw extensions dir
cd ~/.openclaw/extensions
git clone https://github.com/WaynezProg/context-lookup.git

# 2. Build
cd context-lookup
npm run build

# 3. Seed a topic registry
cp examples/topics.example.json ~/.openclaw/workspace/topics.json
# edit topics.json — point each topic at a real markdown file under your workspace

# 4. Register the plugin in openclaw.json
#    (paths/keys vary by OpenClaw version; see Configuration below)

# 5. Restart your gateway
openclaw gateway restart
```

After restart, agents will see `context_lookup` in their tool list. Verify
with the gateway log:

```
[context-lookup] v1.2 init: workspaceRoot=…, topicsFile=…, topics=N, tool=context_lookup, locale=en
[context-lookup] tool 'context_lookup' registered (N topics)
```

## Installation

Requirements:

- Node.js 18+ (the bundled output is CommonJS, `fs` and `path` external)
- An OpenClaw host that supports plugins via `entry: "./index.js"`

Build artefact: `index.js` (~11 kB, bundled with esbuild).

```bash
npm run build
```

The build script is in `package.json`:

```json
"build": "npx esbuild index.ts --bundle --platform=node --format=cjs --outfile=index.js --external:fs --external:path"
```

There is no runtime dependency: the bundle imports only `fs` and `path` from
Node's standard library.

## Configuration

### 1. Plugin config (in `openclaw.json`)

All fields are optional. Defaults shown in comments:

```jsonc
"context-lookup": {
  "topicsFile":    "topics.json",   // relative to workspaceRoot, or absolute
  "toolName":      "context_lookup", // override the registered tool name
  "maxBytes":      64000,            // truncate responses larger than this
  "skipAgents":    [],               // agent IDs to exclude
  "locale":        "en",             // tool description: "en" or "zh-TW"
  "workspaceRoot": null              // absolute path; only needed if host doesn't supply one
}
```

`workspaceRoot` resolution order:

1. Host runtime (`api.runtime.workspaceRoot`)
2. Legacy host method (`api.getWorkspaceRoot()`)
3. Plugin config (`workspaceRoot` above)
4. OpenClaw default (`~/.openclaw/workspace`, honours `OPENCLAW_PROFILE`)

If none of the four resolve, the plugin warns and exits without registering
the tool.

### 2. Topic registry (`topics.json`)

```jsonc
{
  "categories": {
    "common-rules": { "name": "Common rules", "order": 1 },
    "workflows":    { "name": "Workflows",    "order": 2 },
    "tools":        { "name": "Tools",        "order": 3 }
  },
  "topics": {
    "git-conventions": {
      "file":        "shared/git-conventions.md",   // required, relative to workspaceRoot
      "section":     "Branch naming",                // optional, default heading
      "description": "Commit message format, PR review checklist",
      "category":    "common-rules",
      "aliases":     ["git", "git-style"]
    }
  }
}
```

| Field                    | Required | Notes |
| ------------------------ | -------- | ----- |
| `categories.<id>.name`   | no       | Display label in `list_topics` output. |
| `categories.<id>.order`  | no       | Lower numbers first. Defaults to 999. |
| `topics.<name>.file`     | **yes**  | Path relative to workspaceRoot, or absolute. |
| `topics.<name>.section`  | no       | Default heading substring to slice (case-insensitive, fuzzy). |
| `topics.<name>.description` | no    | Shown to agents in `list_topics`. Strongly recommended. |
| `topics.<name>.category` | no       | Category id. Topics without a category go under `uncategorized`. |
| `topics.<name>.aliases`  | no       | Alternative names that resolve to this topic. |

A `_readme` key at any level is ignored by the plugin and can be used for
inline documentation.

The plugin reads `topics.json` once at startup. Edit and restart the host
(it does not hot-reload).

A complete example: [`examples/topics.example.json`](examples/topics.example.json).

## Tool API

### Schema

```ts
context_lookup({
  topic?:         string,   // canonical topic name or alias
  section?:       string,   // optional heading substring to slice
  list_topics?:   boolean,  // enumerate all topics grouped by category
  list_sections?: boolean   // list markdown headings of the resolved file
})
```

### Returns

| Call                                            | Return                                                                 |
| ----------------------------------------------- | ---------------------------------------------------------------------- |
| `{ topic }`                                     | `{ topic, file, content, section?, truncated? }`                        |
| `{ topic, section }`                            | Same as above, content sliced from the matched heading down.            |
| `{ topic, list_sections: true }`                | `{ topic, file, sections: string[] }`                                  |
| `{ list_topics: true }`                         | `{ categories: [{ id, name, topics: [...] }], total: number }`         |
| Anything else / unresolved                      | `{ error: string }` — message includes the canonical topic list.       |

### Section matching

Headings are matched case-insensitively by **substring**. `section: "branch"`
will match `## Branch naming`, `### Branching strategy`, etc. The first
match wins.

The slice runs from the matched heading down to (but not including) the
next heading at the same or shallower level.

### Truncation

Responses larger than `maxBytes` (default 64 000) are truncated and the
return object includes `truncated: true`. UTF-8 boundaries are respected
on a best-effort basis.

## Examples

### Look up a topic

```js
context_lookup({ topic: "git-conventions" })
// → { topic: "git-conventions", file: "/.../shared/git-conventions.md", content: "..." }
```

### Slice a section

```js
context_lookup({ topic: "git-conventions", section: "Commit message" })
// → { topic, file, section: "Commit message", content: "## Commit message format\n..." }
```

### Enumerate

```js
context_lookup({ list_topics: true })
// → {
//     categories: [
//       { id: "common-rules", name: "Common rules", topics: [{ name, description, ... }] },
//       ...
//     ],
//     total: 7
//   }
```

### Discover headings before slicing a large file

```js
context_lookup({ topic: "deployment-runbook", list_sections: true })
// → { topic, file, sections: ["# Deployment", "## Pre-flight", "## Rollout", ...] }
```

## Compared to a typical "shared context" plugin

| Feature                                | Typical plugin           | context-lookup           |
| -------------------------------------- | ------------------------ | ------------------------ |
| Auto-inject standard agent files       | yes (filters/compacts)   | no — host handles it     |
| Inject shared context on first turn    | yes                      | no                       |
| Inject shared context every turn       | yes                      | no                       |
| Compact reminder on later turns        | yes                      | no                       |
| On-demand fetch tool                   | path-based               | topic-name based         |
| Tool description size                  | grows with topic count   | fixed (~7 lines)         |

## Limitations

- The plugin reads `topics.json` once at startup. There is no file watcher;
  edit and restart the host.
- Section matching is fuzzy (substring) by design. If you have multiple
  headings that share the substring, only the first match is returned. Use
  more specific section names if this matters.
- The plugin does not validate that the files referenced by `topics.<name>.file`
  exist at startup — missing files return an error at lookup time. This is
  intentional: it lets you stage a registry change before placing the file.

## Contributing

Issues and pull requests welcome at
<https://github.com/WaynezProg/context-lookup>.

When adding features, please:

- Keep `index.ts` self-contained (no runtime dependencies).
- Update `CHANGELOG.md` and `package.json` `version` together.
- Add or update a worked example in `examples/` if the change affects the
  registry schema or tool API.

## License

[MIT](LICENSE) © 2026 Wayne Tu.
