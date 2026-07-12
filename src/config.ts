// Persistent config — `~/.route6/config.json`. World-readable would leak
// the API key on shared machines, so we chmod 0600 on every write.

import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";

const CONFIG_DIR = process.env.ROUTE6_CONFIG_DIR ?? join(homedir(), ".route6");
const CONFIG_PATH = join(CONFIG_DIR, "config.json");

export interface AgentConfig {
    api_key: string | null;
    gateway_url: string;
    api_url: string;
    last_session_id: string | null;
    last_session_at: number | null;
}

const DEFAULT_CONFIG: AgentConfig = {
    api_key: null,
    gateway_url: process.env.ROUTE6_GATEWAY ?? "https://gw.route6.me",
    api_url: process.env.ROUTE6_API ?? "https://api.route6.me",
    last_session_id: null,
    last_session_at: null,
};

export function configPath(): string { return CONFIG_PATH; }

export function loadConfig(): AgentConfig {
    if (!existsSync(CONFIG_PATH)) return { ...DEFAULT_CONFIG };
    try {
        const raw = readFileSync(CONFIG_PATH, "utf-8");
        const parsed = JSON.parse(raw) as Partial<AgentConfig>;
        return { ...DEFAULT_CONFIG, ...parsed };
    } catch (err) {
        throw new Error(`Failed to read config at ${CONFIG_PATH}: ${(err as Error).message}`);
    }
}

export function saveConfig(cfg: AgentConfig): void {
    const dir = dirname(CONFIG_PATH);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + "\n");
    try { chmodSync(CONFIG_PATH, 0o600); } catch { /* Windows / non-POSIX */ }
}

export function requireApiKey(cfg: AgentConfig): string {
    if (!cfg.api_key) {
        throw new Error("Not logged in. Run: route6 login <api_key>");
    }
    return cfg.api_key;
}
