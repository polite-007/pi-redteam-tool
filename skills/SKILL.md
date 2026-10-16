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
Query DNS records without external API keys.

```bash
# Query A records
Look up DNS for example.com

# Query MX records
Find mail servers for example.com
```

### BGP Lookup (`bgp_lookup`)
Query BGP/ASN information via BGPView API.

```bash
# Lookup AS number
Find AS information for 8.8.8.8
```

### WHOIS/RDAP (`whois_rdap`)
Domain registration lookup via RDAP/WHOIS.

```bash
# Lookup domain registration
Find who owns example.com
```

### Passive DNS (`passive_dns`)
Historical DNS data via crt.sh + SecurityTrails.

```bash
# Find subdomains
Find all subdomains of example.com ever resolved
```

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
    "fofa": { "key": "your-key", "email": "you@example.com", "baseUrl": "https://fofa.info" },
    "httpx": { "binary": "/path/to/httpx", "proxy": "socks5://127.0.0.1:1080" },
    "passiveDns": { "securityTrailsKey": "your-securitytrails-key" }
  }
}
```

`fofa.key` is the only required value. When a tool finds it unconfigured it
says so (FOFA tools return `FOFA_NOT_CONFIGURED`) and names the settings file to
edit. If a tool reports "not configured" but you have exported the matching
`REDTEAM_*` variable, that is why: those variables are no longer read.
