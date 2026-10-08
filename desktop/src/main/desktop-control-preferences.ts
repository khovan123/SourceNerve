import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import type { DesktopControlPermissions } from "../shared/desktop-api";

const SCHEMA_VERSION = 1;

interface StoredDesktopControlPermissions extends DesktopControlPermissions {
  schemaVersion: typeof SCHEMA_VERSION;
}

const DEFAULT_PERMISSIONS: DesktopControlPermissions = Object.freeze({
  screen: false,
  mouse: false,
  keyboard: false,
  clipboard: false,
});

export class DesktopControlPreferencesStore {
  private current: DesktopControlPermissions = { ...DEFAULT_PERMISSIONS };

  constructor(private readonly filePath: string) {}

  async initialize(): Promise<DesktopControlPermissions> {
    let raw: string;
    try {
      raw = await readFile(this.filePath, "utf8");
    } catch (error) {
      if (!isMissing(error)) throw error;
      this.current = { ...DEFAULT_PERMISSIONS };
      return this.snapshot();
    }

    try {
      this.current = validateStored(JSON.parse(raw) as unknown);
    } catch {
      this.current = { ...DEFAULT_PERMISSIONS };
    }
    return this.snapshot();
  }

  snapshot(): DesktopControlPermissions {
    return { ...this.current };
  }

  async update(next: DesktopControlPermissions): Promise<DesktopControlPermissions> {
    const validated = validatePermissions(next);
    await atomicWrite(
      this.filePath,
      JSON.stringify({ schemaVersion: SCHEMA_VERSION, ...validated }, null, 2),
    );
    this.current = validated;
    return this.snapshot();
  }

  async reset(): Promise<DesktopControlPermissions> {
    await atomicWrite(
      this.filePath,
      JSON.stringify({ schemaVersion: SCHEMA_VERSION, ...DEFAULT_PERMISSIONS }, null, 2),
    );
    this.current = { ...DEFAULT_PERMISSIONS };
    return this.snapshot();
  }
}

export function defaultDesktopControlPermissions(): DesktopControlPermissions {
  return { ...DEFAULT_PERMISSIONS };
}

export function validateDesktopControlPermissions(value: unknown): DesktopControlPermissions {
  return validatePermissions(value);
}

function validateStored(value: unknown): DesktopControlPermissions {
  if (!isRecord(value) || value.schemaVersion !== SCHEMA_VERSION) {
    return { ...DEFAULT_PERMISSIONS };
  }
  return validatePermissions(value);
}

function validatePermissions(value: unknown): DesktopControlPermissions {
  if (!isRecord(value)) throw new Error("Desktop control permissions must be an object");
  const allowed = new Set(["schemaVersion", "screen", "mouse", "keyboard", "clipboard"]);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new Error("Desktop control permissions contain unknown fields");
  }
  const screen = value.screen;
  const mouse = value.mouse;
  const keyboard = value.keyboard;
  const clipboard = value.clipboard;
  if (typeof screen !== "boolean") throw new Error("screen must be boolean");
  if (typeof mouse !== "boolean") throw new Error("mouse must be boolean");
  if (typeof keyboard !== "boolean") throw new Error("keyboard must be boolean");
  if (typeof clipboard !== "boolean") throw new Error("clipboard must be boolean");
  return { screen, mouse, keyboard, clipboard };
}

async function atomicWrite(filePath: string, content: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.tmp-${process.pid}`;
  await writeFile(temporary, `${content}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, filePath);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT";
}
