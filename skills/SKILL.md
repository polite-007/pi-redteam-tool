---
name: redteam-recon
description: Red team reconnaissance tools for OSINT, network discovery, and asset enumeration. Use when gathering intelligence about targets, querying DNS records, searching FOFA/BGP data, or performing passive DNS lookups.
---

# Red Team Reconnaissance Tools

A collection of OSINT and network reconnaissance tools for Pi Coding Agent.

## Available Tools

### FOFA Search (`fofa_search`)
Query FOFA internet asset search engine for hosts, domains, ports, and services.

```bash
# Search by domain
Find nginx servers in China

# Search by IP
Search for all services on 1.2.3.4
```

### FOFA Host (`fofa_host`)
Get detailed host/asset information from FOFA.

### FOFA Stats (`fofa_stats`)
Statistics aggregation: use when you want the *scale and distribution* of a query (total count, top protocols / ports / countries / ASNs / titles) rather than a list of assets. Requires a FOFA Professional plan or above; rate limited to 1 request / 5s.

```bash
# How big is this target, and how is it distributed?
How many assets does example.com have, and what are the top ports?

# Count only, no aggregation
Just count how many nginx servers are in China
```

For full parameters and the aggregation field whitelist, see `skills/fofa-stats/SKILL.md`.

### DNS Lookup (`dns_lookup`)
One tool with two modes. `mode=records` (default) queries DNS records without
external API keys; `mode=passive` pulls passive DNS / certificate transparency
data via crt.sh + SecurityTrails.

```bash
# Query A records
Look up DNS for example.com

# Query MX records
Find mail servers for example.com

# Find subdomains via passive DNS
Find all subdomains of example.com ever resolved

# Reverse-IP via passive DNS
Find domains associated with IP 1.2.3.4
```

See `skills/dns-lookup/SKILL.md` for all record types, passive-mode data sources
and the optional SecurityTrails key.

### Network Lookup (`net_lookup`)
One tool with three modes. `mode=bgp` queries ASN/prefix and classifies
access-vs-infrastructure; `mode=whois` queries RDAP/WHOIS registration (IP and
domain, JPNIC aware); `mode=all` runs both and cross-checks ownership.
`mode=auto` (default) uses `all` for IPs and `whois` for domains.

```bash
# Combined IP attribution (BGP + RDAP)
Who owns 8.8.8.8?

# Routing only
Find AS information for 8.8.8.8

# Registration only
Find who owns example.com
```

See `skills/net-lookup/SKILL.md` for gateway options, field reference and the
combined assessment rules.

### Passive DNS (`dns_lookup` with `mode=passive`)
Historical DNS data via crt.sh + SecurityTrails — covered by the `dns_lookup`
tool above.

### HTTPX Probe (`httpx_probe`)
HTTP probing with ProjectDiscovery httpx.

```bash
# Probe URLs
Check HTTP headers and status for these URLs
```

### WeChat Article (`wx_article`)
Fetch WeChat public account articles.

## Configuration

All configuration is read from `~/.pi/agent/settings.json` (`PI_SETTINGS_PATH`
overrides the path). Credentials are not read from the environment anywhere.

```json
{
  "redteam": {
    "fofa": { "key": "your-key", "baseUrl": "https://fofa.info" },
    "httpx": { "binary": "/path/to/httpx", "proxy": "socks5://127.0.0.1:1080" },
    "dns-lookup": { "securityTrailsKey": "your-securitytrails-key" },
    "net-lookup": {}
  }
}
```

Configuration is grouped by tool under `redteam`: `fofa`, `httpx`,
`dns-lookup`, `net-lookup`. `net-lookup` currently has no options and is a
reserved placeholder.

`fofa.key` is the only required value. When a tool finds it unconfigured it
says so (FOFA tools return `FOFA_NOT_CONFIGURED`) and names the settings file to
edit. If a tool reports "not configured" but you have exported the matching
`REDTEAM_*` variable, that is why: those variables are no longer read.
