// Checks the paused-input tracking in server/held.ts. Run by `npm test` (Node 22.18+ runs .ts directly).
import assert from "node:assert/strict";
const { createHeldTracker } = await import(new URL("../server/held.ts", import.meta.url));
const left = (type) => ({ type, button: "left", x: 0.5, y: 0.5 });
const keyL = (down) => ({ type: "key", keyCode: 37, down });

function sent(batch) {
  const tracker = createHeldTracker();
  tracker.beforeSend(batch);
  tracker.confirmed(batch);
  return tracker;
}
// Order inside a batch matters: these end with the button or key still down on the host.
assert.deepEqual(sent([left("down"), left("up"), left("down")]).held(), ["button:left"]);
assert.deepEqual(sent([keyL(false), keyL(true)]).held(), ["key:37"]);
// A complete click or tap leaves nothing held; taps without `down` are never tracked.
assert.deepEqual(sent([left("down"), left("up")]).held(), []);
assert.deepEqual(sent([{ type: "key", keyCode: 37 }, { type: "click", button: "left", x: 0, y: 0 }]).held(), []);

// A press whose request failed still counts, so its release is allowed while paused.
const failed = createHeldTracker();
failed.beforeSend([left("down")]);
assert.equal(failed.heldReleases([left("up"), { type: "move", x: 0, y: 0 }]).length, 1);
// A release with no matching press is not allowed while paused.
assert.equal(createHeldTracker().heldReleases([left("up"), keyL(false)]).length, 0);
console.log("held checks passed");
