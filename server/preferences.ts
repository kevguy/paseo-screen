import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

// Host-side preferences. Display IDs stay stable for a given monitor while it is connected.
const file =
  process.platform === "darwin"
    ? path.join(homedir(), "Library", "Application Support", "paseo-screen", "preferences.json")
    : process.platform === "win32"
      ? path.join(process.env.APPDATA || path.join(homedir(), "AppData", "Roaming"), "paseo-screen", "preferences.json")
      : path.join(process.env.XDG_CONFIG_HOME || path.join(homedir(), ".config"), "paseo-screen", "preferences.json");

interface Preferences {
  display?: number;
  /** Remote input is refused while true; viewers can still watch. Kept across restarts. */
  controlPaused?: boolean;
}

async function read(): Promise<Preferences> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as Preferences;
  } catch {
    return {};
  }
}

export async function readPreferredDisplay(): Promise<number | null> {
  return (await read()).display ?? null;
}

export async function writePreferredDisplay(display: number): Promise<void> {
  const preferences = await read();
  if (preferences.display === display) return;
  await write({ ...preferences, display });
}

export async function readControlPaused(): Promise<boolean> {
  return (await read()).controlPaused === true;
}

export async function writeControlPaused(paused: boolean): Promise<void> {
  const preferences = await read();
  if ((preferences.controlPaused === true) === paused) return;
  await write({ ...preferences, controlPaused: paused });
}

async function write(preferences: Preferences): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(preferences, null, 2));
}
