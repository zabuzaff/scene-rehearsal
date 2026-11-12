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
