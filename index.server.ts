import type { PluginServerContext } from "@getpaseo/plugin/server";
import { HelperProcess, linuxBackend, NO_SESSION } from "./server/helper";
import { readControlPaused, readPreferredDisplay, writeControlPaused, writePreferredDisplay } from "./server/preferences";
import { chooseDisplayRpc, clipboardRpc, controlStateRpc, setControlPausedRpc, frameRpc, inputRpc, requestPermissionsRpc, statusRpc, type ScreenStatus } from "./shared/rpc";

export default function contribute(server: PluginServerContext) {
  const log = (message: string) => console.error(`[paseo-screen] ${message}`);
  // Separate processes so clicks and keys never queue behind a frame capture. On Wayland each
  // process would need its own portal session and approval, so one helper serves both and answers
  // frames on a thread of their own.
  const capture = new HelperProcess(log);
  const input = new HelperProcess(log);
  const inputHelper = async () => (process.platform === "linux" && (await linuxBackend()) === "wayland" ? capture : input);

  async function readStatus(command: "status" | "request"): Promise<ScreenStatus> {
    const failed = { platform: process.platform, screenRecording: false, accessibility: false, locked: false, displays: [], preferredDisplay: null };
    const unsupported = await unsupportedReason();
    if (unsupported) return { ...failed, supported: false, error: unsupported };
    try {
      const status = await capture.request<
        Pick<ScreenStatus, "screenRecording" | "accessibility" | "locked" | "displays" | "backend" | "awaitingApproval" | "permissionError"> & {
          activeDisplay?: number;
        }
      >(command);
      let preferred = await readPreferredDisplay();
      const connected = (id: number | null) => status.displays.some((display) => display.id === id);
      // With no choice saved yet, start where the focused window is (Linux helpers report it), and save
      // that, so the viewer does not follow focus around afterwards.
      if (preferred === null && status.activeDisplay !== undefined && connected(status.activeDisplay)) {
        preferred = status.activeDisplay;
        await writePreferredDisplay(preferred).catch(() => undefined);
      }
      return {
        supported: true,
        error: null,
        platform: process.platform,
        screenRecording: status.screenRecording,
        accessibility: status.accessibility,
        locked: status.locked,
        displays: status.displays,
        preferredDisplay: connected(preferred) ? preferred : null,
        // Wayland hosts: approval happens in the desktop's own dialog, which may still be open.
        ...(status.backend ? { backend: status.backend } : {}),
        ...(status.awaitingApproval !== undefined ? { awaitingApproval: status.awaitingApproval } : {}),
        ...(status.permissionError ? { permissionError: status.permissionError } : {}),
      };
    } catch (error) {
      return { ...failed, supported: true, error: error instanceof Error ? error.message : String(error) };
    }
  }

  server.handle(statusRpc, () => readStatus("status"));
  server.handle(requestPermissionsRpc, () => readStatus("request"));
  server.handle(frameRpc, (request) => capture.request("frame", request));
  /** Refuses remote input and clipboard access while control is paused on the host. */
  async function assertControlAllowed(): Promise<void> {
    if (await readControlPaused()) throw new Error("Remote control is paused on this host. Resume it from the Screen controls.");
  }
  server.handle(inputRpc, async (request) => {
    if (await readControlPaused()) {
      // Releases still go through, so a pause that lands mid-drag or mid-keypress cannot leave the
      // host's mouse button or a key held down.
      const releases = request.events.filter((event) => event.type === "up" || (event.type === "key" && event.down === false));
      if (releases.length > 0) await (await inputHelper()).request("input", { ...request, events: releases });
      if (releases.length === request.events.length) return { handled: releases.length };
      throw new Error("Remote control is paused on this host. Resume it from the Screen controls.");
    }
    return (await inputHelper()).request("input", request);
  });
  // Read on the input helper so it runs after any copy shortcut queued before it.
  server.handle(clipboardRpc, async () => {
    await assertControlAllowed();
    return (await inputHelper()).request("clipboard");
  });
  server.handle(controlStateRpc, async () => ({ paused: await readControlPaused() }));
  server.handle(setControlPausedRpc, async ({ paused }) => {
    await writeControlPaused(paused);
    return { paused: await readControlPaused() };
  });
  server.handle(chooseDisplayRpc, async ({ display }) => {
    await writePreferredDisplay(display);
    return {};
  });

  return () => {
    void capture.stop();
    void input.stop();
  };
}

/** Why this host cannot share its screen, or null when it can. */
async function unsupportedReason(): Promise<string | null> {
  // Windows support is experimental: tested on one PC so far.
  if (process.platform === "darwin" || process.platform === "win32") return null;
  if (process.platform !== "linux") return "Screen sharing is only available on macOS, Linux and Windows hosts.";
  // X11 sessions are read directly; Wayland sessions go through the desktop portals.
  if (await linuxBackend()) return null;
  return NO_SESSION;
}
