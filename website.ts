import tls from "node:tls";
import axios from "axios";
import { childLogger } from "../utils/logger.js";

const log = childLogger("website");

export interface WebsiteReport {
  domain: string | null;
  sslValid: boolean | null;
  domainAgeDays: number | null;
  socialLinks: { twitter?: string; telegram?: string; discord?: string };
  hasWhitepaper: boolean;
  copycatOf: string | null; // name of a well-known token this looks like a copy of
}

/** Checks whether `domain` presents a currently-valid TLS certificate.
 * A brand-new scam site often skips TLS entirely or uses a self-signed
 * cert — a cheap but real signal. */
export function checkSSL(domain: string, timeoutMs = 4000): Promise<boolean | null> {
  return new Promise((resolve) => {
    const socket = tls.connect(
      { host: domain, port: 443, servername: domain, timeout: timeoutMs },
      () => {
        const valid = socket.authorized || false;
        socket.end();
        resolve(valid);
      }
    );
    socket.on("error", () => resolve(false));
    socket.on("timeout", () => {
      socket.destroy();
      resolve(null);
    });
  });
}

/** Best-effort WHOIS lookup for domain creation date. WHOIS response
 * formats vary wildly by registrar/TLD, so this is a heuristic regex scan,
 * not a guaranteed parse — returns null when it can't confidently find a
 * date. */
export async function checkDomainAge(domain: string): Promise<number | null> {
  try {
    const whois = await import("whois");
    const raw = await new Promise<string>((resolve, reject) => {
      whois.lookup(domain, (err: Error | null, data: string) => (err ? reject(err) : resolve(data)));
    });

    const match = raw.match(/creat(?:ed|ion date)[^:]*:\s*([0-9]{4}-[0-9]{2}-[0-9]{2})/i);
    if (!match || !match[1]) return null;

    const createdAt = new Date(match[1]);
    if (Number.isNaN(createdAt.getTime())) return null;

    return Math.floor((Date.now() - createdAt.getTime()) / (1000 * 60 * 60 * 24));
  } catch (err) {
    log.warn({ err: (err as Error).message, domain }, "WHOIS lookup failed");
    return null;
  }
}

/** Pulls known social platform links + "whitepaper"/"docs" mentions out of
 * a site's raw HTML via plain regex — deliberately dependency-light rather
 * than pulling in a full HTML parser for what is fundamentally a substring
 * search. */
export async function scanWebsite(url: string): Promise<Omit<WebsiteReport, "domain" | "sslValid" | "domainAgeDays">> {
  try {
    const { data: html } = await axios.get<string>(url, {
      timeout: 6000,
      responseType: "text",
      headers: { "User-Agent": "Mozilla/5.0 (sniper-bot due-diligence)" },
    });

    const twitter = html.match(/https?:\/\/(?:www\.)?(?:x|twitter)\.com\/[A-Za-z0-9_]+/)?.[0];
    const telegram = html.match(/https?:\/\/(?:www\.)?t\.me\/[A-Za-z0-9_]+/)?.[0];
    const discord = html.match(/https?:\/\/(?:www\.)?discord\.(?:gg|com\/invite)\/[A-Za-z0-9_]+/)?.[0];
    const hasWhitepaper = /whitepaper|litepaper|docs\.[a-z]+/i.test(html);

    return {
      socialLinks: { twitter, telegram, discord },
      hasWhitepaper,
      copycatOf: null,
    };
  } catch (err) {
    log.warn({ err: (err as Error).message, url }, "Website scan failed");
    return { socialLinks: {}, hasWhitepaper: false, copycatOf: null };
  }
}

// A short built-in reference list of extremely well-known token names —
// extend via your own watchlist. This is intentionally simple (Levenshtein
// distance on the lowercased name), not a trademark/IP detector.
const WELL_KNOWN_TOKENS = [
  "bonk", "dogwifhat", "wif", "pepe", "shiba inu", "trump", "bome",
  "popcat", "mew", "pnut", "goat", "fartcoin", "moodeng", "chillguy",
];

function levenshtein(a: string, b: string): number {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 0; j <= b.length; j++) dp[0]![j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i]![j] =
        a[i - 1] === b[j - 1]
          ? dp[i - 1]![j - 1]!
          : 1 + Math.min(dp[i - 1]![j]!, dp[i]![j - 1]!, dp[i - 1]![j - 1]!);
    }
  }
  return dp[a.length]![b.length]!;
}

export function detectCopycatName(tokenName: string): string | null {
  const normalized = tokenName.trim().toLowerCase();
  for (const known of WELL_KNOWN_TOKENS) {
    const distance = levenshtein(normalized, known);
    const closeMatch = distance <= 2 && normalized !== known;
    if (closeMatch) return known;
  }
  return null;
}

export async function analyzeWebsite(url: string | null, tokenName: string): Promise<WebsiteReport> {
  const copycatOf = detectCopycatName(tokenName);

  if (!url) {
    return { domain: null, sslValid: null, domainAgeDays: null, socialLinks: {}, hasWhitepaper: false, copycatOf };
  }

  let domain: string | null = null;
  try {
    domain = new URL(url).hostname;
  } catch {
    return { domain: null, sslValid: null, domainAgeDays: null, socialLinks: {}, hasWhitepaper: false, copycatOf };
  }

  const [sslValid, domainAgeDays, scan] = await Promise.all([
    checkSSL(domain),
    checkDomainAge(domain),
    scanWebsite(url),
  ]);

  return { domain, sslValid, domainAgeDays, ...scan, copycatOf };
}
