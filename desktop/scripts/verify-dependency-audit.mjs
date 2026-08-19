import { readFile } from "node:fs/promises";
import process from "node:process";

const auditPath = process.argv[2];
if (!auditPath) throw new Error("usage: verify-dependency-audit.mjs <npm-audit.json>");

const report = JSON.parse(await readFile(auditPath, "utf8"));
if (!report || typeof report !== "object" || !report.vulnerabilities) {
  throw new Error("npm audit JSON is missing vulnerabilities");
}

// Forge 7.11.2 stable still pins the older Packager/Rebuild build toolchain.
// These exceptions are build-time only and must remain exact: any new advisory
// URL, or any runtime high/critical advisory, fails CI. Remove entries as soon
// as a stable Forge release consumes the fixed major versions.
const REVIEWED_BUILD_TOOL_ADVISORIES = new Set([
  "GHSA-jmr9-qjv8-65gv", // extract-zip via @electron/packager 18
  "GHSA-34x7-hfp2-rc4v", // tar via @electron/rebuild 3 / node-gyp
  "GHSA-8qq5-rm4j-mr97",
  "GHSA-83g3-92jg-28cx",
  "GHSA-qffp-2rhf-9h96",
  "GHSA-9ppj-qmqm-q256",
  "GHSA-r6q2-hw4h-h46w",
  "GHSA-vmf3-w455-68vh",
  "GHSA-w8wr-v893-vjvp",
  "GHSA-23hp-3jrh-7fpw",
  "GHSA-8x88-c5mf-7j5w",
  "GHSA-gvwx-54wh-qm9j",
  "GHSA-r292-9mhp-454m",
  "GHSA-52f5-9888-hmc6", // tmp via Forge CLI's inquirer editor
  "GHSA-ph9p-34f9-6g65",
]);

const advisoryIds = new Set();
const highOrCriticalPackages = [];
for (const [name, vulnerability] of Object.entries(report.vulnerabilities)) {
  if (!vulnerability || typeof vulnerability !== "object") continue;
  if (vulnerability.severity === "high" || vulnerability.severity === "critical") {
    highOrCriticalPackages.push(name);
  }
  collectAdvisories(vulnerability.via, advisoryIds);
}

const unreviewed = [...advisoryIds]
  .filter((id) => !REVIEWED_BUILD_TOOL_ADVISORIES.has(id))
  .sort();
if (unreviewed.length > 0) {
  throw new Error(`unreviewed npm security advisories: ${unreviewed.join(", ")}`);
}

// An allowlist entry that is not currently present is fine; it means upstream
// fixed part of the chain. Keeping this check one-way avoids blocking security
// improvements while still failing on every newly introduced advisory.
console.log(
  `reviewed build-tool audit: ${highOrCriticalPackages.length} high/critical package chain(s), ${advisoryIds.size} known advisory id(s)`,
);

function collectAdvisories(via, output) {
  if (!Array.isArray(via)) return;
  for (const item of via) {
    if (!item || typeof item !== "object" || typeof item.url !== "string") continue;
    const match = item.url.match(/GHSA-[A-Za-z0-9-]+/i);
    if (match) output.add(match[0].toUpperCase());
  }
}
