#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const register = require("./index.js").default;

function createHarness(pluginConfig = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "context-routing-"));
  fs.mkdirSync(path.join(root, "shared"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "shared", "file-placement-rules.md"),
    [
      "# File placement",
      "",
      "## 快速決策",
      "TMP_DEFAULT",
      "",
      "## 完整參考",
      "FULL_ONLY",
    ].join("\n"),
  );
  fs.writeFileSync(path.join(root, "shared", "tooling.md"), "# Tooling\n\nTOOL_ONLY\n");
  fs.writeFileSync(
    path.join(root, "topics.json"),
    JSON.stringify({
      topics: {
        "file-placement": {
          file: "shared/file-placement-rules.md",
          category: "common-rules",
          section: "快速決策",
          aliases: ["placement", "storage"],
          triggers: ["下載", "匯出", "move", "archive"],
        },
        tooling: {
          file: "shared/tooling.md",
          category: "common-rules",
          triggers: ["tooling-trigger"],
        },
      },
      categories: { "common-rules": { name: "通用", order: 1 } },
    }),
  );

  const hooks = {};
  let tool;
  const api = {
    pluginConfig,
    getWorkspaceRoot: () => root,
    registerTool: (definition) => {
      tool = typeof definition === "function"
        ? definition({ agentId: "main", workspaceDir: root })
        : definition;
    },
    on: (name, handler) => { hooks[name] = handler; },
  };
  register(api);
  assert.ok(tool, "context_lookup tool should register");

  return {
    root,
    tool,
    hooks,
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

async function executeTool(harness, params) {
  return harness.tool.execute("test-call", params, undefined, undefined, {});
}

function detailsOf(result) {
  assert.ok(Array.isArray(result.content), "tool result content must use the OpenClaw block-array contract");
  assert.equal(result.content[0]?.type, "text");
  assert.equal(typeof result.content[0]?.text, "string");
  return result.details;
}

async function testDefaultSectionAndSuggestion() {
  const harness = createHarness();
  try {
    const aliasResult = detailsOf(await executeTool(harness, { topic: "placement" }));
    assert.equal(aliasResult.topic, "file-placement");
    assert.equal(aliasResult.section, "快速決策");
    assert.match(aliasResult.content, /TMP_DEFAULT/);
    assert.doesNotMatch(aliasResult.content, /FULL_ONLY/);

    const unknown = detailsOf(await executeTool(harness, { topic: "file-place" }));
    assert.match(unknown.error, /Did you mean: file-placement/);
  } finally {
    harness.cleanup();
  }
}

async function testConditionalRouting() {
  const harness = createHarness({
    routing: { enabled: true, observeOnly: true, maxInjectedBytes: 2500 },
  });
  try {
    assert.equal(
      typeof harness.hooks.before_prompt_build,
      "function",
      "before_prompt_build hook should register when routing is enabled",
    );
    const noTriggerInjection = harness.hooks.before_prompt_build(
      { prompt: "請回答今天星期幾", messages: [] },
      { agentId: "main", runId: "run-no-trigger" },
    );
    assert.equal(noTriggerInjection, undefined);

    const triggerInjection = harness.hooks.before_prompt_build(
      { prompt: "幫我下載並整理這份報告", messages: [] },
      { agentId: "main", runId: "run-trigger" },
    );
    assert.match(triggerInjection.appendContext, /file-placement\/快速決策/);
    assert.match(triggerInjection.appendContext, /TMP_DEFAULT/);
    assert.doesNotMatch(triggerInjection.appendContext, /FULL_ONLY/);

    const missingDefaultSection = harness.hooks.before_prompt_build(
      { prompt: "tooling-trigger", messages: [] },
      { agentId: "main", runId: "run-no-default-section" },
    );
    assert.equal(
      missingDefaultSection,
      undefined,
      "auto-route must never inject a whole file when the topic has no default section",
    );
  } finally {
    harness.cleanup();
  }
}

async function testObserveOnlyTelemetry() {
  const harness = createHarness({
    routing: {
      enabled: true,
      observeOnly: true,
      telemetryFile: "logs/context-routing.jsonl",
      maxInjectedBytes: 2500,
    },
  });
  try {
    assert.equal(
      typeof harness.hooks.before_tool_call,
      "function",
      "before_tool_call hook should register for observe-only telemetry",
    );
    assert.equal(harness.hooks.agent_end, undefined, "routing must not require conversation-access hooks");

    harness.hooks.before_prompt_build(
      { prompt: "請下載檔案", messages: [] },
      { agentId: "main", runId: "run-auto" },
    );
    assert.equal(
      typeof harness.hooks.after_tool_call,
      "function",
      "after_tool_call hook should associate manual lookup with the active run",
    );
    const lookupResult = await executeTool(harness, { topic: "file-placement" });
    harness.hooks.after_tool_call(
      {
        toolName: "context_lookup",
        params: { topic: "file-placement" },
        result: lookupResult,
      },
      { agentId: "main", runId: "run-lookup", sessionId: "session-lookup" },
    );
    const routedToolResult = harness.hooks.before_tool_call(
      {
        toolName: "write",
        params: {},
        derivedPaths: [path.join(harness.root, "outputs", "pdf", "report.pdf")],
      },
      { agentId: "main", runId: "run-lookup", toolName: "write" },
    );
    assert.equal(routedToolResult, undefined);

    const beforeToolResult = harness.hooks.before_tool_call(
      {
        toolName: "write",
        params: {},
        derivedPaths: [path.join(harness.root, "outputs", "pdf", "miss.pdf")],
      },
      { agentId: "main", runId: "run-miss", toolName: "write" },
    );
    assert.equal(beforeToolResult, undefined, "observe-only mode cannot block writes");

    const unrelatedLookupResult = await executeTool(harness, { topic: "tooling" });
    harness.hooks.after_tool_call(
      {
        toolName: "context_lookup",
        params: { topic: "tooling" },
        result: unrelatedLookupResult,
      },
      { agentId: "main", runId: "run-unrelated-lookup" },
    );
    harness.hooks.before_tool_call(
      {
        toolName: "write",
        params: {},
        derivedPaths: [path.join(harness.root, "outputs", "pdf", "unrelated.pdf")],
      },
      { agentId: "main", runId: "run-unrelated-lookup", toolName: "write" },
    );

    const existingRepoFile = path.join(harness.root, "projects", "app", "src", "existing.ts");
    fs.mkdirSync(path.dirname(existingRepoFile), { recursive: true });
    fs.writeFileSync(existingRepoFile, "export const existing = true;\n");
    harness.hooks.before_tool_call(
      { toolName: "edit", params: {}, derivedPaths: [existingRepoFile] },
      { agentId: "main", runId: "run-existing-edit", toolName: "edit" },
    );

    const telemetryPath = path.join(harness.root, "logs", "context-routing.jsonl");
    const raw = fs.readFileSync(telemetryPath, "utf8").trim();
    const events = raw.split("\n").map((line) => JSON.parse(line));
    assert.deepEqual(events.map((event) => event.event), [
      "auto_route",
      "lookup",
      "write_without_route",
      "lookup",
      "write_without_route",
    ]);
    assert.equal(events[2].destinationClass, "outputs");
    assert.equal(events[4].runId, "run-unrelated-lookup");
    assert.ok(events.every((event) => !Object.hasOwn(event, "prompt")));
    assert.ok(events.every((event) => !Object.hasOwn(event, "path")));
    assert.doesNotMatch(raw, new RegExp(harness.root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  } finally {
    harness.cleanup();
  }
}

function testManifestRoutingSchema() {
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "openclaw.plugin.json"), "utf8"));
  assert.equal(manifest.version, "1.3.0");
  const routing = manifest.configSchema.properties.routing;
  assert.equal(routing.type, "object");
  assert.deepEqual(routing.properties.observeOnly.type, "boolean");
  assert.equal(routing.properties.maxInjectedBytes.minimum, 256);
  assert.equal(routing.properties.maxInjectedBytes.maximum, 4096);
  assert.equal(routing.additionalProperties, false);
}

async function testLimitedBlockingWhenExplicitlyEnabled() {
  const harness = createHarness({
    routing: { enabled: true, observeOnly: false, maxInjectedBytes: 2500 },
  });
  try {
    const blockedNewOutput = harness.hooks.before_tool_call(
      {
        toolName: "write",
        params: {},
        derivedPaths: [path.join(harness.root, "outputs", "pdf", "new.pdf")],
      },
      { agentId: "main", runId: "run-block", toolName: "write" },
    );
    assert.deepEqual(blockedNewOutput, {
      block: true,
      blockReason: "File-placement context was not loaded for this new destination. Call context_lookup({topic:\"file-placement\"}) and retry.",
    });

    const existingRepoFile = path.join(harness.root, "projects", "app", "src", "existing.ts");
    fs.mkdirSync(path.dirname(existingRepoFile), { recursive: true });
    fs.writeFileSync(existingRepoFile, "export const existing = true;\n");
    const existingRepoEdit = harness.hooks.before_tool_call(
      { toolName: "edit", params: {}, derivedPaths: [existingRepoFile] },
      { agentId: "main", runId: "run-repo", toolName: "edit" },
    );
    assert.equal(existingRepoEdit, undefined);

    const opaqueExecCall = harness.hooks.before_tool_call(
      { toolName: "exec", params: { command: "build" } },
      { agentId: "main", runId: "run-exec", toolName: "exec" },
    );
    assert.equal(opaqueExecCall, undefined);

    const unknownWrite = harness.hooks.before_tool_call(
      { toolName: "write", params: {} },
      { agentId: "main", runId: "run-unknown-write", toolName: "write" },
    );
    assert.equal(unknownWrite, undefined, "writes without a reliable destination stay unblocked");
  } finally {
    harness.cleanup();
  }
}

async function testRoutingStateIsBounded() {
  const harness = createHarness({
    routing: {
      enabled: true,
      observeOnly: true,
      telemetryFile: "logs/context-routing.jsonl",
    },
  });
  try {
    for (let i = 0; i < 130; i += 1) {
      harness.hooks.before_prompt_build(
        { prompt: "下載檔案", messages: [] },
        { agentId: "main", runId: `run-${i}` },
      );
    }
    harness.hooks.before_tool_call(
      {
        toolName: "write",
        params: {},
        derivedPaths: [path.join(harness.root, "outputs", "pdf", "oldest.pdf")],
      },
      { agentId: "main", runId: "run-0", toolName: "write" },
    );
    harness.hooks.before_tool_call(
      {
        toolName: "write",
        params: {},
        derivedPaths: [path.join(harness.root, "outputs", "pdf", "newest.pdf")],
      },
      { agentId: "main", runId: "run-129", toolName: "write" },
    );

    const telemetryPath = path.join(harness.root, "logs", "context-routing.jsonl");
    const misses = fs.readFileSync(telemetryPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
      .filter((event) => event.event === "write_without_route");
    assert.deepEqual(misses.map((event) => event.runId), ["run-0"]);
  } finally {
    harness.cleanup();
  }
}

Promise.resolve()
  .then(testDefaultSectionAndSuggestion)
  .then(testConditionalRouting)
  .then(testObserveOnlyTelemetry)
  .then(testManifestRoutingSchema)
  .then(testLimitedBlockingWhenExplicitlyEnabled)
  .then(testRoutingStateIsBounded)
  .then(() => console.log("6 total | 6 pass | 0 fail"))
  .catch((error) => {
    console.error(error.stack || error);
    process.exit(1);
  });
