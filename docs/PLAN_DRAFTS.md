# Plan-linked placeholder drafts

Loom owns orchestration plan approval and checks that the plan and approval are current before invoking the author CLI. Rehearsal stores the supplied identity in the immutable draft. Its author credential authorizes publication in the selected library. Loom verifies the approval through its own records.

## Publish and read back

Use the intended absolute canonical library directory and loopback port for both service and CLI. Run `npm start -- --status` to confirm the effective data directory before writing. Then use:

```sh
npm --silent run cli -- list
npm --silent run cli -- publish /absolute/draft-request.json
npm --silent run cli -- read REVISION_SHA256
```

The request shape is `{ request, parent, scene, links? }`. See [Lighthouse landing](../fixtures/lighthouse-arrival.json) for a fictional example. For v3, use the full `scene.plan` tuple from Loom (`storyboardId`, `sceneId`, `planId`, `planRevision`, `approvalId`). Each tuple has its own head in `list.planHeads`. Use `parent: null` for an absent tuple. For a revision of an existing draft under the same approved plan, use its current tuple head and optionally link feedback from that draft's ancestry. The separate top-level `head` still serves v1/v2. A clean v3 draft can therefore start in an existing library without extending or replacing the legacy head. A newly approved plan tuple starts a separate history.

Publication returns `{ revision }` with the immutable SHA-256. Retrying identical input with the same request ID returns the original revision, including after newer revisions are published. Read the revision back to confirm the plan tuple, digest, parent and scenario IDs. Use the canonical scenario URL `http://127.0.0.1:PORT/revision/DIGEST/SCENARIO_ID`. Loom should record the canonical `dataDir`, `port`, digest as `revisionId`, URL as `link`, plan tuple and exact parent against the storyboard and scene. Record publication before any draft review. On a writeback conflict, reconcile the exact published digest and plan identity before retrying Loom's write.

## Author and inspect

Coordinates and proxy dimensions use meters in a Y-up frame. Each box or marker has a stable ID, center position, base size, positive scale factors and XYZ Euler rotation in radians. A group proxy lists the stable IDs of the pieces represented by its placement. A box uses its given dimensions, and an octahedral marker uses those dimensions as its extents. Optional static GLBs use the existing import flow and are placed at the same authored transform. Use a source key to pin an exact imported source. Clip playback remains available for legacy mappings.

Scenarios advance at 10 ticks per second. As playback reaches a traversal cue, its authored polyline appears. Select a camera cue to inspect its supplied position and target. The event list carries intended behaviors and timing, and the pending checks carry work for the game implementation. Traversal previews show a path, with player control, collision, navigation, animation and game timing left to implementation checks.

Reviewers open the published digest, use placement and playback controls, and pin feedback for needed changes. To approve, record what was checked and choose **Approve this draft**. The review action uses the local reviewer session, with `POST /api/revision/DIGEST/approve` and body `{ "kind": "final", "review": { "checked": "…" } }`. `read DIGEST` returns the review text as `draftReview.checked` and the approval timestamp in `approvals`. Loom should read this exact evidence back and check that the digest and plan still match the recorded active draft before advancing to implementation. A child revision starts with its own review state.

The approved handoff is a `scene-rehearsal-3` package containing the exact plan, proxy transforms, piece IDs, cues, pending checks and review evidence. A placeholder-only export has empty `assets` and `blobs`. Use `cli verify PACKAGE OWNER_CONFIRMED_SHA256` for package integrity. The game implementer should carry the approved placements and intent forward and run the pending implementation checks in the game.

## Loom integration

Loom needs a plan-gated publication record, a subsequent exact-draft review record, and a history-preserving reset that deactivates legacy fit actions for the affected scene. The installed legacy `rehearsal.record` contract requires a review first and creates a snapshot on writes. It cannot carry this sequence as-is. Reconcile any reset against the exact recorded storyboard, scene, library and digest. A reset in Loom can preserve the library and historical URL while leaving the v3 plan scope empty until owner approval.
