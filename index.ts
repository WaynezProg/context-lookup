/**
 * context-lookup — OpenClaw plugin
 *
 * Registers a single tool `context_lookup` that lets agents fetch shared
 * context, tool documentation, or any topic-indexed knowledge file on
 * demand. Optional deterministic prompt triggers can inject only a topic's
 * default section; they are disabled unless configured. Topic → file mapping
 * lives in a JSON registry outside `openclaw.json`.
 *
 * Companion to (and replacement for) `progressive-context`'s on-demand
 * features. Bootstrap files (AGENTS/TOOLS/MEMORY/USER/IDENTITY/SOUL/
 * HEARTBEAT) are handled natively by OpenClaw core — this plugin does not
 * touch them.
 */

import { appendFileSync, mkdirSync, readFileSync, existsSync, statSync } from "fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "path";

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
  /** Optional category id (matches a key in registry.categories). */
  category?: string;
  /** Literal prompt fragments that load this topic's default section. */
  triggers?: string[];
}

interface CategoryMeta {
  /** Display label shown to agents. */
  name: string;
  /** Optional sort order (lower comes first). */
  order?: number;
}

interface TopicRegistry {
  topics: Record<string, TopicEntry>;
  /** Optional category metadata — id → display label + order. */
  categories?: Record<string, CategoryMeta>;
}

interface PluginConfig {
  topicsFile?: string;
  toolName?: string;
  maxBytes?: number;
  skipAgents?: string[];
  /** Tool description language. "en" (default) or "zh-TW". */
  locale?: "en" | "zh-TW";
  /**
   * Workspace root (absolute path). Required when the host does not
   * provide one via `api.runtime.workspaceRoot` or `api.getWorkspaceRoot()`.
   */
  workspaceRoot?: string;
  routing?: RoutingConfig;
}

interface RoutingConfig {
  enabled?: boolean;
  observeOnly?: boolean;
  telemetryFile?: string;
  maxInjectedBytes?: number;
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

type RoutingEvent = {
  ts: string;
  event: "auto_route" | "lookup" | "write_without_route";
  agentId: string;
  runId: string | null;
  topic: string | null;
  toolName: string | null;
  destinationClass: string | null;
};

interface OpenClawApi {
  registerTool(def: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
    execute: (params: unknown, ctx: unknown) => Promise<unknown>;
  }): void;
  on?(
    name: "before_prompt_build" | "before_tool_call" | "after_tool_call" | "agent_end",
    handler: (event: unknown, ctx: unknown) => unknown,
    options?: { priority?: number },
  ): void;
  getWorkspaceRoot?(): string;
  getConfig?(): PluginConfig;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_TOPICS_FILE = "topics.json";
const DEFAULT_TOOL_NAME = "context_lookup";
const DEFAULT_MAX_BYTES = 64_000;
const WRITE_TOOLS = new Set(["write", "edit", "apply_patch"]);

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

function pluginDebugEnabled(): boolean {
  const value = process.env.OPENCLAW_PLUGIN_DEBUG || process.env.OPENCLAW_DEBUG_PLUGINS || "";
  return /^(1|true|yes)$/i.test(value);
}

function log(msg: string): void {
  if (pluginDebugEnabled()) console.error(`[context-lookup] ${msg}`);
}

function warn(msg: string): void {
  console.warn(`[context-lookup] WARN: ${msg}`);
}

/**
 * Mirror of OpenClaw core's default workspace location, used as a final
 * fallback when neither the host API nor plugin config provides one.
 * Honors `OPENCLAW_PROFILE` like core does.
 */
function resolveOpenClawDefaultWorkspaceRoot(): string | null {
  const env = process.env;
  const home = env.HOME || env.USERPROFILE;
  if (!home) return null;
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
  /** Category id → meta (label + order). */
  categories: Record<string, CategoryMeta>;
  /** Source file path (for diagnostics). */
  sourcePath: string;
}

function loadRegistry(workspaceRoot: string, topicsFile: string): ResolvedRegistry {
  const path = isAbsolute(topicsFile) ? topicsFile : join(workspaceRoot, topicsFile);
  const empty: ResolvedRegistry = {
    byName: new Map(),
    aliasIndex: new Map(),
    names: [],
    categories: {},
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
    categories: parsed.categories ?? {},
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

function normalizeLookupKey(value: string): string {
  return value.trim().toLocaleLowerCase("en-US").replace(/[\s_]+/g, "-");
}

function suggestTopics(query: string, registry: ResolvedRegistry): string[] {
  const needle = normalizeLookupKey(query);
  if (!needle) return [];
  return registry.names
    .map((name) => ({
      name,
      keys: [name, ...(registry.byName.get(name)?.aliases ?? [])],
    }))
    .filter(({ keys }) => keys.some((key) => {
      const normalized = normalizeLookupKey(key);
      return normalized.includes(needle) || needle.includes(normalized);
    }))
    .map(({ name }) => name)
    .slice(0, 3);
}

function matchAutoRoute(
  prompt: string,
  registry: ResolvedRegistry,
): { name: string; entry: TopicEntry } | null {
  const normalizedPrompt = prompt.toLocaleLowerCase("en-US");
  if (!normalizedPrompt.trim()) return null;
  for (const name of registry.names) {
    const entry = registry.byName.get(name);
    if (!entry || !Array.isArray(entry.triggers)) continue;
    const matched = entry.triggers.some((trigger) =>
      normalizedPrompt.includes(trigger.toLocaleLowerCase("en-US"))
    );
    if (matched) return { name, entry };
  }
  return null;
}

function timestampSeconds(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

function classifyDestination(filePath: string | undefined, workspaceRoot: string): string {
  if (!filePath || !isAbsolute(filePath)) return "unknown";
  const target = resolve(filePath);
  const workspace = resolve(workspaceRoot);
  const workspaceRel = relative(workspace, target);
  if (workspaceRel === "") return "workspace-root";
  if (!workspaceRel.startsWith(`..${sep}`) && workspaceRel !== ".." && !isAbsolute(workspaceRel)) {
    const first = workspaceRel.split(sep)[0];
    if (first === "outputs") return "outputs";
    if (first === "archive") return "archive";
    if (first === "projects") return "project";
    if (first === "agents") return "agent-workspace";
    if (first === "tmp") return "tmp";
    return "workspace-root";
  }
  const openClawRoot = dirname(workspace);
  const openClawRel = relative(openClawRoot, target);
  if (!openClawRel.startsWith(`..${sep}`) && openClawRel !== ".." && !isAbsolute(openClawRel)) {
    if (openClawRel.split(sep)[0] === "tmp") return "tmp";
  }
  return "external";
}

type Locale = "en" | "zh-TW";

const TOOL_DESCRIPTIONS: Record<Locale, { empty: (sourcePath: string, toolName: string) => string; populated: (n: number, toolName: string) => string[] }> = {
  en: {
    empty: (sourcePath, toolName) =>
      `Look up topic-indexed reference content on demand. Topic registry is empty (expected at ${sourcePath}). Once populated, call ${toolName}({list_topics:true}) to see the list.`,
    populated: (n, toolName) => [
      `Look up topic-indexed reference content (shared docs, tool guides, workflow details) on demand. ${n} topics organized by category.`,
      ``,
      `Usage:`,
      `- Don't know what's available → ${toolName}({list_topics:true}) returns the categorized list`,
      `- Know the topic name → ${toolName}({topic:"<name>"})`,
      `- Large file, want a slice → ${toolName}({topic, list_sections:true}) to see headings → ${toolName}({topic, section:"<heading>"})`,
      `- Topic not found: call list_topics for the canonical names. Don't guess from memory (names change as the registry is reorganised).`,
    ],
  },
  "zh-TW": {
    empty: (sourcePath, toolName) =>
      `按需查詢主題化參考內容。Topic registry 目前為空（預期路徑：${sourcePath}）。等填入後 call ${toolName}({list_topics:true}) 看清單。`,
    populated: (n, toolName) => [
      `按需查詢主題化參考內容（shared 文件、工具用法、流程細節）。共 ${n} 個 topic，依分類組織。`,
      ``,
      `用法：`,
      `- 不知道有哪些 topic → ${toolName}({list_topics:true}) 看分類清單`,
      `- 知道 topic 名 → ${toolName}({topic:"<name>"})`,
      `- 大檔想看局部 → ${toolName}({topic, list_sections:true}) 找標題 → ${toolName}({topic, section:"<heading>"})`,
      `- 找不到 topic：先 list_topics 看完整清單，不要憑記憶猜（topic 命名隨整理會變）`,
    ],
  },
};

/**
 * Short tool description — does NOT enumerate topics. Agent calls
 * list_topics on demand. Saves ~25 lines × every-turn × every-agent.
 */
function buildToolDescription(reg: ResolvedRegistry, toolName: string, locale: Locale): string {
  const tmpl = TOOL_DESCRIPTIONS[locale] ?? TOOL_DESCRIPTIONS.en;
  if (reg.names.length === 0) return tmpl.empty(reg.sourcePath, toolName);
  return tmpl.populated(reg.names.length, toolName).join("\n");
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

  // workspaceRoot resolution order:
  //   1. host runtime (api.runtime.workspaceRoot) — preferred
  //   2. legacy host method (api.getWorkspaceRoot())
  //   3. plugin config (config.workspaceRoot) — explicit override
  //   4. OpenClaw default (~/.openclaw/workspace, honors OPENCLAW_PROFILE) — last-resort
  const hostWorkspaceRoot = anyApi.runtime?.workspaceRoot ?? api.getWorkspaceRoot?.() ?? null;
  const validHostRoot = hostWorkspaceRoot && hostWorkspaceRoot !== "/" ? hostWorkspaceRoot : null;
  const workspaceRoot =
    validHostRoot
    ?? (config.workspaceRoot && isAbsolute(config.workspaceRoot) ? config.workspaceRoot : null)
    ?? resolveOpenClawDefaultWorkspaceRoot();

  if (!workspaceRoot) {
    warn(
      "no workspaceRoot resolved — host did not provide one, plugin config has none, and OpenClaw default could not be derived (HOME/USERPROFILE unset). Set `workspaceRoot` in this plugin's config or run under a host that provides it.",
    );
    return;
  }

  const topicsFile = config.topicsFile ?? DEFAULT_TOPICS_FILE;
  const toolName = config.toolName ?? DEFAULT_TOOL_NAME;
  const maxBytes = typeof config.maxBytes === "number" && config.maxBytes > 0 ? config.maxBytes : DEFAULT_MAX_BYTES;
  const skipAgents = new Set(config.skipAgents ?? []);
  const locale: Locale = config.locale === "zh-TW" ? "zh-TW" : "en";
  const routing = config.routing;
  const routingEnabled = routing?.enabled === true;
  const observeOnly = routing?.observeOnly !== false;
  const maxInjectedBytes =
    typeof routing?.maxInjectedBytes === "number" && routing.maxInjectedBytes > 0
      ? routing.maxInjectedBytes
      : 2500;

  const registry = loadRegistry(workspaceRoot, topicsFile);
  const routedRuns = new Map<string, Set<string>>();
  const telemetryPath = typeof routing?.telemetryFile === "string" && routing.telemetryFile.trim()
    ? (isAbsolute(routing.telemetryFile) ? routing.telemetryFile : join(workspaceRoot, routing.telemetryFile))
    : null;

  const markRouted = (runId: string | undefined, topic: string): void => {
    if (!runId) return;
    const topics = routedRuns.get(runId) ?? new Set<string>();
    topics.add(topic);
    routedRuns.set(runId, topics);
  };
  const recordRoutingEvent = (event: RoutingEvent): void => {
    if (!telemetryPath) return;
    try {
      mkdirSync(dirname(telemetryPath), { recursive: true });
      appendFileSync(telemetryPath, `${JSON.stringify(event)}\n`, "utf-8");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      warn(`failed to append routing telemetry: ${message}`);
    }
  };

  log(
    `v1.3 init: workspaceRoot=${workspaceRoot}, topicsFile=${registry.sourcePath}, topics=${registry.names.length}, tool=${toolName}, locale=${locale}, routing=${routingEnabled ? "enabled" : "disabled"}`,
  );

  if (typeof api.registerTool !== "function") {
    warn("registerTool not available on this host — plugin disabled");
    return;
  }

  api.registerTool({
    name: toolName,
    description: buildToolDescription(registry, toolName, locale),
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

      // Enumerate topics (grouped by category)
      if (p.list_topics) {
        const groups: Record<string, Array<Record<string, unknown>>> = {};
        for (const name of registry.names) {
          const entry = registry.byName.get(name)!;
          const cat = entry.category ?? "uncategorized";
          if (!groups[cat]) groups[cat] = [];
          groups[cat].push({
            name,
            description: entry.description ?? null,
            default_section: entry.section ?? null,
            aliases: entry.aliases ?? [],
          });
        }
        const catIds = Object.keys(groups).sort((a, b) => {
          const oa = registry.categories[a]?.order ?? 999;
          const ob = registry.categories[b]?.order ?? 999;
          if (oa !== ob) return oa - ob;
          return a.localeCompare(b);
        });
        return {
          categories: catIds.map((id) => ({
            id,
            name: registry.categories[id]?.name ?? id,
            topics: groups[id],
          })),
          total: registry.names.length,
        };
      }

      if (!p.topic || typeof p.topic !== "string") {
        return {
          error: `Missing required parameter 'topic'. Pass {list_topics:true} to see options. Available: ${registry.names.join(", ") || "(none)"}`,
        };
      }

      const resolved = resolveTopic(registry, p.topic);
      if (!resolved) {
        const suggestions = suggestTopics(p.topic, registry);
        const hint = suggestions.length > 0 ? ` Did you mean: ${suggestions.join(", ")}?` : "";
        return {
          error: `Unknown topic '${p.topic}'.${hint} Available: ${registry.names.join(", ") || "(none)"}`,
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

  if (routingEnabled && typeof api.on === "function") {
    api.on(
      "before_prompt_build",
      (event: unknown, ctx: unknown) => {
        const ev = event as { prompt?: unknown };
        const cx = ctx as { agentId?: string; runId?: string };
        if (!cx.agentId || skipAgents.has(cx.agentId)) return;
        if (typeof ev.prompt !== "string") return;
        const matched = matchAutoRoute(ev.prompt, registry);
        if (!matched) return;
        const filePath = isAbsolute(matched.entry.file)
          ? matched.entry.file
          : join(workspaceRoot, matched.entry.file);
        const content = readFileCached(filePath);
        if (content === null) return;
        const section = matched.entry.section;
        const body = section ? extractSection(content, section) : content;
        if (!body) return;
        markRouted(cx.runId, matched.name);
        recordRoutingEvent({
          ts: timestampSeconds(),
          event: "auto_route",
          agentId: cx.agentId,
          runId: cx.runId ?? null,
          topic: matched.name,
          toolName: null,
          destinationClass: null,
        });
        const { text } = truncate(body, maxInjectedBytes);
        return {
          appendContext: `[On-demand context: ${matched.name}/${section ?? "full"}]\n${text}`,
        };
      },
      { priority: 20 },
    );
    api.on("after_tool_call", (event: unknown, ctx: unknown) => {
      const ev = event as {
        toolName?: string;
        params?: Record<string, unknown>;
        result?: unknown;
        error?: string;
      };
      if (ev.toolName !== toolName || ev.error) return;
      const params = ev.params ?? {};
      if (params.list_topics === true || params.list_sections === true) return;
      if (typeof params.topic !== "string") return;
      const result = ev.result as { error?: unknown } | undefined;
      if (typeof result?.error === "string") return;
      const resolved = resolveTopic(registry, params.topic);
      if (!resolved) return;
      const cx = ctx as { agentId?: string; runId?: string };
      const agentId = cx.agentId ?? "unknown";
      if (skipAgents.has(agentId)) return;
      markRouted(cx.runId, resolved.name);
      recordRoutingEvent({
        ts: timestampSeconds(),
        event: "lookup",
        agentId,
        runId: cx.runId ?? null,
        topic: resolved.name,
        toolName,
        destinationClass: null,
      });
    });
    api.on("before_tool_call", (event: unknown, ctx: unknown) => {
      const ev = event as { toolName?: string; derivedPaths?: readonly string[] };
      const cx = ctx as { agentId?: string; runId?: string; toolName?: string };
      const agentId = cx.agentId ?? "unknown";
      if (skipAgents.has(agentId)) return;
      const toolName = ev.toolName ?? cx.toolName ?? "unknown";
      if (!WRITE_TOOLS.has(toolName)) return;
      if (cx.runId && (routedRuns.get(cx.runId)?.size ?? 0) > 0) return;
      const derivedPaths = ev.derivedPaths ?? [];
      const existingRepoEdit = derivedPaths.length > 0 && derivedPaths.every((filePath) =>
        existsSync(filePath) && classifyDestination(filePath, workspaceRoot) === "project"
      );
      if (existingRepoEdit) return;
      const destinationClass = classifyDestination(derivedPaths[0], workspaceRoot);
      recordRoutingEvent({
        ts: timestampSeconds(),
        event: "write_without_route",
        agentId,
        runId: cx.runId ?? null,
        topic: null,
        toolName,
        destinationClass,
      });
      if (observeOnly || destinationClass === "unknown") return;
      return {
        block: true,
        blockReason: "File-placement context was not loaded for this new destination. Call context_lookup({topic:\"file-placement\"}) and retry.",
      };
    });
    api.on("agent_end", (_event: unknown, ctx: unknown) => {
      const runId = (ctx as { runId?: string }).runId;
      if (runId) routedRuns.delete(runId);
    });
  }

  log(`tool '${toolName}' registered (${registry.names.length} topics)`);
}
