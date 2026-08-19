import { readFile } from "node:fs/promises";
import process from "node:process";

const auditPath = process.argv[2];
if (!auditPath) throw new Error("usage: verify-dependency-audit.mjs <npm-audit.json>");

const report = JSON.parse(await readFile(auditPath, "utf8"));
if (!report || typeof report !== "object" || !report.vulnerabilities) {
  throw new Error("npm audit JSON is missing vulnerabilities");
}

// Forge 7.11.2 stable still pins the older Packager/Rebuild build toolchain.
// These exceptions are build-time only and must remain exact: any NEW
// high/critical advisory fails CI. Runtime dependencies are separately gated by
// `npm audit --omit=dev --audit-level=high` with no exception list at all.
// Remove entries as soon as a stable Forge release consumes the fixed majors.
const REVIEWED_BUILD_TOOL_ADVISORIES = new Set([
  "GHSA-JMR9-QJV8-65GV", // extract-zip via @electron/packager 18
  "GHSA-34X7-HFP2-RC4V", // tar via @electron/rebuild 3 / node-gyp
  "GHSA-8QQ5-RM4J-MR97",
  "GHSA-83G3-92JG-28CX",
  "GHSA-QFFP-2RHF-9H96",
  "GHSA-9PPJ-QMQM-Q256",
  "GHSA-R6Q2-HW4H-H46W",
  "GHSA-VMF3-W455-68VH",
  "GHSA-W8WR-V893-VJVP",
  "GHSA-23HP-3JRH-7FPW",
  "GHSA-8X88-C5MF-7J5W",
  "GHSA-GVWX-54WH-QM9J",
  "GHSA-R292-9MHP-454M",
  "GHSA-52F5-9888-HMC6", // tmp via Forge CLI's inquirer editor
  "GHSA-PH9P-34F9-6G65",
]);

const highOrCriticalAdvisoryIds = new Set();
const highOrCriticalPackages = [];
for (const [name, vulnerability] of Object.entries(report.vulnerabilities)) {
  if (!vulnerability || typeof vulnerability !== "object") continue;
  if (vulnerability.severity === "high" || vulnerability.severity === "critical") {
    highOrCriticalPackages.push(name);
  }
  collectHighSeverityAdvisories(vulnerability.via, highOrCriticalAdvisoryIds);
}

const unreviewed = [...highOrCriticalAdvisoryIds]
  .filter((id) => !REVIEWED_BUILD_TOOL_ADVISORIES.has(id))
  .sort();
if (unreviewed.length > 0) {
  throw new Error(`unreviewed high/critical npm security advisories: ${unreviewed.join(", ")}`);
}

// An allowlist entry that is not currently present is fine; it means upstream
// fixed part of the chain. Keeping this check one-way avoids blocking security
// improvements while still failing on every newly introduced severe advisory.
console.log(
  `reviewed build-tool audit: ${highOrCriticalPackages.length} high/critical package chain(s), ${highOrCriticalAdvisoryIds.size} reviewed high/critical advisory id(s)`,
);

function collectHighSeverityAdvisories(via, output) {
  if (!Array.isArray(via)) return;
  for (const item of via) {
    if (
      !item ||
      typeof item !== "object" ||
      typeof item.url !== "string" ||
      (item.severity !== "high" && item.severity !== "critical")
    ) {
      continue;
    }
    const match = item.url.match(/GHSA-[A-Za-z0-9-]+/i);
    if (match) output.add(match[0].toUpperCase());
  }
}
