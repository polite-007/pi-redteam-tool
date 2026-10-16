# pi-redteam-tool

Red team reconnaissance tools for [Pi Coding Agent](https://pi.dev).

## Tools

| Tool | Name | Description |
|------|------|-------------|
| [fofa-search](extensions/fofa-search) | `fofa_search` | FOFA internet asset search |
| [fofa-host](extensions/fofa-host) | `fofa_host` | FOFA host/asset query |
| [fofa-stats](extensions/fofa-stats) | `fofa_stats` | FOFA statistics aggregation (scale & distribution) |
| [wx-article](extensions/wx-article) | `wx_article` | WeChat public article fetcher |
| [bgp-lookup](extensions/bgp-lookup) | `bgp_lookup` | BGP/ASN lookup via BGPView API |
| [dns-lookup](extensions/dns-lookup) | `dns_lookup` | DNS record query (A/AAAA/PTR/NS/MX/TXT/CNAME/SOA/SRV/CAA) |
| [httpx-probe](extensions/httpx-probe) | `httpx_probe` | HTTP probe with ProjectDiscovery httpx |
| [passive-dns](extensions/passive-dns) | `passive_dns` | Passive DNS via crt.sh + SecurityTrails |
| [whois-rdap](extensions/whois-rdap) | `whois_rdap` | WHOIS/RDAP domain registration lookup |

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
      "email": "your-email@example.com",
      "baseUrl": "https://fofa.info"
    },
    "httpx": {
      "binary": "/path/to/httpx",
      "proxy": "socks5://127.0.0.1:1080"
    },
    "passiveDns": {
      "securityTrailsKey": "your-securitytrails-key"
    }
  }
}
```

| Key | Used by | Required | Description |
|-----|---------|----------|-------------|
| `fofa.key` | `fofa_search`, `fofa_host`, `fofa_stats` | yes | FOFA API key; without it the tools report `FOFA_NOT_CONFIGURED` |
| `fofa.email` | FOFA tools | no | FOFA account email |
| `fofa.baseUrl` | FOFA tools | no | FOFA API base URL (default: `https://fofa.info`) |
| `httpx.binary` | `httpx_probe` | no | Path to the httpx binary (default: `httpx` from `PATH`) |
| `httpx.proxy` | `httpx_probe` | no | Proxy passed to httpx (default: none) |
| `passiveDns.securityTrailsKey` | `passive_dns` | no | SecurityTrails key; without it IP lookups fall back to HackerTarget |

The remaining tools (`bgp_lookup`, `dns_lookup`, `whois_rdap`, `wx_article`)
need no configuration.

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
