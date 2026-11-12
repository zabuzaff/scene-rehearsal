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

Open http://127.0.0.1:4331 and select **Kairo research office**. The default local library is `~/Library/Application Support/Scene Rehearsal`. Startup adds the fictional rehearsal to an empty library. The status command prints the effective datastore before opening it. For a separate library, set an absolute canonical `SCENE_REHEARSAL_DATA_DIR` and use that same setting for startup and CLI calls. `SCENE_REHEARSAL_PORT` overrides the default loopback port.

Click **Unlock review**. Press Enter in the server terminal to generate a one-time code, then enter it in the browser. The code expires after two minutes. A server restart requires a new owner session.

## Review and publish

Choose **Collector interruption**, select the second event, and scrub or step to see the response. Pick a point in the viewport or select an object from the inspector. Open **Feedback** to save the pin or time range. Use **Compare revision** to replay a second revision at the same time. Clicking a saved note restores its original context.

```sh
npm run cli -- list
npm run cli -- read REVISION_SHA256
npm run cli -- publish /absolute/path/to/request.json
npm run cli -- verify /absolute/path/to/package.json OWNER_CONFIRMED_SHA256
```

Use the read result's `scene` as the base. The publication request has `request` (unique request ID), `parent` (current head SHA-256), `scene` (updated manifest), and `links` (feedback IDs addressed). If you change behavior, update the corresponding scenario checkpoints. Retrying the same request returns the same revision. A stale parent requires rereading the head. The CLI reads its author credential from the local library.

Use **Import Mesh Foundry model** with a Mesh Foundry project bundle and the accepted model's asset ID. The import returns the GLB hash and clip names. In the next draft, set the required object's `asset` to `{ "hash": "...", "clip": "..." }`. The seeded blockout requires a mapped asset for final approval. The owner approves the exact mapped revision, exports the package and confirms the displayed manifest digest separately with the consumer. Blockout approval is recorded independently. Older revisions without embedded room geometry can still be opened. Publish a child revision to include the room, then review and approve that revision for a new export.

## Checks

Run `npm run typecheck`, `npm test`, and `npm run build`. Use an isolated local library when exercising writes in automated tests.

[Development plan](docs/DEVELOPMENT_PLAN.md)

## Kairo rehearsal draft

The [Kairo plan](docs/KAIRO_REHEARSAL_PLAN.md) and [authored draft](fixtures/kairo-office.json) cover the two-station office with synthetic quiet, interruption and recovery scenarios. To publish it locally, use an empty dedicated library. The initialization flag is needed on first startup only. Use the same data directory and port for the CLI and later starts.

```sh
export SCENE_REHEARSAL_DATA_DIR=/private/tmp/kairo-rehearsal-local
export SCENE_REHEARSAL_PORT=4332
SCENE_REHEARSAL_INIT=empty npm start -- --status
SCENE_REHEARSAL_INIT=empty npm start
```

In a second terminal from this checkout:

```sh
export SCENE_REHEARSAL_DATA_DIR=/private/tmp/kairo-rehearsal-local
export SCENE_REHEARSAL_PORT=4332
npm run cli -- publish "$PWD/fixtures/kairo-office.json"
```

Open http://127.0.0.1:4332 and select **Kairo · Research and collector office**. Review access uses the same terminal-issued code described above. The draft shows placeholders for the two required character models. Before importing, compare the selected model against the owner-controlled Mesh Foundry record and enter the exact project, asset, model revision and GLB hash. Publish a child with an asset binding for each required slot. Version 2 uses `{ "hash": "...", "clips": { "quiet": "Clip name" } }` with each required activity mapped. Set `source` to the source key shown after import to pin the exact Mesh Foundry revision, including when two revisions share GLB bytes. Older hash-only bindings continue to resolve to the first source for that hash. Static models omit `clips`. Final approval and the separately confirmed export digest remain owner actions.
