// Mounts the real viewer and checks what each host receives when the viewer switches host or closes. Usage: npm test.
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import test, { afterEach } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

process.env.NODE_ENV = "test";
const root = fileURLToPath(new URL("..", import.meta.url));
const out = `${root}node_modules/.cache/viewer-check`;
mkdirSync(out, { recursive: true });
const stub = (name) => `${root}scripts/viewer-stubs/${name}.js`;
async function load(os) {
  await build({
    stdin: {
      contents: `export { RemoteScreen } from "./client/screen"; export { HostRpc } from "@getpaseo/plugin/client";
        export { createElement, act } from "react"; export { default as renderer } from "react-test-renderer";
        export { QueryClient, QueryClientProvider } from "@tanstack/react-query";`,
      resolveDir: root,
      loader: "ts",
    },
    bundle: true, format: "cjs", platform: "node", outfile: `${out}/${os}.cjs`, logLevel: "error", jsx: "automatic",
    external: ["react", "react/jsx-runtime", "react-test-renderer", "@tanstack/react-query"],
    define: { "process.env.NODE_ENV": '"development"' },
    alias: { "react-native": stub("react-native"), "@getpaseo/plugin/client/react-native": stub("react-native-host"), "@getpaseo/plugin/client": stub("plugin-client") },
  });
  globalThis.viewerOS = os;
  const { default: bundle } = await import(pathToFileURL(`${out}/${os}.cjs`).href);
  return bundle;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
globalThis.viewerCopied = [];
const bundles = { web: await load("web"), ios: await load("ios") };

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const theme = { colors: new Proxy({}, { get: () => "#000" }) };
const displays = [{ id: 1, x: 0, y: 0, width: 1600, height: 1000, pixelWidth: 1600, pixelHeight: 1000, main: true, builtin: true, name: "Main" }];

/** The picture's DOM element, as far as web-input uses it. */
function element() {
  const target = () => {
    const listeners = {};
    return {
      addEventListener: (type, listener) => (listeners[type] ??= new Set()).add(listener),
      removeEventListener: (type, listener) => listeners[type]?.delete(listener),
      fire: (type, event = {}) => [...(listeners[type] ?? [])].forEach((listener) => listener({ preventDefault() {}, metaKey: false, shiftKey: false, altKey: false, ctrlKey: false, ...event })),
    };
  };
  return { ...target(), ownerDocument: target(), style: {}, tabIndex: -1, focus() {}, getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 100 }), measureInWindow() {} };
}

let open = null;
afterEach(async () => {
  await open?.close();
  open = null;
});

/**
 * A viewer on one client. `log` holds every input event a host received, in order. Paseo mounts a new
 * screen for each host; `remounts: false` keeps one mounted.
 */
async function viewer(os = "web", { remounts = true } = {}) {
  const { RemoteScreen, HostRpc, createElement, act, renderer, QueryClient, QueryClientProvider } = bundles[os];
  globalThis.viewerOS = os;
  const log = [];
  const slow = { input: 0, clipboard: 0 };
  const reads = [];
  let paused = false;
  const hosts = {};
  const hostOf = (id) =>
    (hosts[id] ??= {
      client: new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { gcTime: 0 } } }),
      call: async (name, input) => {
        if (name === "screen.status") return { supported: true, platform: "darwin", error: null, screenRecording: true, accessibility: true, locked: false, displays, preferredDisplay: null };
        if (name === "screen.frame") return { display: displays[0], hash: "same", locked: false, jpeg: input.since ? undefined : "AAAA", bytes: 4 };
        if (name === "screen.control-state") return { paused };
        if (name === "screen.set-control-paused") return { paused: (paused = input.paused) };
        if (name === "screen.clipboard") {
          reads.push(id);
          await sleep(slow.clipboard);
          return { changeCount: reads.length, text: `text of ${id}` };
        }
        if (name === "screen.input") {
          await sleep(slow.input);
          for (const event of input.events) log.push({ host: id, ...event });
          return { handled: input.events.length };
        }
        return {};
      },
    });
  let tree;
  let node = null;
  const view = (id) => {
    const { client, call } = hostOf(id);
    const screen = createElement(RemoteScreen, { key: remounts ? id : "", theme, host: { id, label: id }, layout: { compact: os !== "web", platform: os }, navigation: {}, params: {} });
    return createElement(QueryClientProvider, { client }, createElement(HostRpc, { call }, screen));
  };
  const settle = (ms = 0) => act(() => sleep(ms));
  async function show(id) {
    node = null;
    await act(async () => {
      if (tree) tree.update(view(id));
      else tree = renderer.create(view(id), { createNodeMock: ({ props }) => (props.accessibilityLabel === "Remote screen" ? (node ??= element()) : element()) });
    });
    await act(async () => tree.root.findAll((node) => typeof node.type === "string" && node.props.onLayout).forEach((node) => node.props.onLayout({ nativeEvent: { layout: { width: 400, height: 300 } } })));
    await settle(300);
  }
  const picture = () => tree.root.findAll((node) => typeof node.type === "string" && node.props.accessibilityLabel === "Remote screen")[0];
  return (open = {
    log, slow, reads, show, settle,
    /** Events one host received, without pointer moves. */
    got: (host) => log.filter((event) => event.host === host && event.type !== "move").map(({ host: _, ...event }) => event),
    // Each waits a moment, so a fast host has received the event before the next step.
    key: async (type, code, extra) => {
      await act(async () => node.fire(type, { code, repeat: false, ...extra }));
      await settle(20);
    },
    mouse: async (type) => {
      await act(async () => (type === "mouseup" ? node.ownerDocument : node).fire(type, { clientX: 50, clientY: 50, button: 0, detail: 1 }));
      await settle(20);
    },
    blur: async () => {
      await act(async () => node.fire("blur"));
      await settle(20);
    },
    touch: () => act(async () => picture().props.gesture.onPanResponderGrant({ nativeEvent: { touches: [{ locationX: 200, locationY: 150 }] } })),
    type: async (text) => {
      const input = tree.root.findByType("TextInput");
      await act(async () => input.props.onChangeText(text));
      await act(async () => tree.root.findAll((node) => node.type === "Pressable" && node.props.accessibilityLabel === "Send")[0].props.onPress());
    },
    press: (label) => act(async () => tree.root.findAll((node) => node.type === "Pressable" && node.props.accessibilityLabel === label)[0].props.onPress()),
    close: async () => {
      if (tree) await act(async () => tree.unmount());
      tree = null;
      for (const { client } of Object.values(hosts)) client.clear();
    },
  });
}
const ups = (events) => events.filter((event) => event.type === "key" && event.down === false).map((event) => event.keyCode).sort((a, b) => a - b);

test("two keys held: each is released once, on the host that got them", async () => {
  const v = await viewer();
  await v.show("A");
  await v.key("keydown", "KeyA");
  await v.key("keydown", "KeyB");
  await v.show("B");
  assert.deepEqual(ups(v.got("A")), [0, 11]);
  assert.deepEqual(v.got("B"), []);
});

test("modifier plus key: the key is released without the modifier", async () => {
  const v = await viewer();
  await v.show("A");
  await v.key("keydown", "ShiftLeft", { shiftKey: true });
  await v.key("keydown", "KeyA", { shiftKey: true });
  await v.show("B");
  assert.deepEqual(v.got("A"), [{ type: "key", keyCode: 0, down: true, modifiers: ["shift"] }, { type: "key", keyCode: 0, down: false, modifiers: [] }]);
  assert.deepEqual(v.got("B"), []);
});

test("a release arriving twice is sent once", async () => {
  const v = await viewer();
  await v.show("A");
  await v.key("keydown", "KeyA");
  await v.key("keyup", "KeyA");
  await v.key("keyup", "KeyA");
  assert.deepEqual(ups(v.got("A")), [0]);
  await v.key("keydown", "KeyB");
  await v.blur();
  await v.key("keyup", "KeyB");
  await v.show("B");
  assert.deepEqual(ups(v.got("A")), [0, 11]);
});

test("a switch while a slow call is in flight drops what was typed, and still releases the key", async () => {
  const v = await viewer();
  await v.show("A");
  v.slow.input = 700;
  await v.key("keydown", "KeyA");
  // The first call is now in flight; these wait behind it.
  await v.type("queued text");
  await v.press("⏎");
  await v.press("⌫");
  await v.key("keydown", "KeyB");
  await v.show("B");
  await v.settle(2500);
  // KeyB never reached the host, so it has nothing to release.
  assert.deepEqual(v.got("A").map((event) => [event.type, event.keyCode, event.down]), [["key", 0, true], ["key", 0, false]]);
  assert.deepEqual(v.got("B"), []);
});

test("a release already queued at the switch is sent once", async () => {
  const v = await viewer();
  await v.show("A");
  v.slow.input = 700;
  await v.key("keydown", "KeyA");
  await v.mouse("mousedown");
  await v.settle(1700);
  await v.type("slow");
  await v.key("keyup", "KeyA");
  await v.mouse("mouseup");
  await v.type("later");
  await v.show("B");
  await v.settle(2500);
  assert.deepEqual(v.got("A").map((event) => event.type === "text" ? event.text : `${event.type} ${event.down ?? ""}`.trim()), ["key true", "down", "slow", "key false", "up"]);
  assert.deepEqual(v.got("B"), []);
});

test("A to B to A: each visit is separate, and the old release comes before the new press", async () => {
  const v = await viewer();
  await v.show("A");
  v.slow.input = 900;
  await v.key("keydown", "KeyA");
  await v.type("old");
  await v.show("B");
  await v.show("A");
  v.slow.input = 0;
  await v.key("keydown", "KeyA");
  await v.settle(1500);
  assert.deepEqual(v.got("A").map((event) => [event.type, event.down]), [["key", true], ["key", false], ["key", true]]);
  await v.key("keyup", "KeyA");
  await v.settle(50);
  assert.deepEqual(ups(v.got("A")), [0, 0]);
  assert.deepEqual(v.got("B"), []);
});

test("blur without a switch releases the key and drops nothing", async () => {
  const v = await viewer();
  await v.show("A");
  v.slow.input = 100;
  await v.key("keydown", "KeyA");
  await v.type("kept");
  await v.blur();
  await v.settle(500);
  assert.deepEqual(v.got("A").map((event) => event.text ?? event.down), [true, "kept", false]);
});

test("closing the viewer releases held keys", async () => {
  const v = await viewer();
  await v.show("A");
  await v.key("keydown", "KeyA");
  await v.close();
  await sleep(50);
  assert.deepEqual(ups(v.got("A")), [0]);
});

test("unmount in the middle of a long press sends no right click", async () => {
  const v = await viewer("ios");
  await v.show("A");
  // The closed queue drops the click too, so also check that the timer itself is gone.
  const { setTimeout: set } = globalThis;
  const longPress = [];
  globalThis.setTimeout = (run, ms, ...rest) => {
    const timer = set(run, ms, ...rest);
    if (ms === 500) longPress.push(timer);
    return timer;
  };
  await v.touch();
  globalThis.setTimeout = set;
  assert.equal(longPress.length, 1);
  await sleep(100);
  await v.close();
  assert.equal(longPress[0]._destroyed, true);
  await sleep(700);
  assert.deepEqual(v.got("A"), []);
});

test("a host change in the middle of a long press sends no right click to either host", async () => {
  const v = await viewer("ios");
  await v.show("A");
  await v.touch();
  await v.show("B");
  await v.settle(700);
  assert.deepEqual([...v.got("A"), ...v.got("B")], []);
});

test("a clipboard reply that arrives after the switch does not change this device's clipboard", async () => {
  globalThis.viewerCopied.length = 0;
  const v = await viewer("ios");
  await v.show("A");
  v.slow.clipboard = 400;
  await v.press("Copy from host");
  await v.show("B");
  await v.settle(800);
  assert.deepEqual(globalThis.viewerCopied, []);
});

test("a host change that keeps the screen mounted is still a new viewer", async () => {
  const v = await viewer("web", { remounts: false });
  await v.show("A");
  await v.mouse("mousedown");
  await v.key("keydown", "KeyA");
  v.slow.input = 700;
  await v.type("first");
  await v.type("second");
  await v.show("B");
  await v.settle(2500);
  assert.deepEqual(v.got("A").map((event) => event.text ?? `${event.type} ${event.down ?? ""}`.trim()).sort(), ["down", "first", "key false", "key true", "up"]);
  assert.deepEqual(v.got("B"), []);
});

test("turning on View only or pausing control releases a held key", async () => {
  for (const label of ["Control: on", "⏸ Pause control"]) {
    const v = await viewer();
    await v.show("A");
    await v.key("keydown", "KeyA");
    await v.press(label);
    await v.settle(100);
    assert.deepEqual(ups(v.got("A")), [0], label);
    await v.close();
  }
});

test("a viewer that reopens behind a stuck request waits for it only once", async () => {
  const v = await viewer();
  await v.show("A");
  v.slow.input = 10_000;
  await v.type("stuck");
  await v.show("B");
  v.slow.input = 0;
  await v.show("A");
  await v.type("one");
  await v.settle(5200);
  assert.deepEqual(v.got("A").map((event) => event.text), ["one"]);
  await v.type("two");
  await v.settle(300);
  assert.deepEqual(v.got("A").map((event) => event.text), ["one", "two"]);
});

// These already worked and must keep working.
test("a held mouse button is released on the host that got it", async () => {
  const v = await viewer();
  await v.show("A");
  await v.mouse("mousedown");
  await v.show("B");
  assert.deepEqual(v.got("A").map((event) => event.type), ["down", "up"]);
  assert.deepEqual(v.got("B"), []);
});

test("a Cmd shortcut is one tap, and its late key-up is dropped", async () => {
  const v = await viewer();
  await v.show("A");
  await v.key("keydown", "KeyA", { metaKey: true });
  await v.key("keyup", "KeyA");
  assert.deepEqual(v.got("A"), [{ type: "key", keyCode: 0, modifiers: ["cmd"] }]);
});

test("a held key repeats, and a long press still right-clicks", async () => {
  const v = await viewer();
  await v.show("A");
  await v.key("keydown", "KeyA");
  await v.key("keydown", "KeyA", { repeat: true });
  await v.key("keyup", "KeyA");
  assert.deepEqual(v.got("A").map((event) => event.down), [true, true, false]);
  await v.close();
  const phone = await viewer("ios");
  await phone.show("A");
  await phone.touch();
  await phone.settle(700);
  assert.deepEqual(phone.got("A").map((event) => [event.type, event.button]), [["click", "right"]]);
});
