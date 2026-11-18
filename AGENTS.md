# Scene Rehearsal

- Start with [the development plan](docs/DEVELOPMENT_PLAN.md). Use Node 24 LTS, npm ci, npm run build, and npm start. Run npm run typecheck and npm test before handoff. Use npm start -- --status to check the effective local datastore before running a flow that writes.
- Use [the draft contract](docs/PLAN_DRAFTS.md) for new Loom-linked scenes. A scene has one mutable draft and the owner accepts it in the app. The CLI finds or starts the service itself, so use no env vars or paths for normal work.
- Scene Loom project `scene-rehearsal` records design decisions. Use its CLI for authorized changes. Mesh Foundry owns asset acceptance. Kairo consumes an approved handoff.
- Keep local libraries, sessions, test stores and asset bytes outside Git. Use isolated libraries and fictional evidence in tests.
- Agent authoring can publish drafts. Explicit owner review actions control feedback decisions and acceptance of exact revisions.
