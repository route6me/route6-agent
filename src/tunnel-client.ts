// Long-lived tunnel client.
//
// Wire: POST /tunnel with `Content-Type: application/json` body `{}`. The
// response is an unbounded stream of newline-delimited JSON frames written
// by the server (session-ack first, then hostname-added/removed, then
// incoming-request frames during normal operation). We read the response
// body line-by-line via the WHATWG ReadableStream the native fetch returns.
//
// Heartbeats are a separate POST /tunnel/heartbeat every 30 s — they don't
// share the long-lived stream, just hit the gateway with the session_id.
//
// Reconnection uses exponential backoff (1/2/4/8/16/30 s) and includes the
// last session_id in `If-Resume` for up to 60 s after the previous
// disconnect, so hostname routes stay bound across short network blips.

import { logger } from "./logger.js";
import { loadConfig, saveConfig } from "./config.js";

const HEARTBEAT_INTERVAL_MS = 30_000;
const RESUME_WINDOW_MS      = 60_000;
const RECONNECT_BACKOFFS_MS = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000];

export type FrameHandler = (frame: TunnelFrame) => void | Promise<void>;

export type TunnelFrame =
    | { type: "session"; session_id: string; gateway_node: string; agent_id: number; hostnames: Array<{ name: string; fqdn: string }>; resumed_from?: string | null; resume_window_seconds?: number; heartbeat_interval_seconds?: number }
    | { type: "hostname-added"; fqdn: string; name?: string }
    | { type: "hostname-removed"; fqdn: string; name?: string }
    | { type: "incoming"; req_id: string; method: string; path: string; headers: Record<string, string>; body_b64: string | null }
    | { type: "replaced"; by_session: string }
    | { type: "evicted"; reason: string }
    | { type: "disconnecting"; reason?: string }
    | { type: string; [k: string]: unknown };

export interface TunnelClientOpts {
    /** Override gateway URL (otherwise from config). Useful for staging. */
    gatewayUrl?: string;
    /** Override API key (otherwise from config). */
    apiKey?: string;
    /** Frame handler — your forwarder, MCP proxy, etc. */
    onFrame: FrameHandler;
    /** Called whenever the live session_id changes (open, replace, resume). */
    onSession?: (sessionId: string) => void;
}

export class TunnelClient {
    private readonly gatewayUrl: string;
    private readonly apiKey: string;
    private readonly onFrame: FrameHandler;
    private readonly onSession?: (sessionId: string) => void;

    private currentSessionId: string | null = null;
    private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
    private reconnectAttempt = 0;
    private shuttingDown = false;
    private abortCtrl: AbortController | null = null;

    constructor(opts: TunnelClientOpts) {
        const cfg = loadConfig();
        this.gatewayUrl = opts.gatewayUrl ?? cfg.gateway_url;
        this.apiKey = opts.apiKey ?? cfg.api_key ?? (() => { throw new Error("Not logged in"); })();
        this.onFrame = opts.onFrame;
        this.onSession = opts.onSession;
    }

    /** Public API for the forwarder — POST /tunnel/response with the reply. */
    async sendResponse(reqId: string, status: number, headers: Record<string, string>, body: Buffer): Promise<void> {
        if (!this.currentSessionId) throw new Error("no live session");
        const res = await fetch(`${this.gatewayUrl}/tunnel/response`, {
            method: "POST",
            headers: { "authorization": `Bearer ${this.apiKey}`, "content-type": "application/json" },
            body: JSON.stringify({
                session_id: this.currentSessionId,
                req_id: reqId,
                status,
                headers,
                body_b64: body.length > 0 ? body.toString("base64") : null,
            }),
            signal: AbortSignal.timeout(15_000),
        });
        if (!res.ok) {
            logger.warn({ req_id: reqId, status: res.status }, "tunnel/response rejected");
        }
    }

    /** Long-running. Returns when the client is stopped via stop(). */
    async run(): Promise<void> {
        while (!this.shuttingDown) {
            try {
                await this.openOnce();
                // openOnce resolves when the stream closes — fall through to backoff
            } catch (err) {
                logger.warn({ err: (err as Error).message }, "tunnel connection error");
            }
            this.stopHeartbeats();
            if (this.shuttingDown) break;
            await this.backoff();
        }
    }

    /** Graceful shutdown — sends /tunnel/disconnect, waits up to 1s, returns. */
    async stop(): Promise<void> {
        this.shuttingDown = true;
        this.stopHeartbeats();
        if (this.currentSessionId) {
            try {
                await fetch(`${this.gatewayUrl}/tunnel/disconnect`, {
                    method: "POST",
                    headers: { "authorization": `Bearer ${this.apiKey}`, "content-type": "application/json" },
                    body: JSON.stringify({ session_id: this.currentSessionId, reason: "client_shutdown" }),
                    signal: AbortSignal.timeout(2_000),
                });
            } catch { /* shutdown anyway */ }
        }
        if (this.abortCtrl) { try { this.abortCtrl.abort(); } catch { /* ignore */ } }
        // Give in-flight POSTs a tiny moment to flush
        await new Promise<void>((r) => setTimeout(r, 200));
    }

    // ---------- internals ----------

    private async openOnce(): Promise<void> {
        const cfg = loadConfig();
        const headers: Record<string, string> = {
            "authorization": `Bearer ${this.apiKey}`,
            "content-type": "application/json",
            "user-agent": `@route6/agent/0.1.0 node/${process.versions.node}`,
        };
        if (cfg.last_session_id && cfg.last_session_at &&
            (Date.now() - cfg.last_session_at) < RESUME_WINDOW_MS) {
            headers["if-resume"] = cfg.last_session_id;
        }

        this.abortCtrl = new AbortController();
        const res = await fetch(`${this.gatewayUrl}/tunnel`, {
            method: "POST",
            headers,
            body: "{}",
            signal: this.abortCtrl.signal,
        });
        if (res.status === 409) {
            // tier_mismatch — fatal; don't keep trying.
            const body = await res.text();
            this.shuttingDown = true;
            throw new Error(`gateway 409: ${body}`);
        }
        if (res.status === 401) {
            this.shuttingDown = true;
            throw new Error("401 unauthorized — API key invalid or revoked");
        }
        if (!res.ok || !res.body) {
            throw new Error(`/tunnel returned HTTP ${res.status}`);
        }

        logger.info({ status: res.status }, "tunnel open, reading frames");
        this.reconnectAttempt = 0;
        this.startHeartbeats();

        // Read line-by-line. ReadableStream gives us Uint8Array chunks; we
        // buffer until we see a \n boundary, then JSON.parse each line.
        const reader = res.body.getReader();
        const decoder = new TextDecoder("utf-8");
        let buf = "";
        try {
            while (true) {
                const { value, done } = await reader.read();
                if (done) break;
                buf += decoder.decode(value, { stream: true });
                let nl: number;
                while ((nl = buf.indexOf("\n")) >= 0) {
                    const line = buf.slice(0, nl).trim();
                    buf = buf.slice(nl + 1);
                    if (!line) continue;
                    let frame: TunnelFrame;
                    try { frame = JSON.parse(line) as TunnelFrame; }
                    catch (e) { logger.warn({ line: line.slice(0, 120), err: (e as Error).message }, "bad frame"); continue; }
                    await this.handleFrame(frame);
                }
            }
        } finally {
            // Stream closed (server end, our abort, network drop)
            this.persistSession();
        }
    }

    private async handleFrame(frame: TunnelFrame): Promise<void> {
        // TS can't narrow the union past `type` reliably because the fallback
        // branch admits `{ type: string; [k: string]: unknown }`. Cast each
        // known branch via a typed alias.
        switch (frame.type) {
            case "session": {
                const f = frame as Extract<TunnelFrame, { type: "session" }>;
                this.currentSessionId = f.session_id;
                this.persistSession();
                if (this.onSession) this.onSession(f.session_id);
                logger.info({
                    session_id: f.session_id,
                    hostnames: f.hostnames.map(h => h.fqdn),
                    resumed_from: f.resumed_from ?? null,
                }, f.resumed_from ? "tunnel session resumed" : "tunnel session opened");
                break;
            }
            case "hostname-added":
                logger.info({ fqdn: frame.fqdn }, "hostname added to tunnel");
                break;
            case "hostname-removed":
                logger.info({ fqdn: frame.fqdn }, "hostname removed from tunnel");
                break;
            case "replaced":
                logger.warn({ by_session: frame.by_session }, "tunnel replaced by another session — exiting");
                this.shuttingDown = true;
                this.currentSessionId = null;
                if (this.abortCtrl) try { this.abortCtrl.abort(); } catch { /* ignore */ }
                break;
            case "evicted":
                logger.warn({ reason: frame.reason }, "tunnel evicted by gateway");
                break;
            case "disconnecting":
                logger.info({ reason: frame.reason }, "gateway disconnecting");
                break;
            case "incoming":
                // delegated to the host-side handler (forwarder)
                await this.onFrame(frame);
                break;
            default:
                logger.debug({ frame }, "unknown frame type");
        }
    }

    private startHeartbeats(): void {
        this.stopHeartbeats();
        this.heartbeatTimer = setInterval(() => { void this.sendHeartbeat(); }, HEARTBEAT_INTERVAL_MS);
        this.heartbeatTimer.unref?.();
    }

    private stopHeartbeats(): void {
        if (this.heartbeatTimer) { clearInterval(this.heartbeatTimer); this.heartbeatTimer = null; }
    }

    private async sendHeartbeat(): Promise<void> {
        if (!this.currentSessionId) return;
        try {
            await fetch(`${this.gatewayUrl}/tunnel/heartbeat`, {
                method: "POST",
                headers: { "authorization": `Bearer ${this.apiKey}`, "content-type": "application/json" },
                body: JSON.stringify({ session_id: this.currentSessionId }),
                signal: AbortSignal.timeout(10_000),
            });
        } catch (err) {
            logger.warn({ err: (err as Error).message }, "heartbeat failed");
        }
    }

    private async backoff(): Promise<void> {
        const idx = Math.min(this.reconnectAttempt, RECONNECT_BACKOFFS_MS.length - 1);
        const ms = RECONNECT_BACKOFFS_MS[idx];
        this.reconnectAttempt++;
        logger.info({ attempt: this.reconnectAttempt, ms }, "reconnecting after backoff");
        await new Promise<void>((r) => setTimeout(r, ms));
    }

    private persistSession(): void {
        const cfg = loadConfig();
        cfg.last_session_id = this.currentSessionId;
        cfg.last_session_at = this.currentSessionId ? Date.now() : null;
        try { saveConfig(cfg); } catch (err) { logger.warn({ err: (err as Error).message }, "failed to persist session"); }
    }
}
