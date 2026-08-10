import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const tracked = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" }).split("\0").filter(Boolean);
const forbiddenPaths = [
  /(^|\/)\.env(?:\.|$)/,
  /(^|\/)\.harness\//,
  /(^|\/)state\.db(?:-|$)/,
  /(^|\/)workspace\//,
  /\.db(?:\.sha256)?$/,
];
const allowedExamples = new Set([".env.example", "deploy/.env.production.example"]);
const secretPatterns = [
  ["OpenAI-style key", /\bsk-[A-Za-z0-9_-]{16,}\b/],
  ["GitHub token", /\bgh[pousr]_[A-Za-z0-9]{20,}\b/],
  ["Hugging Face token", /\bhf_[A-Za-z0-9]{20,}\b/],
  ["NVIDIA API key", /\bnvapi-[A-Za-z0-9_-]{20,}\b/],
  ["Google API key", /\bAIza[0-9A-Za-z_-]{30,}\b/],
  ["private key", /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
];
const disposableAddressSuffix = `@${["dnsink", "com"].join(".")}`;

const failures = [];
for (const path of tracked) {
  if (!allowedExamples.has(path) && forbiddenPaths.some((pattern) => pattern.test(path))) {
    failures.push(`${path}: private runtime path must not be tracked`);
    continue;
  }
  let contents;
  try {
    contents = readFileSync(path, "utf8");
  } catch {
    continue;
  }
  if (contents.includes(disposableAddressSuffix)) failures.push(`${path}: disposable personal address must not be published`);
  for (const [label, pattern] of secretPatterns) {
    if (pattern.test(contents)) failures.push(`${path}: possible ${label}`);
  }
}

if (failures.length) {
  console.error("Repository safety check failed:\n" + failures.map((failure) => `- ${failure}`).join("\n"));
  process.exitCode = 1;
} else {
  console.log(`Repository safety check passed (${tracked.length} tracked files scanned)`);
}
