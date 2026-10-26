import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

// Host-side preferences. Display IDs stay stable for a given monitor while it is connected.
const file =
  process.platform === "darwin"
    ? path.join(homedir(), "Library", "Application Support", "paseo-screen", "preferences.json")
    : process.platform === "win32"
      ? path.join(process.env.APPDATA || path.join(homedir(), "AppData", "Roaming"), "paseo-screen", "preferences.json")
      : path.join(process.env.XDG_CONFIG_HOME || path.join(homedir(), ".config"), "paseo-screen", "preferences.json");
/** Where Windows hosts kept preferences before 0.5.0; read until the new file exists. */
const legacyWindowsFile = path.join(homedir(), ".config", "paseo-screen", "preferences.json");

interface Preferences {
  display?: number;
  /** Remote input is refused while true; viewers can still watch. Kept across restarts. */
  controlPaused?: boolean;
}

async function read(): Promise<Preferences> {
  for (const candidate of process.platform === "win32" ? [file, legacyWindowsFile] : [file]) {
    try {
      return JSON.parse(await readFile(candidate, "utf8")) as Preferences;
    } catch {
      // Missing or unreadable: try the next location, then fall back to defaults.
    }
  }
  return {};
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

/** Writes through a temporary file and a rename, so a concurrent read never sees a half-written file. */
async function write(preferences: Preferences): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${Date.now()}.partial`;
  await writeFile(temporary, JSON.stringify(preferences, null, 2));
  await rename(temporary, file);
}
