# Scene Rehearsal

A local studio for reviewing scene placement, cues and intended behavior before game implementation. Agents publish immutable revisions. The owner inspects scenarios, pins feedback, approves a revision and exports a package.

## Start locally

Use Node 24 LTS (24.15 or newer in that line) and npm.

```sh
npm ci
npm run build
npm start -- --status
npm start
```

Open http://127.0.0.1:4331. The default local library is `~/Library/Application Support/Scene Rehearsal`. A new library starts empty. The status command prints the effective datastore before opening it. For a separate library, set an absolute canonical `SCENE_REHEARSAL_DATA_DIR` and use that same setting for startup and CLI calls. `SCENE_REHEARSAL_PORT` overrides the default loopback port.

Review actions are available directly in the local browser. Approval still asks you to confirm the exact revision.

## Review and publish

Open a published rehearsal and use the timeline to play or inspect a scenario. Pick a point in the viewport or select an object from the inspector. Open **Feedback** to save the pin or time range. Use **Compare revision** to replay a second revision at the same time. Clicking a saved note restores its original context.

```sh
npm run cli -- list
npm run cli -- read REVISION_SHA256
npm run cli -- publish /absolute/path/to/request.json
npm run cli -- verify /absolute/path/to/package.json OWNER_CONFIRMED_SHA256
```

For a new scene, start from the exact owner-approved Loom plan and publish a v3 placeholder draft. Inspect its placement and cues, record what was checked and approve the exact draft for implementation. [Plan draft authoring and Loom writeback](docs/PLAN_DRAFTS.md) covers the request shape, clean draft targets, review evidence and handoff export.

Optional model import remains available in the inspector. Versions 1 and 2 retain their existing playback, asset mapping and approval rules.

## Checks

Run `npm run typecheck`, `npm test`, and `npm run build`. Use an isolated local library when exercising writes in automated tests.

[Development plan](docs/DEVELOPMENT_PLAN.md)

## Historical Kairo fixture (v2)

The [Kairo plan](docs/KAIRO_REHEARSAL_PLAN.md) and [authored draft](fixtures/kairo-office.json) cover the two-station office with synthetic quiet, interruption and recovery scenarios. To publish it locally, use an isolated library: the overrides below are for tests and fixtures only. Normal use needs no variables.

```sh
export SCENE_REHEARSAL_DATA_DIR=/private/tmp/kairo-rehearsal-local
export SCENE_REHEARSAL_PORT=4332
npm start -- --status
npm start
```

In a second terminal from this checkout:

```sh
export SCENE_REHEARSAL_DATA_DIR=/private/tmp/kairo-rehearsal-local
export SCENE_REHEARSAL_PORT=4332
npm run cli -- publish "$PWD/fixtures/kairo-office.json"
```

Open http://127.0.0.1:4332 and select **Kairo · Research and collector office**. The draft shows placeholders for the two required character models. Before importing, compare the selected model against the owner-controlled Mesh Foundry record and enter the exact project, asset, model revision and GLB hash. Publish a child with an asset binding for each required slot. Version 2 uses `{ "hash": "...", "clips": { "quiet": "Clip name" } }` with each required activity mapped. Set `source` to the source key shown after import to pin the exact Mesh Foundry revision, including when two revisions share GLB bytes. Older hash-only bindings continue to resolve to the first source for that hash. Static models omit `clips`. Final approval and the separately confirmed export digest remain owner actions.

### Import from a Mesh Foundry handoff prompt

Mesh Foundry is found through its own `runtime.json`. Start it before importing (`SCENE_REHEARSAL_MESH_FOUNDRY_PORT` still overrides). The agent uses Mesh Foundry's CLI to export a private project bundle, then runs `npm run cli -- import-model /absolute/import-request.json` with the usual rehearsal library and port settings. The request has `bundlePath` (the absolute bundle path) optional `meshFoundryDataDir` (only for a non-default Mesh Foundry library), and `expected` (the copied `project`, `asset`, `revision`, `hash` and ordered `clips` fields). The server checks the GLB and its clips, then compares the exact source identity with the configured Mesh Foundry service's live model-stage acceptance after verifying the service reports the same library. Use the returned `sourceKey` when publishing the v2 draft. This author workflow leaves final approval and export in the local browser.

### Binding one piece of a GLB

For a v2 static slot, use `"asset": { "hash": "<GLB SHA-256>", "source": "<imported sourceKey>", "node": "V0.9 Desk Pivot" }`.
`node` matches the exact, case-sensitive glTF `nodes[].name` in the default scene, including spaces and punctuation. Name the piece's pivot uniquely among nodes reachable from that scene. Missing and duplicate names are rejected. Omitting `node` loads the whole default scene.

The slot places the selected pivot at its authored position. Scene Rehearsal excludes ancestor transforms and compensates for the pivot's original translation. Pivot rotation and scale, descendant transforms, geometry and materials are retained. The subtree must contain geometry. Every channel of a mapped animation clip must target a node inside that subtree.

Kairo Scene 1 uses one GLB from Mesh Foundry asset `kairo-research-desk-kit`, accepted revision `kairo-research-desk-kit-scene1-fit-model-1`, SHA-256 `c1faee3d87aebf977b92b8e1a1b7479a84d39a4f610f3c3898ee8a16ccfdf72d`. All four slots use the same imported source key.

| Slot | Exact node name | GLB node index |
| --- | --- | ---: |
| `v09` | `V0.9 Desk Pivot` | 81 |
| `x1` | `X1 Desk Pivot` | 172 |
| `v09-chair` | `V0.9 Chair Pivot` | 14 |
| `x1-chair` | `X1 Chair Pivot` | 96 |
