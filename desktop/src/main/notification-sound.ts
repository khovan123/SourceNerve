import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { app, shell } from "electron";

let soundPathPromise: Promise<string> | null = null;

export function playDesktopNotificationSound(): void {
  if (process.platform !== "linux") return;
  void notificationSoundPath()
    .then((soundPath) => playLinuxSound(soundPath))
    .then((played) => {
      if (!played) shell.beep();
    })
    .catch(() => shell.beep());
}

async function notificationSoundPath(): Promise<string> {
  if (!soundPathPromise) {
    soundPathPromise = (async () => {
      const directory = path.join(app.getPath("userData"), "managed");
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const target = path.join(directory, "notification.wav");
      await writeFile(target, buildNotificationWave(), { mode: 0o600 });
      return target;
    })();
  }
  return soundPathPromise;
}

async function playLinuxSound(soundPath: string): Promise<boolean> {
  const players: Array<{ command: string; args: string[] }> = [
    { command: "pw-play", args: [soundPath] },
    { command: "paplay", args: [soundPath] },
    { command: "aplay", args: ["-q", soundPath] },
  ];
  for (const player of players) {
    if (await runPlayer(player.command, player.args)) return true;
  }
  return false;
}

function runPlayer(command: string, args: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const child = spawn(command, args, {
      stdio: "ignore",
      windowsHide: true,
    });
    const finish = (result: boolean) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    child.once("error", () => finish(false));
    child.once("close", (code) => finish(code === 0));
  });
}

export function buildNotificationWave(): Buffer {
  const sampleRate = 44_100;
  const segments = [
    { frequency: 880, seconds: 0.11 },
    { frequency: 660, seconds: 0.14 },
    { frequency: 990, seconds: 0.13 },
  ];
  const samples = segments.reduce(
    (total, segment) => total + Math.round(sampleRate * segment.seconds),
    0,
  );
  const dataBytes = samples * 2;
  const output = Buffer.alloc(44 + dataBytes);

  output.write("RIFF", 0, "ascii");
  output.writeUInt32LE(36 + dataBytes, 4);
  output.write("WAVE", 8, "ascii");
  output.write("fmt ", 12, "ascii");
  output.writeUInt32LE(16, 16);
  output.writeUInt16LE(1, 20);
  output.writeUInt16LE(1, 22);
  output.writeUInt32LE(sampleRate, 24);
  output.writeUInt32LE(sampleRate * 2, 28);
  output.writeUInt16LE(2, 32);
  output.writeUInt16LE(16, 34);
  output.write("data", 36, "ascii");
  output.writeUInt32LE(dataBytes, 40);

  let sampleOffset = 0;
  for (const segment of segments) {
    const segmentSamples = Math.round(sampleRate * segment.seconds);
    for (let index = 0; index < segmentSamples; index += 1) {
      const progress = index / Math.max(1, segmentSamples - 1);
      const envelope = Math.sin(Math.PI * progress) ** 1.5;
      const sample = Math.sin((2 * Math.PI * segment.frequency * index) / sampleRate);
      const value = Math.round(sample * envelope * 0.22 * 32767);
      output.writeInt16LE(value, 44 + sampleOffset * 2);
      sampleOffset += 1;
    }
  }

  return output;
}
