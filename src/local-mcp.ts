// Local MCP proxy.
//
// Exposes http://127.0.0.1:PORT/mcp that transparently forwards every request
// to https://gw.route6.me/mcp with the stored API key as Bearer. Identical
// UX to the WG-container's localhost:3000/mcp: configure Cursor / Claude
// Code / Cline / etc. exactly the same way, regardless of tier.
//
// Both transports the gateway exposes (StreamableHTTP POST + SSE GET) are
// passed straight through — we stream the upstream response body to the
// caller chunk-by-chunk so SSE events arrive in real time and the
// StreamableHTTP session header (Mcp-Session-Id) round-trips correctly.

import http from "node:http";
import { Readable } from "node:stream";
import { logger } from "./logger.js";
import { loadConfig } from "./config.js";

const HOP_BY_HOP: ReadonlySet<string> = new Set([
    "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
    "te", "trailers", "transfer-encoding", "upgrade", "host",
]);

export interface McpProxyOpts {
    /** localhost port to bind on. Default 3000 to match the WG container. */
    port?: number;
    /** Override gateway URL. */
    gatewayUrl?: string;
    /** Override API key. */
    apiKey?: string;
}

export class McpProxy {
    private readonly port: number;
    private readonly gatewayUrl: string;
    private readonly apiKey: string;
    private server: http.Server | null = null;

    constructor(opts: McpProxyOpts = {}) {
        const cfg = loadConfig();
        this.port = opts.port ?? 3000;
        this.gatewayUrl = opts.gatewayUrl ?? cfg.gateway_url;
        this.apiKey = opts.apiKey ?? cfg.api_key ?? (() => { throw new Error("Not logged in"); })();
    }

    async start(): Promise<void> {
        this.server = http.createServer((req, res) => { void this.handle(req, res); });
        await new Promise<void>((resolve, reject) => {
            this.server!.once("error", reject);
            this.server!.listen(this.port, "127.0.0.1", () => resolve());
        });
        logger.info({ url: `http://127.0.0.1:${this.port}/mcp` }, "local MCP proxy listening");
    }

    async stop(): Promise<void> {
        if (!this.server) return;
        await new Promise<void>((resolve) => this.server!.close(() => resolve()));
        this.server = null;
    }

    private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        // Only serve /mcp (and subpaths the SDK uses).
        const url = req.url ?? "/";
        if (!url.startsWith("/mcp")) {
            res.statusCode = 404;
            res.setHeader("content-type", "application/json");
            res.end(JSON.stringify({ error: "not_found", hint: "MCP proxy serves /mcp only" }));
            return;
        }

        const upstreamUrl = `${this.gatewayUrl}${url}`;
        const headers: Record<string, string> = { "authorization": `Bearer ${this.apiKey}` };
        for (const [k, v] of Object.entries(req.headers)) {
            const lk = k.toLowerCase();
            if (HOP_BY_HOP.has(lk)) continue;
            if (lk === "authorization") continue; // we set our own
            if (lk.startsWith(":")) continue;
            if (typeof v === "string") headers[k] = v;
            else if (Array.isArray(v)) headers[k] = v.join(", ");
        }

        // Stream the request body upstream (don't buffer — MCP messages can
        // be large and the SDK uses chunked POSTs for some transports).
        const upstreamInit: RequestInit & { duplex?: string } = {
            method: req.method ?? "POST",
            headers,
            duplex: "half", // required by Node's fetch when body is a stream
        };
        if (req.method !== "GET" && req.method !== "HEAD") {
            upstreamInit.body = Readable.toWeb(req) as unknown as BodyInit;
        }

        let upstreamRes: Response;
        try {
            upstreamRes = await fetch(upstreamUrl, upstreamInit);
        } catch (err) {
            logger.warn({ err: (err as Error).message }, "mcp upstream fetch failed");
            res.statusCode = 502;
            res.setHeader("content-type", "application/json");
            res.end(JSON.stringify({ error: "upstream_unreachable", message: (err as Error).message }));
            return;
        }

        res.statusCode = upstreamRes.status;
        upstreamRes.headers.forEach((v, k) => {
            const lk = k.toLowerCase();
            if (HOP_BY_HOP.has(lk)) return;
            res.setHeader(k, v);
        });

        if (!upstreamRes.body) { res.end(); return; }

        // Stream the upstream body to the caller. For SSE this is essential —
        // events arrive in real time as the gateway pushes them.
        const reader = upstreamRes.body.getReader();
        try {
            while (true) {
                const { value, done } = await reader.read();
                if (done) break;
                if (!res.write(Buffer.from(value))) {
                    await new Promise<void>((r) => res.once("drain", () => r()));
                }
            }
            res.end();
        } catch (err) {
            logger.warn({ err: (err as Error).message }, "mcp stream interrupted");
            try { res.end(); } catch { /* socket may be gone */ }
        }
    }
}
