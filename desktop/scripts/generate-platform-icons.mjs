import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import sharp from "sharp";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const desktopDirectory = path.resolve(scriptDirectory, "..");
const sourcePath = path.join(desktopDirectory, "assets", "icon.svg");
const outputDirectory = path.join(desktopDirectory, "assets", "generated");
const svg = await readFile(sourcePath);

await mkdir(outputDirectory, { recursive: true });

const pngBySize = new Map();
for (const size of [16, 32, 48, 64, 128, 256, 512, 1024]) {
  pngBySize.set(
    size,
    await sharp(svg, { density: 384 })
      .resize(size, size, { fit: "contain" })
      .png({ compressionLevel: 9 })
      .toBuffer(),
  );
}

await writeFile(path.join(outputDirectory, "icon.png"), pngBySize.get(512));
await writeFile(path.join(outputDirectory, "icon.ico"), createIco(pngBySize));
await writeFile(path.join(outputDirectory, "icon.icns"), createIcns(pngBySize));

console.log("generated SourceNerve PNG/ICO/ICNS assets from assets/icon.svg");

function createIco(images) {
  const sizes = [16, 32, 48, 64, 128, 256];
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(sizes.length, 4);

  const directory = Buffer.alloc(sizes.length * 16);
  let offset = header.length + directory.length;
  const payloads = [];

  sizes.forEach((size, index) => {
    const png = images.get(size);
    const entry = index * 16;
    directory.writeUInt8(size === 256 ? 0 : size, entry);
    directory.writeUInt8(size === 256 ? 0 : size, entry + 1);
    directory.writeUInt8(0, entry + 2);
    directory.writeUInt8(0, entry + 3);
    directory.writeUInt16LE(1, entry + 4);
    directory.writeUInt16LE(32, entry + 6);
    directory.writeUInt32LE(png.length, entry + 8);
    directory.writeUInt32LE(offset, entry + 12);
    payloads.push(png);
    offset += png.length;
  });

  return Buffer.concat([header, directory, ...payloads]);
}

function createIcns(images) {
  const chunks = [
    ["icp4", 16],
    ["icp5", 32],
    ["icp6", 64],
    ["ic07", 128],
    ["ic08", 256],
    ["ic09", 512],
    ["ic10", 1024],
  ].map(([type, size]) => {
    const png = images.get(size);
    const chunk = Buffer.alloc(8 + png.length);
    chunk.write(type, 0, 4, "ascii");
    chunk.writeUInt32BE(chunk.length, 4);
    png.copy(chunk, 8);
    return chunk;
  });

  const totalLength = 8 + chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const header = Buffer.alloc(8);
  header.write("icns", 0, 4, "ascii");
  header.writeUInt32BE(totalLength, 4);
  return Buffer.concat([header, ...chunks]);
}
