// Minimal pino setup. Default level: info. Set ROUTE6_LOG_LEVEL=debug for
// tunnel-frame traces. Pretty printing is opt-in via ROUTE6_LOG_PRETTY=1 to
// keep journald/grep output clean by default.

import pino from "pino";

export const logger = pino({
    level: process.env.ROUTE6_LOG_LEVEL ?? "info",
    transport: process.env.ROUTE6_LOG_PRETTY === "1"
        ? { target: "pino/pretty", options: { translateTime: "HH:MM:ss.l", ignore: "pid,hostname" } }
        : undefined,
    redact: {
        paths: ["*.authorization", "*.cookie", "*.set-cookie", "headers.authorization", "body"],
        censor: "[REDACTED]",
    },
});
