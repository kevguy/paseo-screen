import { useEffect, useMemo, useRef, useState } from "react";
import { PanResponder, View, type GestureResponderEvent } from "react-native";
import type { ScreenInputEvent } from "../shared/rpc";
import { FrameImage } from "./frame-image";
import { clampPan, MAX_ZOOM, toContentDelta, toScreenPoint, type Size, type View2D } from "./geometry";

const LONG_PRESS_MS = 500;
const DOUBLE_TAP_MS = 350;
const TAP_SLOP = 10;

interface Touch {
  x: number;
  y: number;
}

type Gesture =
  | { mode: "idle" }
  | { mode: "tap"; start: Touch; startView: View2D; longPress: ReturnType<typeof setTimeout> }
  | { mode: "pan"; start: Touch; startView: View2D }
  | { mode: "pinch"; startDistance: number; startMid: Touch; startView: View2D }
  | { mode: "done" };

function touchesOf(event: GestureResponderEvent): Touch[] {
  return event.nativeEvent.touches.map((touch) => ({ x: touch.locationX, y: touch.locationY }));
}

/**
 * Phone and tablet viewer: the picture can be turned 90° and pinch-zoomed.
 * Tap clicks, double-tap double-clicks, long-press right-clicks, one finger pans, two fingers zoom.
 */
export function TouchStage({ uri, stage, content, rotated, controlling, send, onZoomChange }: {
  uri: string;
  stage: Size;
  content: Size;
  rotated: boolean;
  controlling: boolean;
  send(event: ScreenInputEvent): void;
  /** Reports the zoom so frames can be requested at a matching resolution. */
  onZoomChange(zoom: number): void;
}) {
  const [view, setView] = useState<View2D>({ content, rotated, zoom: 1, panX: 0, panY: 0 });
  // Rotating or resizing starts again from the whole screen.
  useEffect(() => {
    setView({ content, rotated, zoom: 1, panX: 0, panY: 0 });
  }, [content.width, content.height, rotated]);
  useEffect(() => onZoomChange(view.zoom), [view.zoom, onZoomChange]);

  const latest = useRef({ view, stage, controlling, send });
  latest.current = { view, stage, controlling, send };
  const gesture = useRef<Gesture>({ mode: "idle" });
  const lastTap = useRef<{ at: number; x: number; y: number; point: { x: number; y: number } } | null>(null);

  // A long press must not click after the viewer closed or switched host.
  useEffect(
    () => () => {
      if (gesture.current.mode === "tap") clearTimeout(gesture.current.longPress);
      gesture.current = { mode: "done" };
    },
    [],
  );

  const responder = useMemo(() => {
    const endTap = () => {
      if (gesture.current.mode === "tap") clearTimeout(gesture.current.longPress);
    };
    const click = (touch: Touch, button: "left" | "right") => {
      const { view, stage, controlling, send } = latest.current;
      if (!controlling) return;
      const point = toScreenPoint(touch.x, touch.y, stage, view);
      if (!point) return;
      if (button === "right") {
        send({ type: "click", ...point, button });
        return;
      }
      const now = Date.now();
      const previous = lastTap.current;
      if (previous && now - previous.at < DOUBLE_TAP_MS && Math.hypot(touch.x - previous.x, touch.y - previous.y) < 24) {
        // The first tap already clicked once; this press is the second click of a double-click. It lands
        // where the first did: Windows and X11 only count a double-click within a few pixels.
        send({ type: "down", ...previous.point, button, clickCount: 2 });
        send({ type: "up", ...previous.point, button, clickCount: 2 });
        lastTap.current = null;
      } else {
        send({ type: "click", ...point, button });
        lastTap.current = { at: now, x: touch.x, y: touch.y, point };
      }
    };
    const startPinch = (touches: Touch[]) => {
      endTap();
      const [a, b] = touches as [Touch, Touch];
      gesture.current = {
        mode: "pinch",
        startDistance: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)),
        startMid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
        startView: latest.current.view,
      };
    };

    return PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderTerminationRequest: () => false,
      onPanResponderGrant: (event) => {
        const touches = touchesOf(event);
        if (touches.length >= 2) return startPinch(touches);
        const start = touches[0] ?? { x: event.nativeEvent.locationX, y: event.nativeEvent.locationY };
        const longPress = setTimeout(() => {
          if (gesture.current.mode !== "tap") return;
          click(start, "right");
          gesture.current = { mode: "done" };
        }, LONG_PRESS_MS);
        gesture.current = { mode: "tap", start, startView: latest.current.view, longPress };
      },
      onPanResponderMove: (event) => {
        const touches = touchesOf(event);
        const current = gesture.current;
        const { stage } = latest.current;
        if (touches.length >= 2) {
          if (current.mode !== "pinch") return startPinch(touches);
          const [a, b] = touches as [Touch, Touch];
          const { startView, startDistance, startMid } = current;
          const zoom = Math.min(MAX_ZOOM, Math.max(1, (startView.zoom * Math.hypot(a.x - b.x, a.y - b.y)) / startDistance));
          // Keep the picture point that was under the fingers' midpoint under it.
          const center = { x: stage.width / 2, y: stage.height / 2 };
          const before = toContentDelta(startMid.x - center.x, startMid.y - center.y, startView.rotated);
          const anchorX = before.dx / startView.zoom - startView.panX;
          const anchorY = before.dy / startView.zoom - startView.panY;
          const now = toContentDelta((a.x + b.x) / 2 - center.x, (a.y + b.y) / 2 - center.y, startView.rotated);
          setView(clampPan({ ...startView, zoom, panX: now.dx / zoom - anchorX, panY: now.dy / zoom - anchorY }, stage));
          return;
        }
        const touch = touches[0];
        if (!touch) return;
        if (current.mode === "tap" && Math.hypot(touch.x - current.start.x, touch.y - current.start.y) > TAP_SLOP) {
          endTap();
          gesture.current = { mode: "pan", start: current.start, startView: current.startView };
        }
        const panning = gesture.current;
        if (panning.mode !== "pan") return;
        const delta = toContentDelta(touch.x - panning.start.x, touch.y - panning.start.y, panning.startView.rotated);
        const { startView } = panning;
        setView(clampPan({ ...startView, panX: startView.panX + delta.dx / startView.zoom, panY: startView.panY + delta.dy / startView.zoom }, stage));
      },
      onPanResponderRelease: () => {
        const current = gesture.current;
        if (current.mode === "tap") {
          clearTimeout(current.longPress);
          click(current.start, "left");
        }
        gesture.current = { mode: "idle" };
      },
      onPanResponderTerminate: () => {
        endTap();
        gesture.current = { mode: "idle" };
      },
    });
  }, []);

  return (
    <View style={{ width: stage.width, height: stage.height, overflow: "hidden" }}>
      <View
        pointerEvents="none"
        style={{
          position: "absolute",
          left: (stage.width - view.content.width) / 2,
          top: (stage.height - view.content.height) / 2,
          width: view.content.width,
          height: view.content.height,
          transform: [
            { rotate: view.rotated ? "90deg" : "0deg" },
            { scale: view.zoom },
            { translateX: view.panX },
            { translateY: view.panY },
          ],
        }}
      >
        <FrameImage uri={uri} width={view.content.width} height={view.content.height} />
      </View>
      {/* collapsable={false}: Android would otherwise flatten this empty view and it would never receive touches. */}
      <View collapsable={false} accessibilityLabel="Remote screen" style={{ position: "absolute", left: 0, top: 0, right: 0, bottom: 0 }} {...responder.panHandlers} />
    </View>
  );
}
