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
| [finalize-result](extensions/finalize-result) | `finalize_result` | Persist a raw JSON payload to a local file |

## Installation

```bash
pi install npm:@polite-007/pi-redteam-tool
```

Or from git:

```bash
pi install git:github.com/polite-007/pi-redteam-tool
```

## Configuration

Configure via environment variables or `~/.pi/agent/settings.json`:

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

### Environment Variables

| Variable | Description |
|----------|-------------|
| `REDTEAM_FOFA_KEY` | FOFA API key |
| `REDTEAM_FOFA_EMAIL` | FOFA account email |
| `REDTEAM_FOFA_BASE_URL` | FOFA API base URL (default: https://fofa.info) |
| `REDTEAM_HTTPX_BINARY` | Path to httpx binary |
| `REDTEAM_HTTPX_PROXY` | HTTP proxy for httpx |
| `REDTEAM_PASSIVE_DNS_KEY` | SecurityTrails API key |

**Priority**: Environment variable > settings.json

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
