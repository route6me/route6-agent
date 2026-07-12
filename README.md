# @route6/agent

Thin client for [Route6](https://route6.me) — the agentic AI network. Run it on your laptop or a hosted VM to:

1. Tunnel local ports out to a `*.on.route6.me` public hostname (no Docker, no kernel module, no port-forward dance on your home router).
2. Expose a local MCP proxy at `http://127.0.0.1:3000/mcp` that gives Cursor / Claude Code / Cline / any MCP-aware editor access to all 28 Route6 MCP tools using your account's API key.

Designed for the lite (HTTP gateway) tier. If you already run the `route6me/netid` Docker container (Pro tier), you don't need this.

## Install

```bash
npm install -g @route6/agent
```

Requires Node.js 20 or later. Works on macOS (arm64 / x64), Linux x64, and WSL2.

## Quick start

```bash
# 1. Get an API key from https://route6.me/dashboard (or use one you already have).
route6 login sk_a6_<your-api-key>

# 2. Start anything on a local port, e.g.:
python3 -m http.server 3000 &

# 3. Tunnel it.
route6 tunnel start --hostname my-app --to 3000
```

In another terminal:

```bash
curl https://my-app.on.route6.me/
# → your python http.server's directory listing, served over the public internet.
```

Your MCP proxy is also live at `http://127.0.0.1:3000/mcp` — point your editor at it.

## Commands

| Command | Purpose |
|--------|---------|
| `route6 login <api_key>` | Save the API key to `~/.route6/config.json` (mode 0600) and verify against the gateway. |
| `route6 logout` | Clear the stored API key. |
| `route6 status` | Print config + `GET /whoami` from the gateway. |
| `route6 tunnel start --hostname X --to PORT` | Open the inbound tunnel + start the local MCP proxy. Pair `--hostname` and `--to` repeat-by-repeat for multi-host. |
| `route6 tunnel start --no-mcp …` | Tunnel only, skip the MCP proxy. |
| `route6 tunnel stop` | (Foreground: just Ctrl+C the running `start`.) |
| `route6 mcp serve --port 3000` | MCP-only mode (no inbound tunnel) — useful for hosted agents that just want the local MCP proxy. |

### Multiple hostnames

```bash
route6 tunnel start \
  --hostname my-api  --to 8080 \
  --hostname my-site --to 3000
```

Both arrive at `my-api.on.route6.me` / `my-site.on.route6.me` simultaneously.

## What gets sent where

- Inbound public requests to `<hostname>.on.route6.me` flow `internet → gw.route6.me:443 → tunnel → your localhost`. They never touch any other Route6 customer's host.
- MCP requests to `http://127.0.0.1:3000/mcp` are forwarded to `https://gw.route6.me/mcp` with your API key as Bearer.
- Heartbeats every 30 s keep the tunnel session live. If the network blips, the client reconnects with exponential backoff (1 → 30 s capped) and resumes the same session if it's within the 60 s window — your `*.on.route6.me` URL stays reachable through short disconnects.

## Privacy

- API key never leaves your machine outside the gateway-bound calls.
- We log request metadata (method, path, host, status, byte counts) but never request / response bodies.

## Tier comparison

| | Lite (this client) | Pro (`route6me/netid` container) |
|--|--|--|
| Install | `npm i -g @route6/agent` | `docker compose up` |
| Outbound source IP | Your /64 (preserved via the Route6 edge) | Your /64 directly (in WG tunnel) |
| Inbound to public hostname | via `gw.route6.me` reverse tunnel | direct to your container |
| Mesh between agents | Not in v1 | Native WireGuard |
| Raw TCP/UDP forwarding | Not in v1 (HTTPS only) | Yes |
| MCP tools | All 28 | All 28 |

Switch between tiers any time: `curl -X POST -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' -d '{"type":"http_tunnel"}' https://api.route6.me/api/v1/me/connection-type`

## Links

- **Get an API key / manage your agents:** [route6.me](https://route6.me)
- **Docs:** [docs.route6.me](https://docs.route6.me)
- **Examples** (webhooks, clean-IP fetch, team coordination): [github.com/route6me/examples](https://github.com/route6me/examples)
- **Python client:** [`route6` on PyPI](https://pypi.org/project/route6/) · [source](https://github.com/route6me/route6-python)

## License

MIT © [M3T Projekt d.o.o.](https://route6.me) — the client is open source; the Route6 network service it connects to is a commercial product.
