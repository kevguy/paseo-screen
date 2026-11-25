import { useRpc } from "@getpaseo/plugin/client";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { AppState, PixelRatio } from "react-native";
import { frameRpc, inputRpc, type ScreenDisplay } from "../shared/rpc";
import { createInputQueue } from "./input-queue";

export interface Quality {
  label: string;
  maxWidth: number;
  quality: number;
  /** Delay target between frame requests. The loop also waits for each reply, so slow links self-throttle. */
  intervalMs: number;
}

export const QUALITIES: Quality[] = [
  { label: "Fast", maxWidth: 1280, quality: 0.45, intervalMs: 120 },
  { label: "Balanced", maxWidth: 1728, quality: 0.6, intervalMs: 200 },
  { label: "Sharp", maxWidth: 2560, quality: 0.8, intervalMs: 400 },
];

export interface FrameState {
  uri: string | null;
  display: ScreenDisplay | null;
  error: string | null;
  /** Frame replies per second, changed or not. */
  fps: number;
  /** Median request-to-reply time of recent frames. */
  latencyMs: number;
  kilobytes: number;
  /** The host is showing its lock screen. */
  locked: boolean;
  /** The host's displays are asleep; call wake() to wake them. */
  asleep: boolean;
  wake(): void;
}

/** Frame requests kept in flight, so a slow round trip does not leave the link idle. */
const PIPELINE = 2;

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[sorted.length >> 1]!;
}

/**
 * Polls the host for JPEG frames while `active`. Unchanged frames come back without image data.
 * Frames are sized to the viewer (`viewWidth` in points), so small screens download far less.
 */
export function useFrames(requested: boolean, displayId: number | undefined, quality: Quality, viewWidth: number): FrameState {
  // Stop capturing while the app is in the background (a hidden tab or a backgrounded phone app).
  const [appState, setAppState] = useState(AppState.currentState);
  useEffect(() => AppState.addEventListener("change", setAppState).remove, []);
  const active = requested && appState !== "background";
  const frame = useRpc(frameRpc);
  const frameRef = useRef(frame);
  frameRef.current = frame;
  const [state, setState] = useState<Omit<FrameState, "wake">>({
    uri: null, display: null, error: null, fps: 0, latencyMs: 0, kilobytes: 0, locked: false, asleep: false,
  });
  // Set when the viewer opens or the user asks; the next frame request wakes a sleeping host.
  // Ordinary polling never wakes it, so an open viewer does not stop the host from sleeping or locking.
  const wakeNext = useRef(true);
  const wake = useCallback(() => {
    wakeNext.current = true;
  }, []);
  // Only opening or resuming the viewer asks for a wake. Restarts of the frame loop for other
  // reasons (display list, size, quality) must not, or a sleeping host would be woken repeatedly.
  useEffect(() => {
    if (active) wakeNext.current = true;
  }, [active]);

  // Rounded to 160 px steps so resizing the viewer does not restart the loop on every pixel.
  const wanted = viewWidth > 0 ? Math.ceil((viewWidth * Math.min(PixelRatio.get(), 2)) / 160) * 160 : quality.maxWidth;
  const maxWidth = Math.max(320, Math.min(quality.maxWidth, wanted));

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    let since: string | undefined;
    let nextSequence = 0;
    let appliedSequence = -1;
    const timers = new Set<ReturnType<typeof setTimeout>>();
    const replies: number[] = [];
    const latencies: number[] = [];

    const schedule = (delay: number) => {
      const timer = setTimeout(() => {
        timers.delete(timer);
        void tick();
      }, delay);
      timers.add(timer);
    };

    const tick = async () => {
      const sequence = nextSequence++;
      const startedAt = Date.now();
      let delay = quality.intervalMs;
      try {
        const wakeHost = wakeNext.current;
        wakeNext.current = false;
        const result = await frameRef.current({ display: displayId, maxWidth, quality: quality.quality, since, wake: wakeHost });
        if (cancelled) return;
        const now = Date.now();
        replies.push(now);
        while (replies.length > 0 && replies[0]! < now - 3000) replies.shift();
        latencies.push(now - startedAt);
        if (latencies.length > 10) latencies.shift();
        // Replies can arrive out of order; never replace a newer frame with an older one.
        if (sequence > appliedSequence) {
          appliedSequence = sequence;
          // "Unchanged" only means equal to the hash this request was sent with. Another reply may have
          // changed the picture since, so only a reply carrying image data moves `since`; a stale
          // "unchanged" leaves it alone and the next request fetches the real frame.
          if (result.jpeg) since = result.hash;
          setState((previous) => ({
            uri: result.jpeg ? `data:image/jpeg;base64,${result.jpeg}` : previous.uri,
            display: result.display ?? previous.display,
            asleep: result.asleep === true,
            error: null,
            fps: replies.length / 3,
            latencyMs: median(latencies),
            kilobytes: result.jpeg && result.bytes ? Math.round(result.bytes / 1024) : previous.kilobytes,
            locked: result.locked,
          }));
        }
        delay = Math.max(0, quality.intervalMs - (now - startedAt));
      } catch (error) {
        if (cancelled) return;
        setState((previous) => ({ ...previous, error: error instanceof Error ? error.message : String(error), fps: 0 }));
        delay = 2000;
      }
      if (!cancelled) schedule(delay);
    };

    for (let lane = 0; lane < PIPELINE; lane++) schedule((lane * quality.intervalMs) / PIPELINE);
    return () => {
      cancelled = true;
      for (const timer of timers) clearTimeout(timer);
    };
  }, [active, displayId, quality, maxWidth]);

  return { ...state, wake };
}

/** This viewer's input to `hostId`, in order. See createInputQueue for what happens when the viewer closes. */
export function useInputQueue(
  hostId: string,
  displayId: number | undefined,
  onError: (message: string | null) => void,
  /** Called when a drag ends on a different display than the one being viewed. */
  onPointerDisplay: (display: number) => void,
) {
  const input = useRpc(inputRpc);
  const [queue] = useState(() => createInputQueue(hostId));
  queue.update({ call: input, display: displayId, onError, onPointerDisplay });
  // A layout effect, so the queue is closed before anything else can run once the viewer is gone.
  // Other cleanups run after it; the releases they send still go out.
  useLayoutEffect(() => {
    queue.open();
    return () => queue.close();
  }, [queue]);
  return queue.send;
}
