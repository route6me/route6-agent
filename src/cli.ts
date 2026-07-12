#!/usr/bin/env node
// @route6/agent CLI — `route6 <command>`.
//
// Quick start:
//   route6 login sk_a6_<your-api-key>
//   route6 tunnel start --hostname my-app --to 3000
//   # in another shell:
//   curl https://my-app.on.route6.me/  → reaches localhost:3000

import { Command, Option } from "commander";
import { logger } from "./logger.js";
import { configPath, loadConfig, saveConfig, requireApiKey } from "./config.js";
import { TunnelClient } from "./tunnel-client.js";
import { Forwarder } from "./forwarder.js";
import { McpProxy } from "./local-mcp.js";

const VERSION = "0.1.0";

const program = new Command();
program
    .name("route6")
    .description("Route6 thin client — tunnel localhost ports to *.on.route6.me + local MCP proxy.")
    .version(VERSION);

// ---------- login ----------
program
    .command("login")
    .argument("<api_key>", "Your Route6 API key (sk_a6_...)")
    .option("--gateway <url>", "Override gateway URL (default https://gw.route6.me)")
    .option("--api <url>", "Override controller API URL (default https://api.route6.me)")
    .description("Store API key in ~/.route6/config.json (mode 0600)")
    .action(async (apiKey: string, opts: { gateway?: string; api?: string }) => {
        const cfg = loadConfig();
        cfg.api_key = apiKey;
        if (opts.gateway) cfg.gateway_url = opts.gateway;
        if (opts.api) cfg.api_url = opts.api;
        cfg.last_session_id = null; // fresh credentials, drop stale resume id
        cfg.last_session_at = null;
        saveConfig(cfg);
        // Verify by calling /whoami on the gateway.
        try {
            const res = await fetch(`${cfg.gateway_url}/whoami`, {
                headers: { "authorization": `Bearer ${apiKey}` },
                signal: AbortSignal.timeout(10_000),
            });
            if (!res.ok) {
                process.stderr.write(green(`✗ Saved key to ${configPath()} but /whoami returned HTTP ${res.status}.\n`));
                process.exit(1);
            }
            const j = await res.json() as { agent_id?: number; customer_id?: number; plan?: string; connection_type?: string };
            process.stdout.write(green(`✓ Logged in — agent ${j.agent_id} / customer ${j.customer_id} / plan ${j.plan} / tier ${j.connection_type}\n`));
            process.stdout.write(`  Config written to ${configPath()}\n`);
        } catch (err) {
            process.stderr.write(red(`✗ Failed to reach ${cfg.gateway_url}: ${(err as Error).message}\n`));
            process.exit(1);
        }
    });

// ---------- logout ----------
program
    .command("logout")
    .description("Clear the stored API key.")
    .action(() => {
        const cfg = loadConfig();
        cfg.api_key = null;
        cfg.last_session_id = null;
        cfg.last_session_at = null;
        saveConfig(cfg);
        process.stdout.write(green(`✓ Logged out (${configPath()})\n`));
    });

// ---------- status ----------
program
    .command("status")
    .description("Show stored config + check connectivity to the gateway.")
    .action(async () => {
        const cfg = loadConfig();
        process.stdout.write(`config: ${configPath()}\n`);
        process.stdout.write(`gateway: ${cfg.gateway_url}\n`);
        process.stdout.write(`api: ${cfg.api_url}\n`);
        if (!cfg.api_key) {
            process.stdout.write(red("api_key: (not logged in — run `route6 login <api_key>`)\n"));
            process.exit(1);
        }
        process.stdout.write(`api_key: ${cfg.api_key.slice(0, 12)}…\n`);
        if (cfg.last_session_id) {
            const ageSec = Math.floor((Date.now() - (cfg.last_session_at ?? 0)) / 1000);
            process.stdout.write(`last_session: ${cfg.last_session_id} (${ageSec}s ago)\n`);
        }
        try {
            const res = await fetch(`${cfg.gateway_url}/whoami`, {
                headers: { "authorization": `Bearer ${cfg.api_key}` },
                signal: AbortSignal.timeout(10_000),
            });
            const body = await res.text();
            process.stdout.write(`\nGET ${cfg.gateway_url}/whoami → HTTP ${res.status}\n`);
            process.stdout.write(body + "\n");
        } catch (err) {
            process.stderr.write(red(`✗ ${cfg.gateway_url}/whoami unreachable: ${(err as Error).message}\n`));
            process.exit(1);
        }
    });

// ---------- tunnel ----------
const tunnel = program.command("tunnel").description("Open / close the inbound tunnel.");

tunnel
    .command("start")
    .description("Open the tunnel and forward inbound *.on.route6.me requests to local ports.")
    .requiredOption("--hostname <name>", "Hostname (bare or full fqdn). Repeatable.", collectPair, [] as Array<{ name: string; port?: string }>)
    .option("--to <port>", "Target port for the latest --hostname. Repeatable.", collectTo, [] as string[])
    .addOption(new Option("--no-mcp", "Skip the local MCP proxy (tunnel-only mode)"))
    .option("--mcp-port <port>", "Local MCP proxy port (default 3000)", "3000")
    .action(async (opts: { hostname: Array<{ name: string; port?: string }>; to: string[]; mcp: boolean; mcpPort: string }) => {
        const cfg = loadConfig();
        requireApiKey(cfg);
        // Pair --hostname with --to in order of appearance.
        const pairs = pairHostnameTo(opts.hostname, opts.to);
        if (pairs.size === 0) {
            process.stderr.write(red("✗ At least one --hostname X --to PORT pair required.\n"));
            process.exit(1);
        }
        for (const [h, t] of pairs) {
            process.stdout.write(`  → ${h}.on.route6.me  →  ${t}\n`);
        }
        const tc = new TunnelClient({
            onFrame: async (frame) => { await fwd.handlerForTunnel(frame); },
            onSession: (sid) => process.stdout.write(green(`✓ tunnel session: ${sid}\n`)),
        });
        const fwd = new Forwarder({ tunnel: tc, hostnameToTarget: pairs });

        // MCP proxy (default on, --no-mcp disables)
        let mcp: McpProxy | null = null;
        if (opts.mcp) {
            mcp = new McpProxy({ port: parseInt(opts.mcpPort, 10) });
            try {
                await mcp.start();
                process.stdout.write(green(`✓ local MCP proxy: http://127.0.0.1:${opts.mcpPort}/mcp\n`));
            } catch (err) {
                process.stderr.write(red(`✗ MCP proxy failed to start: ${(err as Error).message}\n`));
                mcp = null;
            }
        }

        // Graceful shutdown on SIGINT/SIGTERM
        let shuttingDown = false;
        const shutdown = async (sig: string): Promise<void> => {
            if (shuttingDown) return;
            shuttingDown = true;
            process.stdout.write(`\n${sig} received — shutting down…\n`);
            try { await tc.stop(); } catch { /* ignore */ }
            if (mcp) try { await mcp.stop(); } catch { /* ignore */ }
            process.exit(0);
        };
        process.on("SIGINT",  () => { void shutdown("SIGINT"); });
        process.on("SIGTERM", () => { void shutdown("SIGTERM"); });

        // Run forever (reconnects internally on disconnect / network blip)
        await tc.run();
    });

tunnel
    .command("stop")
    .description("Tell a running `route6 tunnel start` daemon to stop (uses ~/.route6/agent.pid).")
    .action(async () => {
        // For Day 15 we run in foreground — `stop` shells out a friendly note.
        // Daemon mode could be added in a follow-up by writing a pid file at
        // tunnel.start time, but most users will just ^C the foreground run.
        process.stdout.write("Press Ctrl+C in the terminal where `route6 tunnel start` is running.\n");
        process.stdout.write("(Background-daemon mode ships in a later release.)\n");
    });

// ---------- mcp serve ----------
program
    .command("mcp")
    .description("MCP-only modes.")
    .command("serve")
    .description("Run only the local MCP proxy (no inbound tunnel) — useful for cloud agents.")
    .option("--port <port>", "localhost port to bind (default 3000)", "3000")
    .action(async (opts: { port: string }) => {
        const cfg = loadConfig();
        requireApiKey(cfg);
        const mcp = new McpProxy({ port: parseInt(opts.port, 10) });
        await mcp.start();
        process.stdout.write(green(`✓ MCP proxy: http://127.0.0.1:${opts.port}/mcp → ${cfg.gateway_url}/mcp\n`));
        process.stdout.write("Configure your editor (Cursor, Claude Code, Cline, etc.) with that URL.\n");
        process.stdout.write("Ctrl+C to stop.\n");
        process.on("SIGINT",  async () => { await mcp.stop(); process.exit(0); });
        process.on("SIGTERM", async () => { await mcp.stop(); process.exit(0); });
        // Hold the event loop open
        await new Promise<void>(() => { /* never resolves */ });
    });

program.parseAsync(process.argv).catch((err) => {
    logger.error({ err: (err as Error).message }, "fatal");
    process.exit(1);
});

// ---------- helpers ----------

function collectPair(value: string, prev: Array<{ name: string; port?: string }>): Array<{ name: string; port?: string }> {
    prev.push({ name: value });
    return prev;
}
function collectTo(value: string, prev: string[]): string[] {
    prev.push(value);
    return prev;
}

function pairHostnameTo(
    hostnames: Array<{ name: string; port?: string }>,
    tos: string[],
): Map<string, string> {
    const out = new Map<string, string>();
    if (hostnames.length === 0) return out;
    if (tos.length === 1 && hostnames.length === 1) {
        out.set(hostnames[0].name, tos[0]);
        return out;
    }
    if (tos.length !== hostnames.length) {
        throw new Error(`--hostname and --to count mismatch (${hostnames.length} hostnames, ${tos.length} targets). Pair them in order.`);
    }
    for (let i = 0; i < hostnames.length; i++) {
        out.set(hostnames[i].name, tos[i]);
    }
    return out;
}

function green(s: string): string { return process.stdout.isTTY ? `\x1b[32m${s}\x1b[0m` : s; }
function red(s: string):   string { return process.stderr.isTTY ? `\x1b[31m${s}\x1b[0m` : s; }
