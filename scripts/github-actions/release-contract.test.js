#!/usr/bin/env node

// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors

"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.resolve(__dirname, "../..");
const WORKFLOW = fs.readFileSync(path.join(ROOT, ".github/workflows/release.yml"), "utf8");
const MANIFEST = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
const PACKAGES = [MANIFEST.name, ...Object.keys(MANIFEST.optionalDependencies)].sort();

function jobText(name) {
  const lines = WORKFLOW.split("\n");
  const start = lines.indexOf(`  ${name}:`);
  assert.ok(start >= 0, `missing job ${name}`);
  const end = lines.findIndex((line, index) => index > start && /^  [\w-]+:/.test(line));
  return lines.slice(start, end < 0 ? undefined : end).join("\n");
}

function stepText(job, name) {
  const lines = jobText(job).split("\n");
  const start = lines.indexOf(`      - name: ${name}`);
  assert.ok(start >= 0, `missing step ${name}`);
  const end = lines.findIndex((line, index) => index > start && /^      - /.test(line));
  return lines.slice(start, end < 0 ? undefined : end).join("\n");
}

function runBlock(step) {
  const lines = step.split("\n");
  const start = lines.indexOf("        run: |");
  assert.ok(start >= 0, "expected a multiline run block");
  const script = [];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() && !line.startsWith("          ")) break;
    script.push(line.slice(10));
  }
  return script.join("\n");
}

const PREFLIGHT = stepText("verify-trusted-publishing", "Exchange OIDC token for every package");
const VERSION_GATE = stepText("npm-publish", "Ensure npm supports trusted publishing");

function execute(step, overrides = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ocr-release-contract-"));
  const bin = path.join(directory, "bin");
  fs.mkdirSync(bin);
  fs.symlinkSync(process.execPath, path.join(bin, "node"));
  fs.writeFileSync(path.join(directory, "package.json"), JSON.stringify(MANIFEST));
  const mock = `#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const command = path.basename(process.argv[1]);
const args = process.argv.slice(2);
fs.appendFileSync("calls.jsonl", JSON.stringify({ command, args }) + "\\n");
if (command === "npm") {
  if (args[0] === "--version") {
    console.log(process.env.TEST_NPM_VERSION);
  } else if (args[0] === "install") {
    process.exit(Number(process.env.TEST_INSTALL_STATUS || 0));
  } else {
    throw new Error("Unexpected npm operation: " + args.join(" "));
  }
} else if (args[args.length - 1].startsWith("https://oidc.invalid/")) {
  console.log(JSON.stringify({ value: process.env.TEST_ID_TOKEN }));
} else {
  if (process.env.TEST_CURL_FAILURE === "1") process.exit(7);
  const failed = process.env.TEST_FAILED_PACKAGE &&
    args[args.length - 1].endsWith(process.env.TEST_FAILED_PACKAGE.split("/").join("%2f"));
  const body = failed ? JSON.stringify({ message: "Not authorized" }) : process.env.TEST_RESPONSE;
  const outputIndex = args.indexOf("-o");
  if (outputIndex < 0) throw new Error("Expected a curl output file");
  fs.writeFileSync(args[outputIndex + 1], body);
  process.stdout.write(failed ? "401" : process.env.TEST_HTTP_STATUS);
}
`;
  for (const command of ["curl", "npm"]) {
    fs.writeFileSync(path.join(bin, command), mock, { mode: 0o755 });
  }
  const claims = Buffer.from(JSON.stringify({
    repository: "alibaba/open-code-review",
    workflow_ref: "alibaba/open-code-review/.github/workflows/release.yml@refs/heads/main",
    repository_visibility: "public",
  })).toString("base64url");
  try {
    const result = spawnSync("/bin/bash", ["--noprofile", "--norc", "-e", "-c", runBlock(step)], {
      cwd: directory,
      encoding: "utf8",
      timeout: 30000,
      env: {
        PATH: `${bin}:${process.env.PATH}`,
        HOME: directory,
        LC_ALL: "C",
        ACTIONS_ID_TOKEN_REQUEST_URL: "https://oidc.invalid/?request=fixture",
        ACTIONS_ID_TOKEN_REQUEST_TOKEN: "fixture-request-token",
        TEST_ID_TOKEN: `header.${claims}.signature`,
        TEST_HTTP_STATUS: "201",
        TEST_RESPONSE: JSON.stringify({ token: "fixture-npm-token" }),
        TEST_NPM_VERSION: "11.15.0",
        ...overrides,
      },
    });
    assert.ifError(result.error);
    const callsPath = path.join(directory, "calls.jsonl");
    const calls = fs.existsSync(callsPath)
      ? fs.readFileSync(callsPath, "utf8").trim().split("\n").map(JSON.parse)
      : [];
    return { ...result, calls };
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

let failures = 0;
function test(name, check) {
  try {
    check();
    console.log(`PASS ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`FAIL ${name}: ${error.message}`);
  }
}

test("container scripts explicitly select Bash", () => {
  for (const step of [PREFLIGHT, VERSION_GATE]) {
    assert.match(step, /^        shell: bash$/m);
  }
});

test("manual preflight is separated from tag publishing", () => {
  assert.match(WORKFLOW, /^  workflow_dispatch:/m);
  assert.match(jobText("verify-trusted-publishing"), /^    if: github.event_name == 'workflow_dispatch'$/m);
  assert.match(jobText("build"), /^    if: github.event_name == 'push'$/m);
  assert.match(jobText("release"), /^    needs: build$/m);
  assert.match(jobText("npm-publish"), /^    needs: release$/m);
  for (const job of ["build", "release"]) {
    assert.match(jobText(job), /^    runs-on: self-hosted$/m);
  }
  for (const job of ["verify-trusted-publishing", "npm-publish"]) {
    assert.match(jobText(job), /^    runs-on: ubuntu-latest$/m);
    assert.match(jobText(job), /^      id-token: write$/m);
  }
  assert.doesNotMatch(WORKFLOW, /NPM_TOKEN|NODE_AUTH_TOKEN|_authToken/);
});

test("HTTP 201 validates all nine packages without publishing", () => {
  const result = execute(PREFLIGHT);
  assert.strictEqual(result.status, 0, result.stdout + result.stderr);
  const verified = Array.from(result.stdout.matchAll(/^OK\s+(\S+)$/gm), (match) => match[1]).sort();
  assert.strictEqual(PACKAGES.length, 9);
  assert.deepStrictEqual(verified, PACKAGES);
  assert.ok(result.calls.every((call) => call.command === "curl"));
  const requests = result.calls.map((call) => call.args[call.args.length - 1]);
  assert.strictEqual(requests[0], "https://oidc.invalid/?request=fixture&audience=npm:registry.npmjs.org");
  assert.deepStrictEqual(requests.slice(1).sort(), PACKAGES.map((name) =>
    `https://registry.npmjs.org/-/npm/v1/oidc/token/exchange/package/${name.split("/").join("%2f")}`
  ).sort());
  assert.ok(!result.stdout.includes("fixture-npm-token"));
});

test("one unauthorized platform fails preflight", () => {
  const result = execute(PREFLIGHT, { TEST_FAILED_PACKAGE: PACKAGES[0] });
  assert.notStrictEqual(result.status, 0);
  assert.match(result.stdout, /FAILED.*HTTP 401/);
  assert.match(result.stdout, /At least one package is not configured/);
});

for (const response of [{}, { token: null }, { token: "" }, { token: 123 }, { token: [] }]) {
  test(`HTTP 201 rejects an invalid token: ${JSON.stringify(response)}`, () => {
    const result = execute(PREFLIGHT, { TEST_RESPONSE: JSON.stringify(response) });
    assert.notStrictEqual(result.status, 0);
    assert.match(result.stdout, /At least one package is not configured/);
  });
}

test("missing OIDC permissions fail before network access", () => {
  const result = execute(PREFLIGHT, { ACTIONS_ID_TOKEN_REQUEST_TOKEN: "" });
  assert.notStrictEqual(result.status, 0);
  assert.deepStrictEqual(result.calls, []);
});

test("network failures cannot pass preflight", () => {
  const result = execute(PREFLIGHT, { TEST_CURL_FAILURE: "1" });
  assert.notStrictEqual(result.status, 0);
  assert.doesNotMatch(result.stdout, /All packages accept/);
});

for (const version of ["10.9.0", "11.5.1", "11.14.0", "11.15.0", "11.19.0"]) {
  test(`npm version gate handles ${version}`, () => {
    const result = execute(VERSION_GATE, { TEST_NPM_VERSION: version });
    assert.strictEqual(result.status, 0, result.stdout + result.stderr);
    const installs = result.calls.filter((call) => call.args[0] === "install");
    const needsUpgrade = ["10.9.0", "11.5.1", "11.14.0"].includes(version);
    assert.deepStrictEqual(installs.map((call) => call.args), needsUpgrade
      ? [["install", "-g", "npm@11.15.0"]]
      : []);
  });
}

test("failed npm upgrade stops the job", () => {
  const result = execute(VERSION_GATE, { TEST_NPM_VERSION: "10.9.0", TEST_INSTALL_STATUS: "1" });
  assert.notStrictEqual(result.status, 0);
});

test("both publish paths require provenance", () => {
  for (const name of ["Publish platform packages", "Publish to npm"]) {
    const commands = runBlock(stepText("npm-publish", name)).split("\n")
      .filter((line) => /^\s*npm publish\b/.test(line));
    assert.strictEqual(commands.length, 1);
    assert.match(commands[0], /--provenance(?:\s|$)/);
    assert.match(commands[0], /--access public(?:\s|$)/);
  }
});

// The release pipeline copies each platform binary into npm/<platform>/bin and
// bumps the manifest there, so a platform listed in package.json without its
// manifest (or vice versa) aborts publishing mid-loop. Keep the two in lockstep.
test("every optional dependency has a matching npm platform manifest", () => {
  for (const dep of Object.keys(MANIFEST.optionalDependencies)) {
    const platformDir = dep.replace(/^@alibaba-group\/ocr-/, "");
    const manifestPath = path.join(ROOT, "npm", platformDir, "package.json");
    assert.ok(fs.existsSync(manifestPath), `missing npm manifest: npm/${platformDir}/package.json`);
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    assert.strictEqual(manifest.name, dep, `name mismatch in npm/${platformDir}/package.json`);
    assert.strictEqual(manifest.os.length, 1, `npm/${platformDir} must declare one os`);
    assert.strictEqual(manifest.cpu.length, 1, `npm/${platformDir} must declare one cpu`);
  }
});

test("npm platform directories mirror optionalDependencies exactly", () => {
  const dirs = fs.readdirSync(path.join(ROOT, "npm"))
    .filter((entry) => fs.existsSync(path.join(ROOT, "npm", entry, "package.json")));
  const expected = Object.keys(MANIFEST.optionalDependencies)
    .map((dep) => dep.replace(/^@alibaba-group\/ocr-/, ""));
  assert.deepStrictEqual(dirs.sort(), expected.sort());
});

// install.sh's checksum helper is named `sha256`, so the branch that falls back
// to the base-system tool must call it through `command`: POSIX sh resolves
// functions before PATH executables, and a bare `sha256 -q` would re-enter the
// helper and recurse until the shell dies.
test("install.sh sha256 helper invokes the external tool via `command`", () => {
  const install = fs.readFileSync(path.join(ROOT, "install.sh"), "utf8");
  const match = install.match(/sha256\(\)\s*\{([\s\S]*?)\n\}/);
  assert.ok(match, "install.sh must define a sha256() helper");
  const body = match[1];
  const bareCall = body.split("\n").find((line) => /^\s*sha256\s+-q\b/.test(line));
  assert.strictEqual(bareCall, undefined, `sha256 branch must use "command sha256": ${bareCall}`);
  assert.match(body, /command\s+sha256\s+-q/, "sha256 branch must invoke command sha256 -q");
});

test("install.sh sha256 helper returns the digest without shasum/sha256sum", () => {
  const sha256Bin = ["/sbin/sha256", "/usr/bin/sha256", "/bin/sha256", "/usr/local/bin/sha256"]
    .find((candidate) => fs.existsSync(candidate));
  const shBin = "/bin/sh";
  if (!sha256Bin || !fs.existsSync(shBin)) return; // no base-system sha256 to exercise

  const install = fs.readFileSync(path.join(ROOT, "install.sh"), "utf8");
  const body = install.match(/sha256\(\)\s*\{([\s\S]*?)\n\}/)[1];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ocr-sha256-"));
  const binDir = path.join(dir, "bin");
  fs.mkdirSync(binDir);
  fs.symlinkSync(sha256Bin, path.join(binDir, "sha256"));
  const file = path.join(dir, "payload");
  fs.writeFileSync(file, "abc");
  const script = `sha256() {${body}\n}\nsha256 ${file}\n`;
  try {
    const result = spawnSync(shBin, ["-c", script], {
      encoding: "utf8",
      timeout: 5000,
      env: { PATH: binDir },
    });
    assert.ifError(result.error);
    assert.strictEqual(result.status, 0, result.stdout + result.stderr);
    assert.strictEqual(
      result.stdout.trim(),
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

if (failures) process.exitCode = 1;
