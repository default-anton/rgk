# Changelog

All notable changes to `rgk` are documented here.

## Format

- Keep `## [Unreleased]` at the top.
- Use release headers as `## [X.Y.Z] - YYYY-MM-DD`.
- Group entries under `### Added`, `### Changed`, `### Fixed` (optionally `### Removed` / `### Security`).
- Keep entries short and operator/user-facing.

## [Unreleased]

### Added

- None.

### Changed

- None.

### Fixed

- None.

## [0.2.2] - 2026-05-11

### Added

- None.

### Changed

- Clarified the recommended AGENTS.md guidance for `rgk` and the Pi `rg` extension.

### Fixed

- None.

## [0.2.1] - 2026-05-10

### Added

- None.

### Changed

- Changed the default Codex reasoning effort to `none`.

### Fixed

- None.

## [0.2.0] - 2026-05-10

### Added

- Added automatic multi-request `--keep` filtering when results exceed one Codex prompt.
- Added `RGK_TOTAL_PROMPT_MAX_BYTES` and `RGK_CODEX_CONCURRENCY` keep-mode controls.

### Changed

- Changed `RGK_PROMPT_MAX_BYTES` to limit each Codex request instead of failing the whole keep run.

### Removed

- Removed `RGK_KEEP_LIMIT`; keep mode is now bounded by prompt byte budgets.

### Fixed

- None.

## [0.1.2] - 2026-05-09

### Added

- Added a Pi package extension that aliases Pi bash-tool `rg` commands to `rgk`.

### Changed

- None.

### Fixed

- None.

## [0.1.1] - 2026-05-08

### Added

- None.

### Changed

- Changed the default Codex model to `gpt-5.4-mini` and reasoning effort to `medium`.

### Fixed

- None.

## [0.1.0] - 2026-05-08

### Added

- Added `rgk`, a ripgrep-compatible CLI with LLM-powered `--keep` filtering and ranking.
- Added npm package publishing for `@akuzmenko/rgk`.

### Changed

- None.

### Fixed

- None.
