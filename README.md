# Scene Rehearsal

A local studio for reviewing simulation behavior before integrating it into a consumer application. Agents publish immutable revisions. The owner inspects scenarios, pins feedback, approves a revision and exports a package.

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

Use the read result's `scene` as the base. The publication request has `request` (unique request ID), `parent` (current head SHA-256), `scene` (updated manifest), and `links` (feedback IDs addressed). If you change behavior, update the corresponding scenario checkpoints. Retrying the same request returns the same revision. A stale parent requires rereading the head. The CLI reads its author credential from the local library.

Use **Import Mesh Foundry model** with a Mesh Foundry project bundle and the accepted model's asset ID. The import returns the GLB hash and clip names. In the next draft, set the required object's `asset` to `{ "hash": "...", "clip": "..." }`. Click **Accept revision** in the local studio to approve the exact mapped revision without signing in. The owner then exports the package and confirms the displayed manifest digest separately with the consumer. Blockout approval is recorded independently. Older revisions without embedded room geometry can still be opened. Publish a child revision to include the room, then review and approve that revision for a new export.

## Checks

Run `npm run typecheck`, `npm test`, and `npm run build`. Use an isolated local library when exercising writes in automated tests.

[Development plan](docs/DEVELOPMENT_PLAN.md)

## Kairo rehearsal draft

The [Kairo plan](docs/KAIRO_REHEARSAL_PLAN.md) and [authored draft](fixtures/kairo-office.json) cover the two-station office with synthetic quiet, interruption and recovery scenarios. To publish it locally, use an empty dedicated library. Use the same data directory and port for the CLI and later starts.

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

Start Scene Rehearsal with `SCENE_REHEARSAL_MESH_FOUNDRY_PORT` set to the port of the running trusted local Mesh Foundry library. The agent uses Mesh Foundry's CLI to export a private project bundle, then runs `npm run cli -- import-model /absolute/import-request.json` with the usual rehearsal library and port settings. The request has `bundlePath` (the absolute bundle path) `meshFoundryDataDir` (the absolute source data directory from the prompt), and `expected` (the copied `project`, `asset`, `revision`, `hash` and ordered `clips` fields). The server checks the GLB and its clips, then compares the exact source identity with the configured Mesh Foundry service's live model-stage acceptance after verifying the service reports the same library. Use the returned `sourceKey` when publishing the v2 draft. This author workflow leaves final approval and export in the local browser.
