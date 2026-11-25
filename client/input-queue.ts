import type { ScreenInputEvent } from "../shared/rpc";

export interface InputTarget {
  call(request: { display?: number; events: ScreenInputEvent[] }): Promise<{ pointerDisplay?: number }>;
  display: number | undefined;
  onError(message: string | null): void;
  /** Called when a drag ends on a different display than the one being viewed. */
  onPointerDisplay(display: number): void;
}

/** How long a reopened viewer waits for the last releases of the closed one before it sends anyway. */
const DRAIN_LIMIT_MS = 5000;
/** Closed queues that still have a request in flight or releases to send, by host. */
const draining = new Map<string, Promise<void>>();

/** The button or key an event presses or releases; null for everything else, such as a whole tap or click. */
function holdKey(event: ScreenInputEvent): string | null {
  if (event.type === "down" || event.type === "up") return `button:${event.button}`;
  if (event.type === "key" && event.down !== undefined) return `key:${event.keyCode ?? event.char}`;
  return null;
}
const isPress = (event: ScreenInputEvent) => event.type === "down" || (event.type === "key" && event.down === true);

/**
 * Queues one viewer's input for one host and sends it in order, one request at a time.
 * Consecutive moves collapse to the latest and consecutive scrolls add up, so a slow link never builds a backlog.
 *
 * Closing it (the viewer left or switched host) drops what has not been sent. Only releases of presses
 * the host was sent still go out, so nothing typed here arrives late and nothing stays held there.
 */
export function createInputQueue(hostId: string) {
  let target: InputTarget | null = null;
  let queue: ScreenInputEvent[] = [];
  let sending: Promise<void> | null = null;
  let closed = false;
  /** Presses sent to the host whose release has not been sent. */
  const held = new Set<string>();
  /** Once closed: held presses whose release is not queued yet. */
  let owed = new Set<string>();

  /** True for the one release a closed queue still owes the host for a press it was sent. */
  const takeOwed = (event: ScreenInputEvent) => {
    const key = holdKey(event);
    return key !== null && !isPress(event) && owed.delete(key);
  };

  async function run(): Promise<void> {
    // A viewer of the same host that just closed may still be sending releases; a press must not overtake them.
    const previous = draining.get(hostId);
    if (previous) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([previous, new Promise<void>((resolve) => (timer = setTimeout(resolve, DRAIN_LIMIT_MS)))]);
      clearTimeout(timer);
      // Done, or stuck: either way nothing waits for it again.
      if (draining.get(hostId) === previous) draining.delete(hostId);
    }
    while (target && queue.length > 0) {
      // The RPC accepts at most 200 events per call. A batch also ends after a text event, so each
      // text chunk gets its own request and timeout (a Linux host may type it slowly).
      const firstText = queue.findIndex((event) => event.type === "text");
      const events = queue.splice(0, firstText >= 0 ? Math.min(firstText + 1, 200) : 200);
      for (const event of events) {
        const key = holdKey(event);
        if (key) isPress(event) ? held.add(key) : held.delete(key);
      }
      const { call, display } = target;
      try {
        const result = await call({ display, events });
        if (closed) continue;
        // A batch that went through means any earlier error (such as "paused") no longer applies.
        target.onError(null);
        const endedDrag = events.some((event) => event.type === "up");
        if (endedDrag && result.pointerDisplay !== undefined && result.pointerDisplay !== display) {
          target.onPointerDisplay(result.pointerDisplay);
        }
      } catch (error) {
        if (!closed) target.onError(error instanceof Error ? error.message : String(error));
      }
    }
  }

  function flush(): void {
    if (sending || queue.length === 0) return;
    const current = run().finally(() => {
      sending = null;
      if (draining.get(hostId) === current) draining.delete(hostId);
      flush();
    });
    sending = current;
    if (closed) draining.set(hostId, current);
  }

  return {
    update(next: InputTarget): void {
      target = next;
    },
    send(event: ScreenInputEvent): void {
      const last = queue[queue.length - 1];
      if (closed) {
        if (!takeOwed(event)) return;
        queue.push(event);
      } else if (event.type === "move" && last?.type === "move") {
        queue[queue.length - 1] = event;
      } else if (event.type === "scroll" && last?.type === "scroll") {
        const clamp = (value: number) => Math.max(-10_000, Math.min(10_000, value));
        queue[queue.length - 1] = { ...event, dx: clamp(last.dx + event.dx), dy: clamp(last.dy + event.dy) };
      } else {
        queue.push(event);
      }
      flush();
    },
    open(): void {
      closed = false;
    },
    close(): void {
      if (closed) return;
      closed = true;
      owed = new Set(held);
      queue = queue.filter(takeOwed);
      if (sending) draining.set(hostId, sending);
    },
  };
}
