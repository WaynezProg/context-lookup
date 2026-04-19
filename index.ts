/**
 * context-lookup — OpenClaw plugin
 *
 * Registers a single tool `context_lookup` that lets agents fetch shared
 * context, tool documentation, or any topic-indexed knowledge file on
 * demand. There is no auto-injection: the agent must explicitly call the
 * tool with a `topic` name. Topic → file mapping lives in a JSON registry
 * outside `openclaw.json`.
 *
 * Companion to (and replacement for) `progressive-context`'s on-demand
 * features. Bootstrap files (AGENTS/TOOLS/MEMORY/USER/IDENTITY/SOUL/
 * HEARTBEAT) are handled natively by OpenClaw core — this plugin does not
 * touch them.
 */

import { readFileSync, existsSync, statSync } from "fs";
import { isAbsolute, join } from "path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface TopicEntry {
  /** File path relative to workspace root (or absolute). */
  file: string;
  /** Default section heading (fuzzy substring match) to extract. */
  section?: string;
  /** Human-readable description shown in the tool spec. */
  description?: string;
  /** Optional aliases — extra topic names that resolve to this entry. */
  aliases?: string[];
}

interface TopicRegistry {
  topics: Record<string, TopicEntry>;
}

interface PluginConfig {
  topicsFile?: string;
  toolName?: string;
  maxBytes?: number;
  skipAgents?: string[];
}

interface ToolParams {
  topic?: string;
  section?: string;
  list_topics?: boolean;
  list_sections?: boolean;
}

interface ToolContext {
  agentId?: string;
  [key: string]: unknown;
}

interface OpenClawApi {
  registerTool(def: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
    execute: (params: unknown, ctx: unknown) => Promise<unknown>;
  }): void;
  getWorkspaceRoot?(): string;
  getConfig?(): PluginConfig;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_TOPICS_FILE = "topics.json";
const DEFAULT_TOOL_NAME = "context_lookup";
const DEFAULT_MAX_BYTES = 64_000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const fileCache = new Map<string, { mtimeMs: number; content: string }>();

function readFileCached(filePath: string): string | null {
  try {
    const st = statSync(filePath);
    const cached = fileCache.get(filePath);
    if (cached && cached.mtimeMs === st.mtimeMs) return cached.content;
    const content = readFileSync(filePath, "utf-8");
    fileCache.set(filePath, { mtimeMs: st.mtimeMs, content });
    return content;
  } catch {
    return null;
  }
}

/**
 * Extract a section by fuzzy heading match. Returns from the matched
 * heading down to (but excluding) the next heading at the same or
 * shallower level.
 */
function extractSection(content: string, section: string): string | null {
  const lines = content.split("\n");
  const needle = section.toLowerCase().trim();
  let startIdx = -1;
  let startLevel = 0;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(#{1,6}) (.+)/);
    if (m && m[2].toLowerCase().includes(needle)) {
      startIdx = i;
      startLevel = m[1].length;
      break;
    }
  }
  if (startIdx === -1) return null;
  const result: string[] = [lines[startIdx]];
  for (let i = startIdx + 1; i < lines.length; i++) {
    const m = lines[i].match(/^(#{1,6}) /);
    if (m && m[1].length <= startLevel) break;
    result.push(lines[i]);
  }
  return result.join("\n");
}

function listHeadings(content: string): string[] {
  return content.match(/^#{1,6} .+$/gm) ?? [];
}

function truncate(content: string, maxBytes: number): { text: string; truncated: boolean } {
  const buf = Buffer.from(content, "utf-8");
  if (buf.byteLength <= maxBytes) return { text: content, truncated: false };
  const sliced = buf.subarray(0, maxBytes).toString("utf-8");
  const note = `\n\n…[truncated: original ${buf.byteLength} bytes, returned ${maxBytes}]`;
  return { text: sliced + note, truncated: true };
}

function log(msg: string): void {
  console.log(`[context-lookup] ${msg}`);
}

function warn(msg: string): void {
  console.log(`[context-lookup] WARN: ${msg}`);
}

function resolveDefaultWorkspaceRoot(): string {
  const env = process.env;
  const home = env.HOME || env.USERPROFILE;
  if (!home) return process.cwd();
  const profile = env.OPENCLAW_PROFILE?.trim();
  const sub = profile && profile.toLowerCase() !== "default" ? `workspace-${profile}` : "workspace";
  return join(home, ".openclaw", sub);
}

// ---------------------------------------------------------------------------
// Topic registry loading
// ---------------------------------------------------------------------------

interface ResolvedRegistry {
  /** Canonical topic name → entry */
  byName: Map<string, TopicEntry>;
  /** Alias → canonical name */
  aliasIndex: Map<string, string>;
  /** Sorted list of canonical names for stable enumeration. */
  names: string[];
  /** Source file path (for diagnostics). */
  sourcePath: string;
}

function loadRegistry(workspaceRoot: string, topicsFile: string): ResolvedRegistry {
  const path = isAbsolute(topicsFile) ? topicsFile : join(workspaceRoot, topicsFile);
  const empty: ResolvedRegistry = {
    byName: new Map(),
    aliasIndex: new Map(),
    names: [],
    sourcePath: path,
  };
  if (!existsSync(path)) {
    warn(`topics file not found: ${path} — context_lookup will return errors until it exists`);
    return empty;
  }
  let parsed: TopicRegistry;
  try {
    parsed = JSON.parse(readFileSync(path, "utf-8")) as TopicRegistry;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    warn(`failed to parse topics file ${path}: ${msg}`);
    return empty;
  }
  if (!parsed.topics || typeof parsed.topics !== "object") {
    warn(`topics file ${path} missing required "topics" object`);
    return empty;
  }
  const byName = new Map<string, TopicEntry>();
  const aliasIndex = new Map<string, string>();
  for (const [name, entry] of Object.entries(parsed.topics)) {
    if (!entry || typeof entry !== "object" || typeof entry.file !== "string") {
      warn(`topic "${name}" missing required "file" — skipped`);
      continue;
    }
    byName.set(name, entry);
    if (Array.isArray(entry.aliases)) {
      for (const alias of entry.aliases) {
        if (typeof alias !== "string") continue;
        if (aliasIndex.has(alias) || byName.has(alias)) {
          warn(`alias "${alias}" of "${name}" collides with existing topic/alias — skipped`);
          continue;
        }
        aliasIndex.set(alias, name);
      }
    }
  }
  return {
    byName,
    aliasIndex,
    names: [...byName.keys()].sort(),
    sourcePath: path,
  };
}

function resolveTopic(reg: ResolvedRegistry, query: string): { name: string; entry: TopicEntry } | null {
  const direct = reg.byName.get(query);
  if (direct) return { name: query, entry: direct };
  const aliased = reg.aliasIndex.get(query);
  if (aliased) {
    const entry = reg.byName.get(aliased);
    if (entry) return { name: aliased, entry };
  }
  return null;
}

function buildToolDescription(reg: ResolvedRegistry, toolName: string): string {
  if (reg.names.length === 0) {
    return `Look up topic-indexed reference content on demand. Topic registry currently empty (expected at ${reg.sourcePath}). Call ${toolName}({list_topics:true}) once it is populated.`;
  }
  const lines: string[] = [
    `Look up topic-indexed reference content (shared docs, tool guides, etc.) on demand.`,
    `Call ${toolName}({topic:"<name>"}) to fetch a topic. Pass {list_topics:true} to enumerate. Pass {section:"<heading>"} to slice by heading; {list_sections:true} to see headings only.`,
    ``,
    `Available topics:`,
  ];
  for (const name of reg.names) {
    const entry = reg.byName.get(name)!;
    const desc = entry.description ? ` — ${entry.description}` : "";
    lines.push(`- ${name}${desc}`);
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Plugin entry
// ---------------------------------------------------------------------------

export default function register(api: OpenClawApi): void {
  // Multi-shape config resolution (matches progressive-context's pattern):
  //   - new (data-field): api.pluginConfig, api.config.plugins.entries[id].config
  //   - legacy (method):  api.getConfig()
  const anyApi = api as Record<string, unknown> & {
    pluginConfig?: PluginConfig;
    config?: { plugins?: { entries?: Record<string, { config?: PluginConfig }> } };
    runtime?: { workspaceRoot?: string };
    id?: string;
  };

  const config: PluginConfig =
    anyApi.pluginConfig
    ?? (anyApi.id && anyApi.config?.plugins?.entries?.[anyApi.id]?.config)
    ?? api.getConfig?.()
    ?? {};

  const rawWorkspaceRoot =
    anyApi.runtime?.workspaceRoot
    ?? api.getWorkspaceRoot?.()
    ?? null;

  const workspaceRoot =
    rawWorkspaceRoot && rawWorkspaceRoot !== "/" ? rawWorkspaceRoot : resolveDefaultWorkspaceRoot();

  const topicsFile = config.topicsFile ?? DEFAULT_TOPICS_FILE;
  const toolName = config.toolName ?? DEFAULT_TOOL_NAME;
  const maxBytes = typeof config.maxBytes === "number" && config.maxBytes > 0 ? config.maxBytes : DEFAULT_MAX_BYTES;
  const skipAgents = new Set(config.skipAgents ?? []);

  const registry = loadRegistry(workspaceRoot, topicsFile);

  log(
    `v1.0 init: workspaceRoot=${workspaceRoot}, topicsFile=${registry.sourcePath}, topics=${registry.names.length}, tool=${toolName}`,
  );

  if (typeof api.registerTool !== "function") {
    warn("registerTool not available on this host — plugin disabled");
    return;
  }

  api.registerTool({
    name: toolName,
    description: buildToolDescription(registry, toolName),
    parameters: {
      type: "object",
      properties: {
        topic: {
          type: "string",
          description:
            "Topic name from the registry (or its alias). Required unless `list_topics` is true.",
        },
        section: {
          type: "string",
          description:
            "Optional heading substring (case-insensitive). Returns just that section instead of the full file. Overrides the topic's default section.",
        },
        list_topics: {
          type: "boolean",
          description: "Return the full topic registry (name, description, file) instead of a topic body.",
        },
        list_sections: {
          type: "boolean",
          description: "Return the list of markdown headings in the resolved topic file instead of its content.",
        },
      },
    },
    execute: async (params: unknown, toolCtx: unknown) => {
      const p = (params ?? {}) as ToolParams;
      const agentId = (toolCtx as ToolContext)?.agentId ?? "unknown";

      if (skipAgents.has(agentId)) {
        return { error: `context_lookup is disabled for agent '${agentId}'` };
      }

      // Enumerate topics
      if (p.list_topics) {
        return {
          topics: registry.names.map((name) => {
            const entry = registry.byName.get(name)!;
            return {
              name,
              description: entry.description ?? null,
              file: entry.file,
              default_section: entry.section ?? null,
              aliases: entry.aliases ?? [],
            };
          }),
        };
      }

      if (!p.topic || typeof p.topic !== "string") {
        return {
          error: `Missing required parameter 'topic'. Pass {list_topics:true} to see options. Available: ${registry.names.join(", ") || "(none)"}`,
        };
      }

      const resolved = resolveTopic(registry, p.topic);
      if (!resolved) {
        return {
          error: `Unknown topic '${p.topic}'. Available: ${registry.names.join(", ") || "(none)"}`,
        };
      }

      const { name, entry } = resolved;
      const filePath = isAbsolute(entry.file) ? entry.file : join(workspaceRoot, entry.file);
      const content = readFileCached(filePath);
      if (content === null) {
        return { error: `File for topic '${name}' not found: ${filePath}` };
      }

      if (p.list_sections) {
        return { topic: name, file: filePath, sections: listHeadings(content) };
      }

      // section param > topic default section > whole file
      const sectionQuery = p.section ?? entry.section;
      let body = content;
      if (sectionQuery) {
        const extracted = extractSection(content, sectionQuery);
        if (!extracted) {
          return {
            error: `Section '${sectionQuery}' not found in topic '${name}' (${filePath}). Pass {list_sections:true} to see available headings.`,
          };
        }
        body = extracted;
      }

      const { text, truncated } = truncate(body, maxBytes);
      const result: Record<string, unknown> = { topic: name, file: filePath, content: text };
      if (sectionQuery) result.section = sectionQuery;
      if (truncated) result.truncated = true;
      return result;
    },
  });

  log(`tool '${toolName}' registered (${registry.names.length} topics)`);
}
