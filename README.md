# pi-redteam-tool

Red team reconnaissance tools for [Pi Coding Agent](https://pi.dev).

## Tools

| Tool | Name | Description |
|------|------|-------------|
| [fofa-search](extensions/fofa-search) | `fofa_search` | FOFA internet asset search |
| [fofa-host](extensions/fofa-host) | `fofa_host` | FOFA host/asset query |
| [fofa-stats](extensions/fofa-stats) | `fofa_stats` | FOFA statistics aggregation (scale & distribution) |
| [wx-article](extensions/wx-article) | `wx_article` | WeChat public article fetcher |
| [dns-lookup](extensions/dns-lookup) | `dns_lookup` | DNS records (DoH + DNSSEC) + passive DNS (crt.sh/OTX/Wayback) |
| [httpx-probe](extensions/httpx-probe) | `httpx_probe` | HTTP probe with ProjectDiscovery httpx |
| [net-lookup](extensions/net-lookup) | `net_lookup` | RIPEstat/Team Cymru routing + RPKI + RDAP/WHOIS + InternetDB |

## Installation

```bash
pi install npm:@polite-007/pi-redteam-tool
```

Or from git:

```bash
pi install git:github.com/polite-007/pi-redteam-tool
```

## Configuration

All configuration lives in `~/.pi/agent/settings.json`, under the `redteam`
key. Credentials are **not** read from the environment — one source means the
key, proxy or path a tool uses is always the one the file names.

```json
{
  "redteam": {
    "fofa": {
      "key": "your-fofa-api-key",
      "baseUrl": "https://fofa.info"
    },
    "httpx": {
      "binary": "/path/to/httpx",
      "proxy": "socks5://127.0.0.1:1080"
    },
    "dns-lookup": {
      "securityTrailsKey": "your-securitytrails-key",
      "dohServer": "auto"
    },
    "net-lookup": {}
  }
}
```

Configuration is grouped by tool under `redteam`: `fofa`, `httpx`,
`dns-lookup`, `net-lookup`. Keys in the table are relative to `redteam`.

| Key | Used by | Required | Description |
|-----|---------|----------|-------------|
| `fofa.key` | `fofa_search`, `fofa_host`, `fofa_stats` | yes | FOFA API key; without it the tools report `FOFA_NOT_CONFIGURED` |
| `fofa.baseUrl` | FOFA tools | no | FOFA API base URL (default: `https://fofa.info`) |
| `httpx.binary` | `httpx_probe` | no | Path to the httpx binary (default: `httpx` from `PATH`) |
| `httpx.proxy` | `httpx_probe` | no | Proxy passed to httpx (default: none) |
| `dns-lookup.securityTrailsKey` | `dns_lookup` (`mode=passive`) | no | SecurityTrails key; without it IP lookups fall back to HackerTarget |
| `dns-lookup.dohServer` | `dns_lookup` (`transport=doh/auto`) | no | DoH preset or URL (default `auto`: doh.pub → alidns → google → cloudflare) |
| `net-lookup` | `net_lookup` | no | Reserved; no options yet |

The remaining tools (`dns_lookup`, `net_lookup`, `wx_article`) need no
configuration.

The old `redteam.passiveDns` section is no longer read; its key moved to
`redteam.dns-lookup`.

### Environment Variables

| Variable | Description |
|----------|-------------|
| `PI_SETTINGS_PATH` | Path to the settings file (default: `~/.pi/agent/settings.json`) |

`PI_SETTINGS_PATH` is the only variable read anywhere: it *locates* the config
file rather than carrying configuration. `REDTEAM_FOFA_*`, `REDTEAM_HTTPX_*` and
`REDTEAM_PASSIVE_DNS_KEY` are no longer read.

## Usage

After installation, tools are automatically discovered and available to the LLM:

```
User: Find all nginx servers in China using FOFA
Agent: Uses fofa_search tool
```

Or invoke via extension command:

```
/skill:redteam-fofa-guide
```

## Development

```bash
# Clone
git clone https://github.com/polite-007/pi-redteam-tool
cd pi-redteam-tool

# Test single extension
node --test extensions/fofa-search/index.test.mjs

# Test all
node --test extensions/**/*.test.mjs
```

## License

MIT
