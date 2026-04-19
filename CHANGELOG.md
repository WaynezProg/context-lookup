# Changelog

All notable changes to this project are documented in this file. The format
is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.2.0] — 2026-04-19

### Added
- **i18n for tool description** via `locale` plugin config (`"en"` default,
  `"zh-TW"` available). Agent locale is independent of registry contents.
- **`workspaceRoot` plugin config** as an explicit override for hosts that do
  not provide one via `api.runtime.workspaceRoot` / `api.getWorkspaceRoot()`.
- `examples/topics.example.json` — generic, project-agnostic registry sample.
- `LICENSE` (MIT).
- This `CHANGELOG.md`.

### Changed
- README rewritten in English, focused on quick-start, installation, and a
  full configuration / API reference. Now suitable for upstream sharing.
- Plugin manifest `version` bumped to `1.2.0`.
- workspaceRoot resolution order made explicit and documented; the
  `~/.openclaw/workspace` default is now last-resort and only triggers when
  no host or plugin config provides one.

### Fixed
- Plugin now exits with a clear warning instead of silently using a guessed
  workspace path when neither host nor config nor environment supplies one.

## [1.1.0] — 2026-04-19

### Changed
- **Tool description shrunk from ~30 lines to 7 lines.** No longer enumerates
  every topic; agents call `list_topics` on demand. Saves ~25 lines of
  prompt overhead per turn per agent.
- **`list_topics` now returns `{ categories: [{ id, name, topics: [...] }] }`**
  grouped and sorted by category metadata. Topic entries gain an optional
  `category` field; registry gains an optional `categories` map (id → name +
  order).

## [1.0.0] — 2026-04-19

### Added
- Initial release. Single tool `context_lookup` with four query modes:
  `topic`, `topic + section`, `list_topics`, `list_sections`.
- JSON-based topic registry with optional aliases and default sections.
- Multi-shape host API resolution (`api.runtime.*` / `api.pluginConfig` /
  legacy `api.getConfig()` / `api.getWorkspaceRoot()`).
- File caching keyed by mtime, response truncation at `maxBytes`.
