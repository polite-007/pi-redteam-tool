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

Set API keys via environment variables:

```bash
export REDTEAM_FOFA_KEY="your-fofa-key"
export REDTEAM_PASSIVE_DNS_KEY="your-securitytrails-key"
```

Or configure in `~/.pi/agent/settings.json`:

```json
{
  "redteam": {
    "fofa": { "key": "your-key" }
  }
}
```
