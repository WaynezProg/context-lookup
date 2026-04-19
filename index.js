var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// index.ts
var index_exports = {};
__export(index_exports, {
  default: () => register
});
module.exports = __toCommonJS(index_exports);
var import_fs = require("fs");
var import_path = require("path");
var DEFAULT_TOPICS_FILE = "topics.json";
var DEFAULT_TOOL_NAME = "context_lookup";
var DEFAULT_MAX_BYTES = 64e3;
var fileCache = /* @__PURE__ */ new Map();
function readFileCached(filePath) {
  try {
    const st = (0, import_fs.statSync)(filePath);
    const cached = fileCache.get(filePath);
    if (cached && cached.mtimeMs === st.mtimeMs) return cached.content;
    const content = (0, import_fs.readFileSync)(filePath, "utf-8");
    fileCache.set(filePath, { mtimeMs: st.mtimeMs, content });
    return content;
  } catch {
    return null;
  }
}
function extractSection(content, section) {
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
  const result = [lines[startIdx]];
  for (let i = startIdx + 1; i < lines.length; i++) {
    const m = lines[i].match(/^(#{1,6}) /);
    if (m && m[1].length <= startLevel) break;
    result.push(lines[i]);
  }
  return result.join("\n");
}
function listHeadings(content) {
  return content.match(/^#{1,6} .+$/gm) ?? [];
}
function truncate(content, maxBytes) {
  const buf = Buffer.from(content, "utf-8");
  if (buf.byteLength <= maxBytes) return { text: content, truncated: false };
  const sliced = buf.subarray(0, maxBytes).toString("utf-8");
  const note = `

\u2026[truncated: original ${buf.byteLength} bytes, returned ${maxBytes}]`;
  return { text: sliced + note, truncated: true };
}
function log(msg) {
  console.log(`[context-lookup] ${msg}`);
}
function warn(msg) {
  console.log(`[context-lookup] WARN: ${msg}`);
}
function resolveDefaultWorkspaceRoot() {
  const env = process.env;
  const home = env.HOME || env.USERPROFILE;
  if (!home) return process.cwd();
  const profile = env.OPENCLAW_PROFILE?.trim();
  const sub = profile && profile.toLowerCase() !== "default" ? `workspace-${profile}` : "workspace";
  return (0, import_path.join)(home, ".openclaw", sub);
}
function loadRegistry(workspaceRoot, topicsFile) {
  const path = (0, import_path.isAbsolute)(topicsFile) ? topicsFile : (0, import_path.join)(workspaceRoot, topicsFile);
  const empty = {
    byName: /* @__PURE__ */ new Map(),
    aliasIndex: /* @__PURE__ */ new Map(),
    names: [],
    sourcePath: path
  };
  if (!(0, import_fs.existsSync)(path)) {
    warn(`topics file not found: ${path} \u2014 context_lookup will return errors until it exists`);
    return empty;
  }
  let parsed;
  try {
    parsed = JSON.parse((0, import_fs.readFileSync)(path, "utf-8"));
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    warn(`failed to parse topics file ${path}: ${msg}`);
    return empty;
  }
  if (!parsed.topics || typeof parsed.topics !== "object") {
    warn(`topics file ${path} missing required "topics" object`);
    return empty;
  }
  const byName = /* @__PURE__ */ new Map();
  const aliasIndex = /* @__PURE__ */ new Map();
  for (const [name, entry] of Object.entries(parsed.topics)) {
    if (!entry || typeof entry !== "object" || typeof entry.file !== "string") {
      warn(`topic "${name}" missing required "file" \u2014 skipped`);
      continue;
    }
    byName.set(name, entry);
    if (Array.isArray(entry.aliases)) {
      for (const alias of entry.aliases) {
        if (typeof alias !== "string") continue;
        if (aliasIndex.has(alias) || byName.has(alias)) {
          warn(`alias "${alias}" of "${name}" collides with existing topic/alias \u2014 skipped`);
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
    sourcePath: path
  };
}
function resolveTopic(reg, query) {
  const direct = reg.byName.get(query);
  if (direct) return { name: query, entry: direct };
  const aliased = reg.aliasIndex.get(query);
  if (aliased) {
    const entry = reg.byName.get(aliased);
    if (entry) return { name: aliased, entry };
  }
  return null;
}
function buildToolDescription(reg, toolName) {
  if (reg.names.length === 0) {
    return `Look up topic-indexed reference content on demand. Topic registry currently empty (expected at ${reg.sourcePath}). Call ${toolName}({list_topics:true}) once it is populated.`;
  }
  const lines = [
    `Look up topic-indexed reference content (shared docs, tool guides, etc.) on demand.`,
    `Call ${toolName}({topic:"<name>"}) to fetch a topic. Pass {list_topics:true} to enumerate. Pass {section:"<heading>"} to slice by heading; {list_sections:true} to see headings only.`,
    ``,
    `Available topics:`
  ];
  for (const name of reg.names) {
    const entry = reg.byName.get(name);
    const desc = entry.description ? ` \u2014 ${entry.description}` : "";
    lines.push(`- ${name}${desc}`);
  }
  return lines.join("\n");
}
function register(api) {
  const anyApi = api;
  const config = anyApi.pluginConfig ?? (anyApi.id && anyApi.config?.plugins?.entries?.[anyApi.id]?.config) ?? api.getConfig?.() ?? {};
  const rawWorkspaceRoot = anyApi.runtime?.workspaceRoot ?? api.getWorkspaceRoot?.() ?? null;
  const workspaceRoot = rawWorkspaceRoot && rawWorkspaceRoot !== "/" ? rawWorkspaceRoot : resolveDefaultWorkspaceRoot();
  const topicsFile = config.topicsFile ?? DEFAULT_TOPICS_FILE;
  const toolName = config.toolName ?? DEFAULT_TOOL_NAME;
  const maxBytes = typeof config.maxBytes === "number" && config.maxBytes > 0 ? config.maxBytes : DEFAULT_MAX_BYTES;
  const skipAgents = new Set(config.skipAgents ?? []);
  const registry = loadRegistry(workspaceRoot, topicsFile);
  log(
    `v1.0 init: workspaceRoot=${workspaceRoot}, topicsFile=${registry.sourcePath}, topics=${registry.names.length}, tool=${toolName}`
  );
  if (typeof api.registerTool !== "function") {
    warn("registerTool not available on this host \u2014 plugin disabled");
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
          description: "Topic name from the registry (or its alias). Required unless `list_topics` is true."
        },
        section: {
          type: "string",
          description: "Optional heading substring (case-insensitive). Returns just that section instead of the full file. Overrides the topic's default section."
        },
        list_topics: {
          type: "boolean",
          description: "Return the full topic registry (name, description, file) instead of a topic body."
        },
        list_sections: {
          type: "boolean",
          description: "Return the list of markdown headings in the resolved topic file instead of its content."
        }
      }
    },
    execute: async (params, toolCtx) => {
      const p = params ?? {};
      const agentId = toolCtx?.agentId ?? "unknown";
      if (skipAgents.has(agentId)) {
        return { error: `context_lookup is disabled for agent '${agentId}'` };
      }
      if (p.list_topics) {
        return {
          topics: registry.names.map((name2) => {
            const entry2 = registry.byName.get(name2);
            return {
              name: name2,
              description: entry2.description ?? null,
              file: entry2.file,
              default_section: entry2.section ?? null,
              aliases: entry2.aliases ?? []
            };
          })
        };
      }
      if (!p.topic || typeof p.topic !== "string") {
        return {
          error: `Missing required parameter 'topic'. Pass {list_topics:true} to see options. Available: ${registry.names.join(", ") || "(none)"}`
        };
      }
      const resolved = resolveTopic(registry, p.topic);
      if (!resolved) {
        return {
          error: `Unknown topic '${p.topic}'. Available: ${registry.names.join(", ") || "(none)"}`
        };
      }
      const { name, entry } = resolved;
      const filePath = (0, import_path.isAbsolute)(entry.file) ? entry.file : (0, import_path.join)(workspaceRoot, entry.file);
      const content = readFileCached(filePath);
      if (content === null) {
        return { error: `File for topic '${name}' not found: ${filePath}` };
      }
      if (p.list_sections) {
        return { topic: name, file: filePath, sections: listHeadings(content) };
      }
      const sectionQuery = p.section ?? entry.section;
      let body = content;
      if (sectionQuery) {
        const extracted = extractSection(content, sectionQuery);
        if (!extracted) {
          return {
            error: `Section '${sectionQuery}' not found in topic '${name}' (${filePath}). Pass {list_sections:true} to see available headings.`
          };
        }
        body = extracted;
      }
      const { text, truncated } = truncate(body, maxBytes);
      const result = { topic: name, file: filePath, content: text };
      if (sectionQuery) result.section = sectionQuery;
      if (truncated) result.truncated = true;
      return result;
    }
  });
  log(`tool '${toolName}' registered (${registry.names.length} topics)`);
}
