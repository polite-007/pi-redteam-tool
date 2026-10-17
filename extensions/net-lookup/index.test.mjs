/**
 * Tests for the net_lookup extension's pure helpers.
 *
 * Run with: `node --test extensions/net-lookup/index.test.mjs`
 *
 * No network is touched — RIPEstat, BGPView, Team Cymru, InternetDB, RDAP and
 * JPNIC are all stubbed or bypassed.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import registerNetLookup, {
  assessNetwork,
  buildLookupPlan,
  classifyBgpUsage,
  cymruQueryName,
  normalizeGateway,
  normalizeMode,
  parseCymruAsn,
  parseCymruOrigin,
  parseInternetDb,
  parseJpnicWhois,
  parseVcard,
  prefixLengthFromCidr,
  rirFromSource,
  resolveHost,
  resolveIp,
  summarizeBgpView,
  summarizeRdap,
  summarizeRipestat,
} from "./index.ts";

/* ------------------------------------------------------------------ *
 * target parsing
 * ------------------------------------------------------------------ */

test("resolveHost: IPv4, URL, IPv6 and host:port", () => {
  assert.deepEqual(resolveHost("8.8.8.8"), { host: "8.8.8.8", isIp: true });
  assert.deepEqual(resolveHost("https://example.com:8443/path"), {
    host: "example.com",
    isIp: false,
  });
  assert.deepEqual(resolveHost("[2001:db8::1]:443"), {
    host: "2001:db8::1",
    isIp: true,
  });
  assert.deepEqual(resolveHost("example.com/path"), {
    host: "example.com",
    isIp: false,
  });
});

test("resolveIp: IPv4 only", () => {
  assert.equal(resolveIp("1.2.3.4"), "1.2.3.4");
  assert.throws(() => resolveIp("example.com"), /仅支持 IPv4/);
  assert.throws(() => resolveIp("::1"), /仅支持 IPv4/);
});

/* ------------------------------------------------------------------ *
 * mode / gateway normalization
 * ------------------------------------------------------------------ */

test("normalizeMode: defaults to auto and maps rdap aliases to whois", () => {
  assert.equal(normalizeMode(undefined), "auto");
  assert.equal(normalizeMode(""), "auto");
  assert.equal(normalizeMode("AUTO"), "auto");
  assert.equal(normalizeMode("bgp"), "bgp");
  assert.equal(normalizeMode("whois"), "whois");
  assert.equal(normalizeMode("rdap"), "whois");
  assert.equal(normalizeMode("whois-rdap"), "whois");
  assert.equal(normalizeMode("all"), "all");
  assert.equal(normalizeMode("nope"), undefined);
});

test("normalizeGateway: unknown values fall back to auto", () => {
  assert.equal(normalizeGateway("jpnic"), "jpnic");
  assert.equal(normalizeGateway("ARIN"), "arin");
  assert.equal(normalizeGateway("nope"), "auto");
  assert.equal(normalizeGateway(undefined), "auto");
});

/* ------------------------------------------------------------------ *
 * BGP helpers
 * ------------------------------------------------------------------ */

test("prefixLengthFromCidr", () => {
  assert.equal(prefixLengthFromCidr("1.2.3.0/24"), 24);
  assert.equal(prefixLengthFromCidr("1.2.3.4"), undefined);
  assert.equal(prefixLengthFromCidr(undefined), undefined);
});

test("classifyBgpUsage: access, infrastructure, ambiguous and unknown", () => {
  assert.equal(
    classifyBgpUsage({ asnName: "Example Broadband", prefixLen: 24 }).classification,
    "customer_access"
  );
  assert.equal(
    classifyBgpUsage({ asnName: "Example Backbone", prefixLen: 12 }).classification,
    "infrastructure"
  );
  assert.equal(
    classifyBgpUsage({ asnName: "Broadband Backbone", prefixLen: 18 }).classification,
    "transit_or_isp"
  );
  assert.equal(classifyBgpUsage({ prefixLen: 24 }).classification, "unknown");
  assert.equal(classifyBgpUsage({ prefixLen: 20 }).classification, "unknown");
});

test("summarizeBgpView: maps prefix, ASN, RIR and classification", () => {
  const summary = summarizeBgpView("1.2.3.4", {
    data: {
      ip: "1.2.3.4",
      ptr_record: "host.example.jp",
      prefixes: [
        {
          prefix: "1.2.3.0/24",
          asn: { asn: 64500, name: "Example Broadband", country_code: "JP" },
          name: "ACCESS-POOL",
        },
      ],
      rir_allocation: { rir_name: "APNIC", allocation: "1.2.0.0/16" },
    },
  });

  assert.equal(summary.asn, "AS64500");
  assert.equal(summary.asnNumber, 64500);
  assert.equal(summary.prefix, "1.2.3.0/24");
  assert.equal(summary.prefixLen, 24);
  assert.equal(summary.rir, "APNIC");
  assert.equal(summary.classification, "customer_access");
  assert.match(summary.hint, /接入网/);
});

test("summarizeBgpView: empty response is unknown, not a crash", () => {
  const summary = summarizeBgpView("1.2.3.4", {});
  assert.equal(summary.classification, "unknown");
  assert.deepEqual(summary.prefixes, []);
  assert.equal(summary.asn, undefined);
});

/* ------------------------------------------------------------------ *
 * WHOIS / RDAP helpers
 * ------------------------------------------------------------------ */

test("buildLookupPlan: domain, gateway order and IPv4 auto plan", () => {
  const domain = buildLookupPlan("example.com", false, "auto");
  assert.deepEqual(domain.map((s) => s.label), ["rdap.org", "verisign-com"]);

  const jpnic = buildLookupPlan("1.2.3.4", true, "jpnic");
  assert.deepEqual(jpnic.map((s) => s.label), ["jpnic-rdap", "jpnic-whois", "apnic"]);

  const arin = buildLookupPlan("1.2.3.4", true, "arin");
  assert.deepEqual(arin.map((s) => s.label), ["arin", "rdap.org"]);

  const auto = buildLookupPlan("1.2.3.4", true, "auto");
  assert.deepEqual(auto.map((s) => s.label), [
    "rdap.org",
    "jpnic-rdap",
    "apnic",
    "jpnic-whois",
    "arin",
    "ripe",
  ]);
});

test("parseJpnicWhois: extracts network fields and abuse email", () => {
  const parsed = parseJpnicWhois(
    [
      "Network Number: 1.2.3.0/24",
      "Network Name: EXAMPLE-NET",
      "Organization: Example Inc.",
      "Abuse Contact: abuse@example.jp",
      "Allocation Date: 2020-01-01",
    ].join("\n")
  );

  assert.equal(parsed.networkNumber, "1.2.3.0/24");
  assert.equal(parsed.networkName, "EXAMPLE-NET");
  assert.equal(parsed.organization, "Example Inc.");
  assert.equal(parsed.abuseEmail, "abuse@example.jp");
  assert.equal(parsed.name, "EXAMPLE-NET");
  assert.equal(parsed.country, "JP");
});

test("parseVcard and summarizeRdap: registrant and abuse contacts", () => {
  const vcard = parseVcard([
    "vcard",
    [
      ["fn", {}, "text", "Alice"],
      ["org", {}, "text", "Example Inc."],
      ["email", {}, "text", "alice@example.com"],
    ],
  ]);
  assert.deepEqual(vcard, {
    name: "Alice",
    org: "Example Inc.",
    email: "alice@example.com",
  });

  const summary = summarizeRdap({
    objectClassName: "ip network",
    handle: "NET-1-2-3-0-1",
    name: "EXAMPLE-NET",
    country: "JP",
    entities: [
      {
        handle: "REG",
        roles: ["registrant"],
        vcardArray: [
          "vcard",
          [
            ["fn", {}, "text", "Alice"],
            ["org", {}, "text", "Example Inc."],
          ],
        ],
      },
      {
        handle: "ABUSE",
        roles: ["abuse"],
        vcardArray: ["vcard", [["email", {}, "text", "abuse@example.com"]]],
      },
    ],
  });

  assert.equal(summary.registrantName, "Alice");
  assert.equal(summary.abuseEmail, "abuse@example.com");
  assert.equal(summary.name, "EXAMPLE-NET");
});

test("rirFromSource: maps plan labels to RIRs", () => {
  assert.equal(rirFromSource("jpnic-whois"), "APNIC");
  assert.equal(rirFromSource("apnic"), "APNIC");
  assert.equal(rirFromSource("arin"), "ARIN");
  assert.equal(rirFromSource("ripe"), "RIPE");
  assert.equal(rirFromSource("rdap.org"), undefined);
});

/* ------------------------------------------------------------------ *
 * Combined assessment
 * ------------------------------------------------------------------ */

const bgp = (overrides = {}) => ({
  ip: "1.2.3.4",
  classification: "infrastructure",
  asnName: "Example Inc",
  ...overrides,
});
const rdap = (overrides = {}) => ({
  name: "Example Inc",
  registrantName: "Example Inc",
  ...overrides,
});

test("assessNetwork: matching owners are consistent", () => {
  const result = assessNetwork({ bgp: bgp(), rdap: rdap() });
  assert.equal(result.routeOwner, "Example Inc");
  assert.equal(result.networkOwner, "Example Inc");
  assert.equal(result.consistent, true);
  assert.ok(!result.notes.some((n) => /不一致/.test(n)));
});

test("assessNetwork: different owners are flagged", () => {
  const result = assessNetwork({
    bgp: bgp({ asnName: "Cloudflarenet" }),
    rdap: rdap({ name: "Example Inc", registrantName: "Example Inc" }),
  });
  assert.equal(result.consistent, false);
  assert.ok(result.notes.some((n) => /名称不一致/.test(n)));
});

test("assessNetwork: customer_access qualifies attribution", () => {
  const result = assessNetwork({
    bgp: bgp({ classification: "customer_access", asnName: "Example Broadband" }),
    rdap: rdap({ name: "Example Inc", registrantName: "Example Inc" }),
  });
  assert.match(result.hint, /接入网/);
  assert.ok(result.notes.some((n) => /终端使用机构/.test(n)));
});

test("assessNetwork: RIR mismatch and missing sides are reported", () => {
  const result = assessNetwork({
    bgp: bgp({ rir: "APNIC" }),
    rdap: rdap(),
    rdapSource: "arin",
  });
  assert.ok(result.notes.some((n) => /RIR 不一致/.test(n)));

  const onlyBgp = assessNetwork({ bgp });
  assert.ok(onlyBgp.notes.some((n) => /缺少 RDAP/.test(n)));
  assert.equal(onlyBgp.consistent, undefined);

  const onlyRdap = assessNetwork({ rdap });
  assert.ok(onlyRdap.notes.some((n) => /缺少 BGP/.test(n)));
});

/* ------------------------------------------------------------------ *
 * tool registration: argument validation never touches the network
 * ------------------------------------------------------------------ */

function registeredTool() {
  let tool;
  registerNetLookup({ registerTool: (t) => (tool = t) });
  return tool;
}

test("tool: invalid mode, missing target and domain bgp are rejected", async () => {
  const tool = registeredTool();
  assert.equal(tool.name, "net_lookup");

  const missing = await tool.execute("1", {});
  assert.equal(missing.isError, true);

  const badMode = await tool.execute("2", { target: "1.2.3.4", mode: "nope" });
  assert.match(badMode.content[0].text, /不支持的 mode/);

  const domainBgp = await tool.execute("3", { target: "example.com", mode: "bgp" });
  assert.match(domainBgp.content[0].text, /仅支持 IP/);
});

test("tool: all mode rejects domains and raw output", async () => {
  const tool = registeredTool();

  const domain = await tool.execute("1", { target: "example.com", mode: "all" });
  assert.match(domain.content[0].text, /仅支持 IP/);

  const raw = await tool.execute("2", { target: "1.2.3.4", mode: "all", raw: true });
  assert.match(raw.content[0].text, /raw=true/);
});

test("tool: all mode merges routing, RDAP and InternetDB", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  const json = (body, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });

  globalThis.fetch = async (url) => {
    const u = String(url);
    calls.push(u);
    if (u.includes("stat.ripe.net/data/prefix-overview")) {
      return json({
        data: {
          resource: "1.2.3.0/24",
          announced: true,
          asns: [{ asn: 64500, holder: "Example Broadband" }],
          related_prefixes: ["1.2.3.0/24"],
          block: { resource: "1.0.0.0/8" },
        },
      });
    }
    if (u.includes("stat.ripe.net/data/rpki-validation")) {
      return json({
        data: {
          status: "valid",
          validating_roas: [
            { origin: "64500", prefix: "1.2.3.0/24", validity: "valid", max_length: 24 },
          ],
        },
      });
    }
    if (u.includes("internetdb.shodan.io")) {
      return json({
        ip: "1.2.3.4",
        ports: [80, 443],
        hostnames: ["example.com"],
        cpes: [],
        tags: ["cloud"],
        vulns: [],
      });
    }
    if (u.includes("cymru.com")) {
      // Team Cymru is optional enrichment; RIPEstat already answered.
      return json({ Status: 3 });
    }
    return json({
      objectClassName: "ip network",
      handle: "NET-1-2-3-0-1",
      name: "Example Broadband",
      country: "JP",
      startAddress: "1.2.3.0",
      endAddress: "1.2.3.255",
      entities: [
        {
          roles: ["registrant"],
          vcardArray: ["vcard", [["org", {}, "text", "Example Broadband"]]],
        },
      ],
    });
  };

  try {
    const tool = registeredTool();
    const result = await tool.execute("1", { target: "1.2.3.4" }, undefined);

    assert.equal(result.isError, false);
    assert.equal(result.details.lookup, "all");
    assert.equal(result.details.route.source, "ripestat");
    assert.equal(result.details.route.asn, "AS64500");
    assert.equal(result.details.route.classification, "customer_access");
    assert.equal(result.details.route.rpki.status, "valid");
    assert.equal(result.details.registration.name, "Example Broadband");
    assert.deepEqual(result.details.internetdb.ports, [80, 443]);
    assert.deepEqual(result.details.internetdb.tags, ["cloud"]);
    assert.equal(result.details.assessment.consistent, true);
    assert.deepEqual(
      result.details.sources.map((s) => [s.provider, s.ok]),
      [
        ["ripestat", true],
        ["rdap", true],
        ["shodan-internetdb", true],
      ]
    );
    assert.ok(calls.some((u) => u.includes("stat.ripe.net")));
    assert.ok(calls.some((u) => u.includes("internetdb.shodan.io")));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("tool: IPv6 all mode uses RIPEstat and keeps RDAP", async () => {
  const originalFetch = globalThis.fetch;
  const json = (body, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });

  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes("stat.ripe.net/data/prefix-overview")) {
      return json({
        data: {
          resource: "2001:db8::/32",
          announced: true,
          asns: [{ asn: 64500, holder: "Example IPv6" }],
          block: { resource: "2001::/16" },
        },
      });
    }
    if (u.includes("stat.ripe.net/data/rpki-validation")) {
      return json({ data: { status: "valid" } });
    }
    if (u.includes("cymru.com")) return json({ Status: 3 });
    return json({
      objectClassName: "ip network",
      handle: "NET-V6",
      name: "Example IPv6",
      entities: [
        {
          roles: ["registrant"],
          vcardArray: ["vcard", [["org", {}, "text", "Example IPv6"]]],
        },
      ],
    });
  };

  try {
    const tool = registeredTool();
    const result = await tool.execute("1", { target: "2001:db8::1", mode: "all" }, undefined);

    assert.equal(result.isError, false);
    assert.equal(result.details.route.source, "ripestat");
    assert.equal(result.details.route.prefix, "2001:db8::/32");
    assert.equal(result.details.sources[0].provider, "ripestat");
    assert.equal(result.details.sources[2].skipped, true);
    assert.equal(result.details.registration.name, "Example IPv6");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

/* ------------------------------------------------------------------ *
 * routing / InternetDB helpers
 * ------------------------------------------------------------------ */

test("summarizeRipestat: maps prefix, ASN, announced and classification", () => {
  const summary = summarizeRipestat("1.2.3.4", {
    data: {
      resource: "1.2.3.0/24",
      announced: true,
      is_less_specific: false,
      asns: [{ asn: 64500, holder: "Example Broadband" }],
      related_prefixes: ["1.2.3.0/24"],
      block: { resource: "1.0.0.0/8", desc: "Administered by APNIC" },
    },
  });

  assert.equal(summary.asn, "AS64500");
  assert.equal(summary.asnNumber, 64500);
  assert.equal(summary.prefix, "1.2.3.0/24");
  assert.equal(summary.classification, "customer_access");
  assert.equal(summary.source, "ripestat");
  assert.equal(summary.announced, true);
  assert.deepEqual(summary.prefixes, [{ prefix: "1.2.3.0/24" }]);
});

test("cymruQueryName: IPv4 octets and IPv6 nibbles", () => {
  assert.equal(cymruQueryName("8.8.8.8"), "8.8.8.8.origin.asn.cymru.com");
  assert.equal(
    cymruQueryName("2001:db8::1"),
    cymruQueryName("2001:db8:0:0:0:0:0:1")
  );
  assert.match(
    cymruQueryName("2001:db8::1"),
    /^1\.0\.0\.0\..*\.8\.b\.d\.0\.1\.0\.0\.2\.origin6\.asn\.cymru\.com$/
  );
});

test("parseCymruOrigin and parseCymruAsn: split TXT records", () => {
  assert.deepEqual(
    parseCymruOrigin("15169 | 8.8.8.0/24 | US | arin | 2023-12-28"),
    {
      asn: 15169,
      prefix: "8.8.8.0/24",
      country: "US",
      rir: "arin",
      allocated: "2023-12-28",
    }
  );

  assert.deepEqual(
    parseCymruAsn("15169 | US | arin | 2010-07-14 | GOOGLE - Google LLC, US"),
    {
      country: "US",
      rir: "arin",
      allocated: "2010-07-14",
      name: "GOOGLE - Google LLC, US",
    }
  );
});

test("parseInternetDb: normalizes ports and string lists", () => {
  assert.deepEqual(
    parseInternetDb(
      {
        ip: "8.8.8.8",
        ports: [443, 53, 443],
        hostnames: ["dns.google", "dns.google", ""],
        cpes: ["cpe:/a:example"],
        tags: ["cdn"],
        vulns: ["CVE-2024-0001"],
      },
      "8.8.8.8"
    ),
    {
      ip: "8.8.8.8",
      ports: [53, 443],
      hostnames: ["dns.google"],
      cpes: ["cpe:/a:example"],
      tags: ["cdn"],
      vulns: ["CVE-2024-0001"],
    }
  );
  assert.equal(parseInternetDb(null, "1.2.3.4"), null);
});
