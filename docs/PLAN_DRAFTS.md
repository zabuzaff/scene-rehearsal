# Placeholder drafts

There is one mutable draft per Loom storyboard scene. Publishing again for the same `storyboardId` and `sceneId` overwrites that draft in place. There is no revision chain, parent digest or per-plan head. The owner reviews it in Rehearsal and clicks **Accept draft**. Loom only links to it.

## Publish and read back

The CLI needs no setup. It finds the running service through `runtime.json` in the data directory (default `~/Library/Application Support/Scene Rehearsal`) and starts it if it is not running. The service uses port 4331, or a free port if that one is busy. `SCENE_REHEARSAL_DATA_DIR` and `SCENE_REHEARSAL_PORT` remain as overrides for tests and isolated libraries only.

```sh
npm --silent run cli -- list
npm --silent run cli -- publish draft-request.json
npm --silent run cli -- read DRAFT_ID
```

The request shape is `{ request, scene, links? }`. `parent` is accepted and ignored for v3. See [Lighthouse landing](../fixtures/lighthouse-arrival.json). For v3, `scene.plan` needs `storyboardId` and `sceneId`. `planId`, `planRevision` and `approvalId` are optional and kept only for older drafts.

Publication returns `{ revision }`, the stable draft ID. It stays the same for the life of the scene's draft, so the URL `http://127.0.0.1:PORT/revision/DRAFT_ID/SCENARIO_ID` does not change. `read` shows `draftRev` (a counter of content changes) and `updatedAt`. `list` returns `drafts` with each `key` (`storyboardId/sceneId`), `digest`, `rev` and `updated`.

- **Update:** a publish with changed content replaces the draft, bumps `draftRev`, and clears acceptance and its review text. A publish with identical content changes nothing and keeps acceptance.
- **Feedback pins:** pins stay on the draft across updates. Pins are stored with the draft, so an update keeps them even if the object they point at was removed. Link pins you addressed with `links`, and the owner resolves them.
- **Retries:** an identical request with the same request ID returns the same draft.
- **Older history:** v1/v2 revisions and v3 revisions published before this change stay readable by their digests.

The owner keeps no exact-revision guarantee. Acceptance applies to the draft content at the time the owner clicked, and any later change resets it.

## Author and inspect

Coordinates and proxy dimensions use meters in a Y-up frame. Each box or marker has a stable ID, center position, base size, positive scale factors and XYZ Euler rotation in radians. A group proxy lists the stable IDs of the pieces represented by its placement. A box uses its given dimensions, and an octahedral marker uses those dimensions as its extents. Optional static GLBs use the existing import flow and are placed at the same authored transform. Use a source key to pin an exact imported source. Clip playback remains available for legacy mappings.

Scenarios advance at 10 ticks per second. As playback reaches a traversal cue, its authored polyline appears. Select a camera cue to inspect its supplied position and target. The event list carries intended behaviors and timing, and the pending checks carry work for the game implementation. Traversal previews show a path, with player control, collision, navigation, animation and game timing left to implementation checks.

Reviewers open the draft, use **Copy review prompt** to start a read-only review in a new chat, use placement and playback controls, and pin feedback for needed changes. To approve, record what was checked and choose **Approve this draft**. The review action (**Accept draft**) uses the local reviewer session, with `POST /api/revision/DRAFT_ID/approve` and body `{ "kind": "final", "review": { "checked": "…" } }`. `read DIGEST` returns the review text as `draftReview.checked` and the approval timestamp in `approvals`. Loom should read this exact evidence back and check that the digest and plan still match the recorded active draft before advancing to implementation. A child revision starts with its own review state.

The approved handoff is a `scene-rehearsal-3` package containing the exact plan, proxy transforms, piece IDs, cues, pending checks and review evidence. A placeholder-only export has empty `assets` and `blobs`. Use `cli verify PACKAGE OWNER_CONFIRMED_SHA256` for package integrity. The game implementer should carry the approved placements and intent forward and run the pending implementation checks in the game.

## Loom integration

Loom records the plan, then a `draft` link (`url`, `draftId`, `scenarioId`) after reading this service. Loom's start-implementation prompt reads the draft back, requires the final approval, and continues in the game. Package digests identify one export snapshot only.
