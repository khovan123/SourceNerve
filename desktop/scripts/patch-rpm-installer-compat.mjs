import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform !== "linux") {
  console.log("[desktop] RPM installer compatibility patch skipped on non-Linux host");
  process.exit(0);
}

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const desktopDirectory = path.resolve(scriptDirectory, "..");
const specPath = path.join(
  desktopDirectory,
  "node_modules",
  "electron-installer-redhat",
  "resources",
  "spec.ejs",
);

const legacySource = "usr/* %{buildroot}/usr/";
const compatibleSource = "%{_builddir}/usr/* %{buildroot}/usr/";

let template;
try {
  template = await readFile(specPath, "utf8");
} catch (error) {
  if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
    throw new Error(
      "electron-installer-redhat is unavailable; run npm install before building RPM artifacts",
    );
  }
  throw error;
}

if (template.includes(compatibleSource)) {
  console.log("[desktop] electron-installer-redhat already supports rpmbuild >= 4.20");
  process.exit(0);
}

if (!template.includes(legacySource)) {
  console.log("[desktop] electron-installer-redhat template does not require the rpmbuild 4.20 compatibility patch");
  process.exit(0);
}

const patched = template.replace(legacySource, compatibleSource);
if (patched === template) {
  throw new Error("failed to apply rpmbuild 4.20 compatibility patch");
}

await writeFile(specPath, patched, "utf8");
console.log("[desktop] patched electron-installer-redhat for rpmbuild >= 4.20");
