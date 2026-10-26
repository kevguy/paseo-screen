import type { ScreenInputEvent } from "../shared/rpc";

/**
 * Mouse buttons and keys the host has been told are down. While control is paused, only their
 * releases go through, so a pause mid-drag or mid-keypress cannot leave them held, and releases of
 * presses the host never saw (which would still move its pointer) are dropped.
 */
export function createHeldTracker() {
  const held = new Set<string>();
  const holdKey = (event: ScreenInputEvent): string | null =>
    event.type === "down" || event.type === "up"
      ? `button:${event.button}`
      : event.type === "key" && event.down !== undefined
        ? `key:${event.keyCode ?? event.char}`
        : null;
  const isPress = (event: ScreenInputEvent) => event.type === "down" || (event.type === "key" && event.down === true);
  return {
    /** Presses count as held before they are sent, since a timed-out request may still reach the host. */
    beforeSend(events: ScreenInputEvent[]): void {
      for (const event of events) {
        const key = holdKey(event);
        if (key && isPress(event)) held.add(key);
      }
    },
    /** Once the host confirms a batch, replay it in order: [up, down] or [key-up L, key-down L] must end held. */
    confirmed(events: ScreenInputEvent[]): void {
      for (const event of events) {
        const key = holdKey(event);
        if (!key) continue;
        if (isPress(event)) held.add(key);
        else held.delete(key);
      }
    },
    /** The releases in `events` whose press the host has seen; the only input allowed while paused. */
    heldReleases(events: ScreenInputEvent[]): ScreenInputEvent[] {
      return events.filter((event) => {
        const key = holdKey(event);
        return key !== null && !isPress(event) && held.has(key);
      });
    },
    held(): string[] {
      return [...held];
    },
  };
}
