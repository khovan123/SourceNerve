import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import process from "node:process";

const parsed = parseArgs(process.argv.slice(2));
const attempts = positiveInteger(process.env.SOURCENERVE_NPM_AUDIT_ATTEMPTS, 3);
const timeoutMs = positiveInteger(process.env.SOURCENERVE_NPM_AUDIT_TIMEOUT_MS, 75_000);
const delaysMs = parseDelays(process.env.SOURCENERVE_NPM_AUDIT_RETRY_DELAYS_MS ?? "5000,15000");

let lastFailure = null;
for (let attempt = 1; attempt <= attempts; attempt += 1) {
  const result = await runAudit(parsed.auditArgs, timeoutMs);
  const report = parseAuditReport(result.stdout);
  const validReport = report && typeof report.vulnerabilities === "object" && report.vulnerabilities !== null;
  const validExit = result.code === 0 || result.code === 1;

  if (validReport && validExit) {
    if (parsed.output) await writeFile(parsed.output, result.stdout, "utf8");
    if (result.stderr) process.stderr.write(result.stderr);
    process.exitCode = parsed.allowAdvisories ? 0 : result.code;
    lastFailure = null;
    break;
  }

  lastFailure = { result, report };
  console.error(`npm audit transport attempt ${attempt}/${attempts} failed: ${transportFailureReason(result, report)}`);
  if (attempt < attempts) {
    const delayMs = delaysMs[Math.min(attempt - 1, delaysMs.length - 1)] ?? 0;
    if (delayMs > 0) await sleep(delayMs);
  }
}

if (lastFailure) {
  const { result, report } = lastFailure;
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.stdout) process.stderr.write(`${result.stdout.trim()}\n`);
  console.error(`npm audit transport failed after ${attempts} attempt(s): ${transportFailureReason(result, report)}`);
  process.exitCode = 2;
}

function parseArgs(args) {
  let allowAdvisories = false;
  let output = null;
  const auditArgs = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--allow-advisories") {
      allowAdvisories = true;
      continue;
    }
    if (arg === "--output") {
      output = args[index + 1];
      if (!output) throw new Error("--output requires a path");
      index += 1;
      continue;
    }
    auditArgs.push(arg);
  }
  return { allowAdvisories, output, auditArgs };
}

function runAudit(auditArgs, timeoutMs) {
  return new Promise((resolve) => {
    const command = process.platform === "win32" ? "npm.cmd" : "npm";
    const child = spawn(command, ["audit", "--json", ...auditArgs], {
      env: {
        ...process.env,
        npm_config_fetch_retries: process.env.npm_config_fetch_retries ?? "2",
        npm_config_fetch_retry_mintimeout: process.env.npm_config_fetch_retry_mintimeout ?? "2000",
        npm_config_fetch_retry_maxtimeout: process.env.npm_config_fetch_retry_maxtimeout ?? "10000",
        npm_config_fetch_timeout: process.env.npm_config_fetch_timeout ?? "30000",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 2_000).unref();
    }, timeoutMs);
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    child.on("error", (error) => {
      finish({ code: null, signal: null, stdout, stderr: `${stderr}${error.message}\n`, timedOut });
    });
    child.on("close", (code, signal) => {
      finish({ code, signal, stdout, stderr, timedOut });
    });
  });
}

function parseAuditReport(raw) {
  try {
    const value = JSON.parse(raw);
    return value && typeof value === "object" ? value : null;
  } catch {
    return null;
  }
}

function transportFailureReason(result, report) {
  if (result.timedOut) return "attempt timed out";
  if (report && typeof report.error === "object" && report.error !== null) {
    const code = typeof report.error.code === "string" ? report.error.code : "npm-error";
    const summary = typeof report.error.summary === "string" ? report.error.summary : "audit endpoint error";
    return `${code}: ${summary}`;
  }
  if (report && typeof report.error === "string") return report.error;
  if (result.signal) return `npm audit terminated by ${result.signal}`;
  if (typeof result.code === "number") return `npm audit exited ${result.code} without a valid vulnerabilities report`;
  return "npm audit did not return a valid vulnerabilities report";
}

function parseDelays(raw) {
  const values = raw.split(",").map((value) => Number.parseInt(value.trim(), 10)).filter((value) => Number.isFinite(value) && value >= 0);
  return values.length > 0 ? values : [0];
}

function positiveInteger(raw, fallback) {
  const value = Number.parseInt(raw ?? "", 10);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
