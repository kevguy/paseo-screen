import { useCallback, useEffect, useRef, useState } from "react";
import { Dimensions, Keyboard, NativeModules, Platform, TurboModuleRegistry, type View } from "react-native";

/**
 * The navigation (gesture) bar inset, read live from the safe-area native module the
 * host app ships. Plugin screens get no insets from the host, and on Android's edge-to-edge layout they
 * draw underneath those bars.
 */
function systemInsets(): { bottom: number } {
  try {
    const module = (TurboModuleRegistry.get?.("RNCSafeAreaContext") ?? NativeModules.RNCSafeAreaContext) as
      | { getConstants?(): unknown; initialWindowMetrics?: unknown }
      | null
      | undefined;
    const constants = (module?.getConstants?.() ?? module) as { initialWindowMetrics?: { insets?: { bottom?: unknown } } } | undefined;
    const bottom = constants?.initialWindowMetrics?.insets?.bottom;
    if (typeof bottom === "number" && bottom >= 0) return { bottom };
  } catch {
    // Fall through to the defaults below.
  }
  // Roughly a gesture bar; three-button navigation is taller.
  return { bottom: 24 };
}

/**
 * Padding that keeps the bottom of a full-height view clear of the on-screen keyboard and the system
 * bars on phones. It measures how far the view actually reaches under them, so a host app whose window
 * already shrinks for the keyboard (or that already leaves room for the bars) gets no extra padding.
 */
export function useBottomClearance() {
  const ref = useRef<View>(null);
  const [padding, setPadding] = useState(0);
  const keyboardHeight = useRef(0);

  const measure = useCallback(() => {
    if (Platform.OS === "web" || !ref.current) return;
    ref.current.measureInWindow((_x, y, _width, height) => {
      let next: number;
      if (Platform.OS === "android") {
        // On Android's edge-to-edge layout, measureInWindow and the screen share coordinates (the view
        // runs under the status bar), but the reported keyboard height leaves out the navigation bar
        // beneath it. Measured on a Pixel-class phone: y114 + h883 = screen 997, nav inset 24, keyboard
        // 368, keyboard top at 605 = 997 - 24 - 368.
        const insets = systemInsets();
        const screenHeight = Dimensions.get("screen").height;
        const visibleBottom = screenHeight - insets.bottom - keyboardHeight.current;
        next = Math.max(0, Math.round(y + height - visibleBottom));
      } else {
        // iOS: window coordinates throughout; the keyboard height includes the home indicator area.
        const windowHeight = Dimensions.get("window").height;
        next = Math.max(0, Math.round(y + height - (windowHeight - keyboardHeight.current)));
      }
      setPadding((current) => (Math.abs(current - next) > 1 ? next : current));
    });
  }, []);

  useEffect(() => {
    if (Platform.OS === "web") return;
    const show = Keyboard.addListener(Platform.OS === "ios" ? "keyboardWillShow" : "keyboardDidShow", (event) => {
      keyboardHeight.current = event.endCoordinates.height;
      measure();
    });
    const hide = Keyboard.addListener(Platform.OS === "ios" ? "keyboardWillHide" : "keyboardDidHide", () => {
      keyboardHeight.current = 0;
      measure();
    });
    const dimensions = Dimensions.addEventListener("change", measure);
    return () => {
      show.remove();
      hide.remove();
      dimensions.remove();
    };
  }, [measure]);

  return { ref, onLayout: measure, paddingBottom: padding };
}
