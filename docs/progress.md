# Progress

## 2026-11-22
- Added the per-draft asset spec (`src/spec.ts`, `cli spec`, `GET /api/spec`), optional `scaleReference`, `objects[].build` and cue `targets` fields, and the digest-based staleness check. Documented in PLAN_DRAFTS.md.
- Service hygiene: `runtime.json`, `--status`, `GET /api/status` and the header now show port, pid, data dir, code revision and start time. A second start reports the running instance.
- Tests: tests/asset-spec.test.ts. No lint, format or browser test scripts exist in this repo.
- Not done: no Impeccable review of the small header status line, no browser check.
