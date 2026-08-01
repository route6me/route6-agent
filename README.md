# @route6/agent

Installs and runs the [Route6](https://route6.me) client.

Route6 gives an AI agent its own **public IPv6 `/64`**, an MCP endpoint on
`localhost`, and an egress proxy so its traffic leaves from that identity.

This package is a **launcher**. It downloads the `r6me` binary for your platform,
verifies it against the published checksums, and runs it. It implements no
protocol of its own and has **no dependencies**.

```bash
npm install -g @route6/agent
route6 up
route6 status
```

Then point any MCP client at `http://localhost:3000/mcp`.

## Configure

The client reads `~/.r6me/config.toml`:

```bash
mkdir -p ~/.r6me && chmod 700 ~/.r6me
echo 'api_key = "sk_a6_your_key_here"' > ~/.r6me/config.toml
chmod 600 ~/.r6me/config.toml
```

`ROUTE6_API_KEY` in the environment works too. Get a key at
[route6.me](https://route6.me/register) — the free tier needs no card.

## Commands

| Command | |
| --- | --- |
| `route6 up` | connect the daemon |
| `route6 down` | disconnect |
| `route6 status` | transport state, config generation, forwards, MCP endpoint |
| `route6 ssh <name>` | shell on a team-mate over the private mesh (Team plans) |
| `route6 version` | print the client version |
| `route6 upgrade` | re-fetch the current stable binary |

Anything else is passed straight through to the binary.

## How the download works

On first use — not at install time, because `npm install --ignore-scripts` skips
postinstall hooks and this has to behave the same everywhere — the launcher:

1. reads the current version from `https://dl.route6.me/stable`
2. downloads the build matching your OS and architecture
3. downloads `checksums.txt` and **verifies the sha256**, refusing to run
   anything that does not match
4. caches it in `~/.r6me/bin/` so later runs need no network

Environment overrides: `R6ME_VERSION` pins a version, `R6ME_BASE_URL` points at a
different artifact host, `R6ME_STATE_DIR` moves the cache and config.

Prefer not to use npm? `curl -fsSL https://dl.route6.me/install.sh | sh` does the
same thing, and the binaries are published at
[dl.route6.me](https://dl.route6.me/).

## Upgrading from 0.1.x

0.1.x was a thin protocol client with its own `login`, `tunnel` and `mcp serve`
commands. That code is gone — the real client does all of it, better. The old
commands print what to use instead:

- `route6 login` → write `~/.r6me/config.toml` (above)
- `route6 tunnel start` → `route6 up`, then the `port_forward_create` MCP tool
- `route6 mcp serve` → `route6 up` serves MCP as part of running the daemon

Docs: <https://docs.route6.me/quick-start/r6me>
