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

## Asset spec for Mesh Foundry

Assets are built to the rehearsal, not the other way round: Loom plans, Rehearsal fixes placeholder layout, camera, routes and cues, then Foundry builds each asset to the spec derived from the accepted draft. Rehearsal does not import or fit Foundry assets in this flow.

```sh
npm --silent run cli -- spec DRAFT_ID_OR_STORYBOARD/SCENE [--expect CONTENT_DIGEST] [--unapproved] [--out /absolute/spec.json]
```

`GET /api/spec?scene=DRAFT_ID_OR_STORYBOARD/SCENE[&expect=CONTENT_DIGEST][&unapproved=1]` returns the same JSON. Without `unapproved` the draft must be accepted (409 otherwise). `--out` writes the file atomically and prints only `{ written, contentDigest, specDigest }`.

**Staleness.** `source.contentDigest` is the SHA-256 of the draft scene content (the draft ID itself never changes). Store it with the built asset. Pass it back as `--expect` (or `expect=`): the response gains `check: { expected, current, stale }` and the CLI exits with code 3 when stale. Any edit to the draft also clears acceptance. `specDigest` is the SHA-256 of the canonical spec without `specDigest`.

**Authoring fields** (all optional, in the published draft):

- `scaleReference`: `{ asset, label?, height? }`, scene level. `asset` is the Foundry asset ID of the scale reference (for example the baseline character); `height` is its height in metres.
- `objects[].build`: `{ anchor?: "base-center" | "center", walkable?: boolean, clearance?: [{ id, label, size: [x,y,z], offset?: [x,y,z] }], notes? }`. `anchor` defaults to `base-center`. `clearance` volumes (for example a door passage) are in the object's local frame: `offset` from its centre, rotated with it. `walkable: true` marks floors and decks so walk routes are not reported against them.
- `scenarios[].events[].targets`: `[{ object, interact?: boolean, clip?: string }]`. An object is `interactive` when a cue targets it with `interact: true` or a `clip`. `clip` names an animation clip the asset must contain.

**Derived by Rehearsal.** `dimensions` is `size * scale` in metres. Every traversal `route` cue adds a keep-clear corridor (1 m wide, 1.8 m tall, above a 0.3 m step height) per segment to each non-walkable piece within 1.5 m of it. `intersectsPlaceholder` and a top-level `warnings` entry say when the placeholder already overlaps the corridor. The overlap test is exact for Y-axis rotation and approximate for tilted pieces. Units are metres, Y-up, rotations are Three.js Euler XYZ in radians.

Shape (`version` 1; new fields are only ever added with a version bump):

```json
{
  "format": "scene-rehearsal-asset-spec",
  "version": 1,
  "units": {
    "length": "meter",
    "up": "Y",
    "rotation": "euler-xyz-radians"
  },
  "source": {
    "draftId": "06400e00d0af000d000000000000000000000000000000000000000000000000",
    "storyboardId": "yard",
    "sceneId": "gate",
    "title": "Gate yard",
    "draftRev": 2,
    "contentDigest": "ab78969bf378d38664204b59252e2f2eb220070dc4ac7846b613ebf4e546b610",
    "approved": true,
    "approvedAt": "2026-11-22T10:00:00.000Z",
    "reviewChecked": "Checked the gate."
  },
  "scaleReference": {
    "asset": "baseline-character",
    "height": 1.75
  },
  "pieces": [
    {
      "id": "gate",
      "name": "Gate",
      "kind": "box",
      "includes": [],
      "dimensions": [
        2,
        2,
        0.2
      ],
      "position": [
        0,
        1,
        -2
      ],
      "rotationEuler": [
        0,
        0,
        0
      ],
      "pivot": {
        "anchor": "base-center",
        "position": [
          0,
          0,
          -2
        ]
      },
      "interactive": true,
      "animationClips": [
        "open"
      ],
      "clearance": [
        {
          "id": "passage",
          "label": "Door passage",
          "kind": "authored",
          "center": [
            0,
            1,
            -1.5
          ],
          "size": [
            1.2,
            2.1,
            1
          ],
          "rotationEuler": [
            0,
            0,
            0
          ],
          "intersectsPlaceholder": false
        },
        {
          "id": "main/walk/1",
          "label": "Keep clear: Walk to gate walk route",
          "kind": "route",
          "center": [
            0,
            0.95,
            1.5
          ],
          "size": [
            6,
            1.8,
            1
          ],
          "rotationEuler": [
            0,
            1.570796,
            0
          ],
          "cue": {
            "scenario": "main",
            "event": "walk"
          },
          "intersectsPlaceholder": false
        }
      ],
      "cues": [
        {
          "scenario": "main",
          "event": "open",
          "tick": 40,
          "label": "Gate opens",
          "intent": "The gate swings open."
        }
      ],
      "placementNotes": [
        "Build to fit inside 2 x 2 x 0.2 m (width x height x depth in the piece frame) with the pivot at the bottom centre.",
        "Opens inward."
      ]
    }
  ],
  "warnings": [],
  "specDigest": "91d726b1fb60bb9b905148829cb4d6731e95af26998f92991fcc8b8db13c24e8"
}
```

Field notes: `includes` lists the piece IDs the placeholder represents. `position`/`rotationEuler` describe the placeholder centre. `pivot.position` is where the asset origin goes. `cues` lists the cues that target the piece. Clearance entries have `kind` `authored` or `route`, a world-space `center`, `size` and `rotationEuler`, and `cue` for routes. Mesh Foundry accepts the same document as an optional spec and reads these fields by name.

## Deprecated: Foundry import and model binding

Owner decision 2026-11-17: Rehearsal does not import or fit Foundry assets; Foundry builds to the spec above. The following remain only for stored v1/v2 drafts and legacy bindings, and are candidates for later removal: `import-model` CLI and `POST /api/agent/assets/import`, `POST /api/assets/import` and the inspector import form, `src/mesh.ts` live acceptance checks, `sourceKey` and v2 `asset.source`/`clips`/`node` bindings (v3 `objects[].asset` still validates), `src/glb-node.ts`/`model-instance.ts`. `GET /api/assets/:digest` and the viewer paths must stay to render stored revisions.

## Service status and single instance

`npm start -- --status` prints JSON with `root`, `origin`, `database`, `checkout` (path, git short SHA with `+uncommitted` when the tree is dirty, package version) and `running` (`url`, `pid`, `port`, `dataDir`, `revision`, `version`, `startedAt`, and `stale` when the running code differs from this checkout), or `running: null`. The same details come from `GET /api/status` and show in the app header. A second `npm start` for the same data directory starts nothing and exits with code 1. It prints (to stderr) where the instance runs (URL, pid, port, code revision, start time) and warns when the running code is older than this checkout. Different data directories (and ports) mean separate libraries, so the data directory is always shown.
