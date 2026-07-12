// Forwarder — receives `{type:"incoming"}` frames from the tunnel,
// matches the Host header to the customer's local target port, fetches
// localhost:PORT, and ships the response back via tunnel.sendResponse().
//
// Mapping: provided at construction time as `hostnameToPort: Map<fqdn, port>`.
// CLI accepts `--hostname X --to PORT` (repeatable). The fqdn-or-bare-name
// passed on the CLI is normalised here.

import { logger } from "./logger.js";
import type { TunnelClient } from "./tunnel-client.js";

export interface ForwarderArgs {
    tunnel: TunnelClient;
    /** Map<bare-name-or-fqdn, "host:port"|port>. Both `my-app` and
     *  `my-app.on.route6.me` keys are accepted; we normalise to fqdn. */
    hostnameToTarget: Map<string, string>;
}

export class Forwarder {
    private readonly tunnel: TunnelClient;
    private readonly map = new Map<string, URL>(); // normalised fqdn -> origin URL

    constructor(args: ForwarderArgs) {
        this.tunnel = args.tunnel;
        for (const [name, target] of args.hostnameToTarget) {
            this.map.set(toFqdn(name), toOriginUrl(target));
        }
    }

    handlerForTunnel = async (frame: { type: string; [k: string]: unknown }): Promise<void> => {
        if (frame.type !== "incoming") return;
        const incoming = frame as {
            type: "incoming"; req_id: string; method: string; path: string;
            headers: Record<string, string>; body_b64: string | null;
        };
        await this.handleIncoming(incoming);
    };

    private async handleIncoming(frame: {
        req_id: string; method: string; path: string;
        headers: Record<string, string>; body_b64: string | null;
    }): Promise<void> {
        const host = (frame.headers["host"] ?? frame.headers["Host"] ?? "").toLowerCase().split(":")[0];
        const target = this.map.get(host);
        if (!target) {
            logger.warn({ host, req_id: frame.req_id }, "no local target for host");
            await this.tunnel.sendResponse(frame.req_id, 502, { "content-type": "text/plain" },
                Buffer.from(`No local target configured for ${host}\n`));
            return;
        }

        const upstreamUrl = new URL(frame.path, target);
        const body = frame.body_b64 ? Buffer.from(frame.body_b64, "base64") : undefined;

        // Forward the request. Strip headers that don't apply to the local
        // upstream (we keep most — the customer's local app may want to see
        // x-forwarded-for, x-route6-tunnel etc. since we added those upstream).
        const forwardHeaders: Record<string, string> = {};
        for (const [k, v] of Object.entries(frame.headers)) {
            const lk = k.toLowerCase();
            if (lk === "host") continue;            // local app should see its own loopback host
            if (lk === "content-length") continue;  // fetch sets this from body
            forwardHeaders[k] = v;
        }

        const t0 = Date.now();
        try {
            const upstreamRes = await fetch(upstreamUrl, {
                method: frame.method,
                headers: forwardHeaders,
                body,
                signal: AbortSignal.timeout(55_000),
            });
            const respBody = Buffer.from(await upstreamRes.arrayBuffer());
            const respHeaders: Record<string, string> = {};
            upstreamRes.headers.forEach((v, k) => { respHeaders[k] = v; });
            await this.tunnel.sendResponse(frame.req_id, upstreamRes.status, respHeaders, respBody);
            logger.info({
                req_id: frame.req_id,
                method: frame.method, path: frame.path, host,
                upstream: upstreamUrl.origin, status: upstreamRes.status,
                bytes_in: respBody.length,
                ms: Date.now() - t0,
            }, "forwarded");
        } catch (err) {
            const e = err as NodeJS.ErrnoException;
            const reason = e.code === "ECONNREFUSED" ? "local service not reachable"
                : e.code === "ABORT_ERR" || e.name === "AbortError" ? "local service timed out (55s)"
                : e.message;
            logger.warn({ req_id: frame.req_id, host, upstream: upstreamUrl.origin, err: e.message, code: e.code }, "forward failed");
            const body502 = Buffer.from(`502 Bad Gateway\n\n${reason}\n`);
            await this.tunnel.sendResponse(frame.req_id, 502,
                { "content-type": "text/plain", "x-route6-error": reason }, body502);
        }
    }
}

// ---------- helpers ----------

function toFqdn(name: string): string {
    const lower = name.toLowerCase();
    if (lower.endsWith(".on.route6.me")) return lower;
    return `${lower}.on.route6.me`;
}

function toOriginUrl(target: string): URL {
    // Accept bare port (3000), host:port, or full URL.
    if (/^\d+$/.test(target)) return new URL(`http://127.0.0.1:${target}`);
    if (/^[^:/]+:\d+$/.test(target)) return new URL(`http://${target}`);
    if (target.startsWith("http://") || target.startsWith("https://")) return new URL(target);
    throw new Error(`bad --to target: ${target}`);
}
