#!/usr/bin/env node
// `route6` — a launcher for the Route6 client.
//
// This package implements no protocol. It makes sure the arch-matched r6me
// binary is present and authentic, then runs it. Everything except `upgrade` is
// passed straight through, so the package needs no update when the client gains
// a command.
//
// The fetch is LAZY — on first use, not at install time — because npm skips
// postinstall entirely under --ignore-scripts, which CI and security-conscious
// installs routinely set. Doing it on first run behaves identically everywhere.
//
// No dependencies on purpose: this thing downloads and executes a binary, so
// its own supply chain should be as small as it can be.

"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const https = require("https");
const http = require("http");
const { spawnSync, execFileSync } = require("child_process");

const BASE_URL = (process.env.R6ME_BASE_URL || "https://dl.route6.me").replace(/\/+$/, "");
const MIRROR_URL = "https://github.com/route6me/r6me-releases/releases/download";

// Kept in step with dist-installer/install.sh and the python launcher.
const ARCH = {
  x64: "amd64", arm64: "arm64", arm: "armv7",
  riscv64: "riscv64", mips: "mips_softfloat", mipsel: "mipsle_softfloat",
};

const RETIRED = {
  login:
    "`route6 login` is gone. The client reads its key from a config file:\n" +
    "    mkdir -p ~/.r6me && chmod 700 ~/.r6me\n" +
    "    echo 'api_key = \"sk_a6_your_key_here\"' > ~/.r6me/config.toml\n" +
    "    chmod 600 ~/.r6me/config.toml\n" +
    "  or set ROUTE6_API_KEY in the environment.",
  logout: "`route6 logout` is gone. Delete ~/.r6me/config.toml.",
  tunnel:
    "`route6 tunnel` is gone. Inbound is a port forward now — start the daemon\n" +
    "  with `route6 up`, then use the port_forward_create MCP tool.",
  mcp:
    "`route6 mcp serve` is gone. `route6 up` serves MCP on\n" +
    "  http://localhost:3000/mcp as part of running the daemon.",
};

const USAGE = `route6 — Route6 client launcher

  route6 up               connect the daemon
  route6 down             disconnect
  route6 status           transport state, config generation, forwards, MCP
  route6 ssh <name>       shell on a team-mate over the private mesh
  route6 version          print the client version
  route6 upgrade          re-fetch the current stable binary

Any other arguments are passed straight through to the r6me binary.
Docs: https://docs.route6.me/quick-start/r6me
`;

function stateDir() {
  return process.env.R6ME_STATE_DIR || path.join(os.homedir(), ".r6me");
}
function binDir() {
  return path.join(stateDir(), "bin");
}

function platformTuple() {
  const p = process.platform;
  const osName = p === "linux" ? "linux" : p === "darwin" ? "darwin" : p === "win32" ? "windows" : null;
  if (!osName) throw new Error(`unsupported operating system: ${p}`);
  const arch = ARCH[process.arch];
  if (!arch) throw new Error(`unsupported architecture: ${process.arch}. Published builds are listed at ${BASE_URL}/`);
  if ((osName === "darwin" || osName === "windows") && arch !== "amd64" && arch !== "arm64") {
    throw new Error(`unsupported architecture for ${osName}: ${process.arch}`);
  }
  return [osName, arch];
}

function get(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error("too many redirects"));
    const mod = url.startsWith("http://") ? http : https;
    mod.get(url, { headers: { "User-Agent": "route6-launcher" } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return resolve(get(new URL(res.headers.location, url).toString(), redirects + 1));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      }
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve(Buffer.concat(chunks)));
    }).on("error", reject);
  });
}

async function resolveVersion() {
  const pinned = (process.env.R6ME_VERSION || "").trim();
  if (pinned) return pinned.startsWith("v") ? pinned : "v" + pinned;
  let body;
  try {
    body = (await get(`${BASE_URL}/stable`)).toString().trim();
  } catch (e) {
    throw new Error(`could not resolve the current version from ${BASE_URL}/stable: ${e.message}`);
  }
  if (!body) throw new Error(`${BASE_URL}/stable was empty`);
  return body.startsWith("v") ? body : "v" + body;
}

// Checked BEFORE any network call, so ordinary invocations cost nothing and work
// offline. Upgrading is therefore explicit (`route6 upgrade`) — the right default
// for something holding a network identity: it does not change under you.
function cachedBinary() {
  const pinned = (process.env.R6ME_VERSION || "").trim();
  if (pinned) {
    const p = path.join(binDir(), `r6me-${pinned.startsWith("v") ? pinned : "v" + pinned}`);
    return fs.existsSync(p) ? p : null;
  }
  let names;
  try {
    names = fs.readdirSync(binDir()).filter((n) => n.startsWith("r6me-"));
  } catch {
    return null;
  }
  if (!names.length) return null;
  names.sort((a, b) => {
    const pa = a.slice(6).split(".").map(Number);
    const pb = b.slice(6).split(".").map(Number);
    for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
    return 0;
  });
  return path.join(binDir(), names[names.length - 1]);
}

async function download(version) {
  const [osName, arch] = platformTuple();
  const asset = `r6me_${version.replace(/^v/, "")}_${osName}_${arch}.tar.gz`;
  const dest = path.join(binDir(), `r6me-${version}`);

  const sources = [
    [`${BASE_URL}/${version}/${asset}`, `${BASE_URL}/${version}/checksums.txt`],
    [`${MIRROR_URL}/${version}/${asset}`, `${MIRROR_URL}/${version}/checksums.txt`],
  ];

  let last;
  for (const [assetUrl, sumsUrl] of sources) {
    let blob, sums;
    try {
      blob = await get(assetUrl);
      sums = (await get(sumsUrl)).toString();
    } catch (e) {
      last = e;
      continue;
    }

    // Fail closed on a missing manifest line exactly as on a mismatch: both mean
    // we cannot say what we just downloaded.
    let want = null;
    for (const line of sums.split("\n")) {
      const parts = line.trim().split(/\s+/);
      if (parts.length === 2 && parts[1] === asset) { want = parts[0]; break; }
    }
    if (!want) throw new Error(`checksum for ${asset} is not listed in checksums.txt — refusing to install`);
    const got = crypto.createHash("sha256").update(blob).digest("hex");
    if (got !== want) {
      throw new Error(
        `checksum mismatch for ${asset}\n  expected: ${want}\n  actual:   ${got}\n` +
        "refusing to install — the download does not match the published checksum"
      );
    }

    fs.mkdirSync(binDir(), { recursive: true });
    const tmpTar = path.join(binDir(), `.${asset}.tmp`);
    fs.writeFileSync(tmpTar, blob);
    // tar is present on every platform we ship a .tar.gz for; extracting just the
    // one member avoids shipping a tar implementation in a package whose whole
    // point is a minimal supply chain.
    try {
      execFileSync("tar", ["xzf", tmpTar, "-C", binDir(), "r6me"], { stdio: "ignore" });
    } finally {
      fs.rmSync(tmpTar, { force: true });
    }
    const extracted = path.join(binDir(), "r6me");
    if (!fs.existsSync(extracted)) throw new Error("archive did not contain an r6me binary");
    fs.chmodSync(extracted, 0o755);
    fs.renameSync(extracted, dest); // move into place; never truncate a running binary
    return dest;
  }
  throw new Error(`could not download r6me ${version}: ${last && last.message}`);
}

async function ensureBinary(forceRefresh) {
  if (!forceRefresh) {
    const cached = cachedBinary();
    if (cached) return cached;
  }
  const version = await resolveVersion();
  const existing = path.join(binDir(), `r6me-${version}`);
  if (fs.existsSync(existing) && !forceRefresh) return existing;
  process.stderr.write(`route6: fetching r6me ${version}...\n`);
  const p = await download(version);
  process.stderr.write(`route6: verified and installed ${p}\n`);
  return p;
}

async function main() {
  let argv = process.argv.slice(2);

  if (argv[0] === "-h" || argv[0] === "--help" || argv[0] === "help") {
    process.stdout.write(USAGE);
    return 0;
  }
  if (argv[0] && RETIRED[argv[0]]) {
    process.stderr.write(RETIRED[argv[0]] + "\n");
    return 2;
  }

  let force = false;
  if (argv[0] === "upgrade") { force = true; argv = ["version"]; }

  let binary;
  try {
    binary = await ensureBinary(force);
  } catch (e) {
    process.stderr.write(`route6: ${e.message}\n`);
    return 1;
  }

  // Node has no execve, so run it as a child with inherited stdio and adopt its
  // exit code. Same process group, so Ctrl-C reaches the daemon directly.
  //
  // R6ME_INSTALL_CHANNEL tells the daemon which ecosystem launched it. Nothing
  // on the wire reveals that — the binary we just exec'd is byte-identical to
  // the one a `curl | sh` install puts on disk — so the launcher is the only
  // thing that knows. An explicit value in the environment wins, so a container
  // or a wrapper can still say what it is.
  const env = { ...process.env };
  if (!env.R6ME_INSTALL_CHANNEL) env.R6ME_INSTALL_CHANNEL = "npm";
  const r = spawnSync(binary, argv, { stdio: "inherit", env });
  if (r.error) {
    process.stderr.write(`route6: could not run ${binary}: ${r.error.message}\n`);
    process.stderr.write(`route6: try removing ${binDir()} and running again\n`);
    return 1;
  }
  if (r.signal) return 128;
  return r.status === null ? 1 : r.status;
}

main().then((code) => process.exit(code)).catch((e) => {
  process.stderr.write(`route6: ${e && e.stack ? e.stack : e}\n`);
  process.exit(1);
});
