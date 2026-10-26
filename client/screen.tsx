import type { PluginTheme } from "@getpaseo/plugin";
import type { PluginScreenProps } from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Platform, Pressable, ScrollView, Text, TextInput, View, type LayoutChangeEvent } from "react-native";
import { chooseDisplayRpc, requestPermissionsRpc, statusRpc, type ScreenDisplay, type ScreenInputEvent, type ScreenModifier, type ScreenStatus } from "../shared/rpc";
import { readLocalClipboard, useHostClipboard } from "./clipboard";
import { useControlPause } from "./control";
import { FrameImage } from "./frame-image";
import { fitContent } from "./geometry";
import { isAppleClient, KEY, keyMapping } from "./keys";
import { TouchStage } from "./touch-stage";
import { QUALITIES, useFrames, useInputQueue } from "./use-screen";
import { useWebInput } from "./web-input";

const isWeb = Platform.OS === "web";

export function RemoteScreen({ theme, layout, host }: PluginScreenProps) {
  const styles = useMemo(() => createStyles(theme), [theme]);
  const fetchStatus = useRpc(statusRpc);
  const status = useQuery({ queryKey: ["paseo-screen", "status"], queryFn: () => fetchStatus({}), refetchInterval: 5000 });
  const requestPermissions = useRpc(requestPermissionsRpc);
  const request = useMutation({ mutationFn: () => requestPermissions({}), onSuccess: () => void status.refetch() });

  const [paused, setPaused] = useState(false);
  const [control, setControl] = useState(true);
  const [qualityIndex, setQualityIndex] = useState(1);
  const [chosenDisplay, setChosenDisplay] = useState<number | null>(null);
  const chooseDisplayOnHost = useRpc(chooseDisplayRpc);
  const [inputError, setInputError] = useState<string | null>(null);

  // A status reply with an error (a helper timeout or restart) says nothing reliable, and a sleeping
  // host lists no active displays. Keep the last reply that does, so neither turns capture off and on
  // (which would ask for a wake) nor moves the chosen display while the host is asleep.
  const lastGood = useRef<ScreenStatus | null>(null);
  if (status.data && !status.data.error) lastGood.current = status.data;
  const lastAwake = useRef<ScreenStatus | null>(null);
  if (status.data && !status.data.error && status.data.displays.length > 0) lastAwake.current = status.data;
  const displays = lastAwake.current?.displays ?? [];
  // This viewer's choice, else the display last chosen on this host, else the main display.
  const display =
    displays.find((candidate) => candidate.id === chosenDisplay) ??
    displays.find((candidate) => candidate.id === lastAwake.current?.preferredDisplay) ??
    displays.find((candidate) => candidate.main) ??
    displays[0];
  const displayId = display?.id;
  const chooseDisplay = useCallback(
    (id: number) => {
      setChosenDisplay(id);
      void chooseDisplayOnHost({ display: id }).catch(() => undefined);
    },
    [chooseDisplayOnHost],
  );
  const nextDisplay = () => {
    if (displays.length < 2) return;
    const index = displays.findIndex((candidate) => candidate.id === displayId);
    chooseDisplay(displays[(index + 1) % displays.length]!.id);
    // Choosing a display is an explicit action, so it may wake a sleeping host.
    frames.wake();
  };
  const canCapture = lastGood.current?.screenRecording === true;
  const hostPlatform = lastGood.current?.platform ?? "darwin";
  const linuxHost = hostPlatform === "linux";
  const windowsHost = hostPlatform === "win32";
  const mapping = useMemo(() => keyMapping(hostPlatform, isAppleClient()), [hostPlatform]);
  const [stage, setStage] = useState({ width: 0, height: 0 });
  const [rotated, setRotated] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [aspect, setAspect] = useState(16 / 10);
  // The touch viewer can turn the picture; the web viewer always shows it upright.
  const content = fitContent(stage, aspect, !isWeb && rotated);
  // Zoom in whole steps for resolution, so pinching does not restart the frame loop continuously.
  const frames = useFrames(canCapture && !paused, displayId, QUALITIES[qualityIndex]!, content.width * Math.ceil(zoom));
  const frameAspect = frames.display ? frames.display.width / frames.display.height : null;
  useEffect(() => {
    if (frameAspect) setAspect(frameAspect);
  }, [frameAspect]);
  // After a drag carries the pointer onto another display, show that display.
  const send = useInputQueue(displayId, setInputError, chooseDisplay);
  const hostControl = useControlPause(host.id);
  // A "paused" input error is stale once control resumes.
  useEffect(() => {
    if (!hostControl.paused) setInputError(null);
  }, [hostControl.paused]);
  const controlling = control && lastGood.current?.accessibility === true && !hostControl.paused;

  const clipboard = useHostClipboard(controlling);
  const pasteOnHost = useCallback(
    (text: string, shift = false) => {
      send(shift ? { type: "paste", text, shift } : { type: "paste", text });
      clipboard.notePasted(text);
    },
    [send, clipboard.notePasted],
  );
  const pasteLocalClipboard = useCallback(
    async (shift = false) => {
      const text = await readLocalClipboard();
      if (text) pasteOnHost(text, shift);
      else clipboard.setMessage("Could not read this device's clipboard");
    },
    [pasteOnHost, clipboard.setMessage],
  );

  const [viewNode, setViewNode] = useState<unknown>(null);
  useWebInput(viewNode, isWeb && controlling, send, mapping, {
    onHostCopy: clipboard.afterHostCopy,
    onPaste: pasteOnHost,
    onPasteFallback: (shift) => void pasteLocalClipboard(shift),
  });


  return (
    <View style={styles.screen}>
      <View style={styles.toolbar}>
        <Text style={styles.hostLabel} numberOfLines={1}>{host.label}</Text>
        <ToolButton styles={styles} label={paused ? "Resume" : "Pause"} onPress={() => setPaused(!paused)} />
        <ToolButton styles={styles} label={control ? "Control: on" : "View only"} active={control} onPress={() => setControl(!control)} />
        {/* Host-wide, unlike View only: stops input from every viewer until someone resumes it. */}
        {hostControl.known && !hostControl.paused ? (
          <ToolButton styles={styles} label="⏸ Pause control" onPress={() => hostControl.setPaused(true)} />
        ) : null}
        <ToolButton styles={styles} label={QUALITIES[qualityIndex]!.label} onPress={() => setQualityIndex((qualityIndex + 1) % QUALITIES.length)} />
        {!isWeb ? <ToolButton styles={styles} label="Rotate" active={rotated} onPress={() => setRotated(!rotated)} /> : null}
        {displays.length > 1 ? (
          <ToolButton
            styles={styles}
            label={`🖥 ${display ? displayLabel(display) : "Display"} (${displays.findIndex((candidate) => candidate.id === displayId) + 1}/${displays.length})`}
            onPress={nextDisplay}
          />
        ) : null}
        <Text style={styles.meta}>
          {frames.display ? `${frames.fps.toFixed(1)} fps · ${frames.latencyMs} ms · ${frames.kilobytes} KB` : ""}
          {clipboard.message ? ` · ${clipboard.message}` : ""}
        </Text>
      </View>

      <PermissionBanner styles={styles} linuxHost={linuxHost} status={status.data} loading={status.isLoading} requesting={request.isPending} onRequest={() => request.mutate()} />
      {frames.error || inputError ? <Text style={styles.error}>{frames.error ?? inputError}</Text> : null}
      {frames.asleep ? (
        <View style={styles.banner}>
          <Text style={styles.bannerText}>The host's display is asleep.</Text>
          <ToolButton styles={styles} label="Wake display" onPress={frames.wake} />
        </View>
      ) : null}
      {hostControl.paused ? (
        <View style={styles.banner}>
          <Text style={styles.bannerText}>Remote control is paused on this host. You can watch, but not click, type or use the clipboard.</Text>
          <ToolButton styles={styles} label={hostControl.changing ? "Resuming…" : "▶ Resume control"} onPress={() => hostControl.setPaused(false)} />
        </View>
      ) : null}
      {windowsHost ? (
        <Text style={styles.meta}>Windows hosts are experimental. Please report anything that misbehaves.</Text>
      ) : null}
      {frames.locked && !frames.asleep ? (
        <View style={styles.banner}>
          <Text style={styles.bannerText}>
            {windowsHost
              ? "This PC is locked or showing a secure prompt such as UAC. Windows doesn't let other apps see or control those screens, so someone has to unlock it at the PC."
              : `This ${linuxHost ? "computer" : "Mac"} is locked. ${
                  isWeb ? "Click the picture, type your password and press Return to unlock it." : "Type your password in the box below and press ⏎ to unlock it."
                }`}
          </Text>
        </View>
      ) : null}

      <View style={styles.stage} onLayout={(event: LayoutChangeEvent) => setStage(event.nativeEvent.layout)}>
        {frames.uri ? (
          isWeb ? (
            <View ref={setViewNode} accessibilityLabel="Remote screen" style={{ width: content.width, height: content.height }}>
              <FrameImage uri={frames.uri} width={content.width} height={content.height} />
            </View>
          ) : (
            <TouchStage
              uri={frames.uri}
              stage={stage}
              content={content}
              rotated={rotated}
              controlling={controlling}
              send={send}
              onZoomChange={setZoom}
            />
          )
        ) : (
          <Text style={styles.placeholder}>{canCapture ? (paused ? "Paused" : "Waiting for the first frame…") : "No screen yet"}</Text>
        )}
      </View>

      {controlling ? (
        <KeyBar
          styles={styles}
          compact={layout.compact}
          hostPlatform={hostPlatform}
          send={send}
          clipboard={clipboard.supported ? { copyFromHost: clipboard.pull, pasteToHost: () => void pasteLocalClipboard() } : null}
        />
      ) : null}
    </View>
  );
}

function PermissionBanner({ styles, linuxHost, status, loading, requesting, onRequest }: {
  styles: Styles;
  linuxHost: boolean;
  status: ScreenStatus | undefined;
  loading: boolean;
  requesting: boolean;
  onRequest(): void;
}) {
  if (loading || !status) return null;
  if (!status.supported || status.error) return <Text style={styles.error}>{status.error ?? "Unsupported host."}</Text>;
  const missing = [!status.screenRecording && "Screen Recording", !status.accessibility && "Accessibility"].filter(Boolean);
  if (missing.length === 0) return null;
  // Wayland: the desktop asks in its own dialog, and its switches decide what is allowed.
  if (linuxHost && status.backend === "wayland") {
    const waiting = status.awaitingApproval === true;
    const viewOnly = status.screenRecording && !status.accessibility;
    const text = waiting
      ? "Waiting for approval on the host. Someone there has to choose Share in the screen sharing dialog, with Allow Remote Interaction turned on (and Allow Clipboard Access for copy and paste)."
      : viewOnly
        ? "The host shares its screen but did not allow remote interaction, so it can be viewed but not controlled. Show the prompt again and turn on Allow Remote Interaction."
        : `${status.permissionError ? `${status.permissionError} ` : ""}This Wayland desktop has to approve screen sharing first. Show the prompt on the host; someone there chooses Share, with Allow Remote Interaction turned on (and Allow Clipboard Access for copy and paste). The choice is remembered until sharing is stopped on the host.`;
    return (
      <View style={styles.banner}>
        <Text style={styles.bannerText}>{text}</Text>
        <ToolButton styles={styles} label={waiting ? "Waiting for approval on host…" : requesting ? "Asking…" : "Show prompt on host"} onPress={onRequest} />
      </View>
    );
  }
  // X11 has no permissions to grant; input is only missing when the X server lacks the XTEST extension.
  if (linuxHost) return <Text style={styles.error}>This host's X server has no XTEST extension, so it can be viewed but not controlled.</Text>;
  return (
    <View style={styles.banner}>
      <Text style={styles.bannerText}>
        This Mac has not given Paseo {missing.join(" and ")} permission. Someone at the host Mac has to allow it once in System Settings, Privacy and Security, then restart Paseo there.
      </Text>
      <ToolButton styles={styles} label={requesting ? "Asking…" : "Show prompt on host"} onPress={onRequest} />
    </View>
  );
}

function KeyBar({ styles, compact, hostPlatform, send, clipboard }: {
  styles: Styles;
  compact: boolean;
  hostPlatform: string;
  send(event: ScreenInputEvent): void;
  clipboard: { copyFromHost(): void; pasteToHost(): void } | null;
}) {
  const [text, setText] = useState("");
  const key = (keyCode: number, modifiers: ScreenModifier[] = []) => () => send({ type: "key", keyCode, modifiers });
  const submit = (withEnter: boolean) => {
    // Text events carry at most 10,000 UTF-16 units each; split on code points so no emoji is cut in half.
    // A Linux host types characters missing from its layout at about 30 ms each, so it gets small
    // chunks: each request then finishes well inside the 15 s timeout and other input is not starved.
    const limit = hostPlatform === "linux" ? 200 : 10_000;
    let chunk = "";
    for (const codePoint of text) {
      if (chunk.length + codePoint.length > limit) {
        send({ type: "text", text: chunk });
        chunk = "";
      }
      chunk += codePoint;
    }
    if (chunk) send({ type: "text", text: chunk });
    if (withEnter) send({ type: "key", keyCode: KEY.enter });
    setText("");
  };
  return (
    <ScrollView horizontal style={styles.keyBarScroll} contentContainerStyle={styles.keyBar} keyboardShouldPersistTaps="handled">
      <TextInput
        style={styles.textInput}
        value={text}
        onChangeText={setText}
        placeholder="Type on the host…"
        placeholderTextColor={styles.meta.color}
        onSubmitEditing={() => submit(true)}
        autoCapitalize="none"
        autoCorrect={false}
      />
      <ToolButton styles={styles} label="Send" onPress={() => submit(false)} />
      <ToolButton styles={styles} label="Esc" onPress={key(KEY.escape)} />
      <ToolButton styles={styles} label="Tab" onPress={key(KEY.tab)} />
      <ToolButton styles={styles} label="⏎" onPress={key(KEY.enter)} />
      <ToolButton styles={styles} label="⌫" onPress={key(KEY.backspace)} />
      {hostPlatform === "win32" ? (
        // Windows' default shortcuts; on a Windows host `cmd` is the Windows key.
        <>
          <ToolButton styles={styles} label="Alt+Tab" onPress={key(KEY.tab, ["alt"])} />
          <ToolButton styles={styles} label="Task View" onPress={key(KEY.tab, ["cmd"])} />
          <ToolButton styles={styles} label="Start" onPress={key(KEY.command)} />
          <ToolButton styles={styles} label="Desktop" onPress={() => send({ type: "key", char: "d", modifiers: ["cmd"] })} />
          <ToolButton styles={styles} label="Ctrl+W" onPress={() => send({ type: "key", char: "w", modifiers: ["ctrl"] })} />
          <ToolButton styles={styles} label="Alt+F4" onPress={key(KEY.f4, ["alt"])} />
          <ToolButton styles={styles} label="◀ Desktop" onPress={key(KEY.left, ["ctrl", "cmd"])} />
          <ToolButton styles={styles} label="Desktop ▶" onPress={key(KEY.right, ["ctrl", "cmd"])} />
        </>
      ) : hostPlatform === "linux" ? (
        // GNOME's default shortcuts; on a Linux host `cmd` is the Super key.
        <>
          <ToolButton styles={styles} label="Super+Tab" onPress={key(KEY.tab, ["cmd"])} />
          <ToolButton styles={styles} label="Activities" onPress={key(KEY.command)} />
          <ToolButton styles={styles} label="Apps" onPress={() => send({ type: "key", char: "a", modifiers: ["cmd"] })} />
          <ToolButton styles={styles} label="Ctrl+W" onPress={() => send({ type: "key", char: "w", modifiers: ["ctrl"] })} />
          <ToolButton styles={styles} label="Alt+F4" onPress={key(KEY.f4, ["alt"])} />
          <ToolButton styles={styles} label="◀ Workspace" onPress={key(KEY.left, ["ctrl", "alt"])} />
          <ToolButton styles={styles} label="Workspace ▶" onPress={key(KEY.right, ["ctrl", "alt"])} />
        </>
      ) : (
        <>
          <ToolButton styles={styles} label="⌘Tab" onPress={key(KEY.tab, ["cmd"])} />
          <ToolButton styles={styles} label="⌘Space" onPress={key(KEY.space, ["cmd"])} />
          <ToolButton styles={styles} label="⌘W" onPress={() => send({ type: "key", char: "w", modifiers: ["cmd"] })} />
          <ToolButton styles={styles} label="⌘Q" onPress={() => send({ type: "key", char: "q", modifiers: ["cmd"] })} />
          <ToolButton styles={styles} label="◀ Space" onPress={key(KEY.left, ["ctrl"])} />
          <ToolButton styles={styles} label="Space ▶" onPress={key(KEY.right, ["ctrl"])} />
          <ToolButton styles={styles} label="Mission Control" onPress={key(KEY.up, ["ctrl"])} />
          <ToolButton styles={styles} label="App windows" onPress={key(KEY.down, ["ctrl"])} />
        </>
      )}
      {clipboard ? (
        <>
          <ToolButton styles={styles} label="Copy from host" onPress={clipboard.copyFromHost} />
          <ToolButton styles={styles} label="Paste to host" onPress={clipboard.pasteToHost} />
        </>
      ) : null}
      {compact ? (
        <>
          <ToolButton styles={styles} label="←" onPress={key(KEY.left)} />
          <ToolButton styles={styles} label="↑" onPress={key(KEY.up)} />
          <ToolButton styles={styles} label="↓" onPress={key(KEY.down)} />
          <ToolButton styles={styles} label="→" onPress={key(KEY.right)} />
          <ToolButton styles={styles} label="Scroll ↑" onPress={() => send({ type: "scroll", dx: 0, dy: -300 })} />
          <ToolButton styles={styles} label="Scroll ↓" onPress={() => send({ type: "scroll", dx: 0, dy: 300 })} />
        </>
      ) : null}
    </ScrollView>
  );
}

function ToolButton({ styles, label, active, onPress }: { styles: Styles; label: string; active?: boolean; onPress(): void }) {
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={label} style={[styles.button, active ? styles.buttonActive : null]} onPress={onPress}>
      <Text style={[styles.buttonText, active ? styles.buttonTextActive : null]}>{label}</Text>
    </Pressable>
  );
}

function displayLabel(display: ScreenDisplay): string {
  const name = display.builtin ? "Built-in" : display.name;
  return display.main ? `${name}, main` : name;
}

type Styles = ReturnType<typeof createStyles>;

function createStyles(theme: PluginTheme) {
  const { colors } = theme;
  return {
    screen: { flex: 1, backgroundColor: colors.surface0 },
    toolbar: { flexDirection: "row" as const, flexWrap: "wrap" as const, alignItems: "center" as const, gap: 6, padding: 8, borderBottomWidth: 1, borderColor: colors.border },
    hostLabel: { color: colors.foreground, fontSize: 13, fontWeight: "600" as const, marginRight: 4, maxWidth: 220 },
    meta: { color: colors.foregroundMuted, fontSize: 12, marginLeft: 4 },
    button: { paddingHorizontal: 10, paddingVertical: 6, borderRadius: 6, backgroundColor: colors.surface2 },
    buttonActive: { backgroundColor: colors.accent },
    buttonText: { color: colors.foreground, fontSize: 13 },
    buttonTextActive: { color: colors.accentForeground },
    banner: { flexDirection: "row" as const, flexWrap: "wrap" as const, alignItems: "center" as const, gap: 8, padding: 10, backgroundColor: colors.surface1, borderBottomWidth: 1, borderColor: colors.statusWarning },
    bannerText: { flex: 1, minWidth: 240, color: colors.foreground, fontSize: 13 },
    error: { color: colors.statusDanger, fontSize: 12, paddingHorizontal: 10, paddingVertical: 4 },
    stage: { flex: 1, alignItems: "center" as const, justifyContent: "center" as const, backgroundColor: "#000" },
    placeholder: { color: colors.foregroundMuted },
    keyBarScroll: { flexGrow: 0, borderTopWidth: 1, borderColor: colors.border },
    keyBar: { flexDirection: "row" as const, alignItems: "center" as const, gap: 6, padding: 8 },
    textInput: { minWidth: 180, paddingHorizontal: 10, paddingVertical: 6, borderRadius: 6, borderWidth: 1, borderColor: colors.border, color: colors.foreground, backgroundColor: colors.surface1 },
  };
}
