// Checks recommended links before they are shown: dead links (404/410) and
// non-http(s) URLs are dropped; links that cannot be checked are kept and
// marked "unverified".

import type { Resource } from "../types";

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface LinkCheck {
  kept: Resource[];
  dropped: { url: string; reason: string }[];
}

export function isWebUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return (u.protocol === "https:" || u.protocol === "http:") && !!u.hostname;
  } catch {
    return false;
  }
}

/**
 * Link-local and cloud metadata addresses (169.254.0.0/16, fe80::/10,
 * metadata.google.internal) are never learning resources, and the link
 * check must not send requests there.
 */
export function isMetadataHost(url: string): boolean {
  try {
    const h = new URL(url).hostname.toLowerCase().replace(/^\[|\]$/g, "");
    return /^169\.254\.\d{1,3}\.\d{1,3}$/.test(h) || /^fe[89ab][0-9a-f]:/.test(h) || h === "metadata.google.internal" || h === "metadata";
  } catch {
    return false;
  }
}

async function probe(url: string, fetchImpl: FetchLike, timeoutMs: number): Promise<number | undefined> {
  const attempt = async (method: "HEAD" | "GET") => {
    const res = await fetchImpl(url, {
      method,
      redirect: "follow",
      headers: method === "GET" ? { Range: "bytes=0-0", "User-Agent": "Assistive-link-check" } : { "User-Agent": "Assistive-link-check" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    void res.body?.cancel().catch(() => undefined);
    return res.status;
  };
  let status: number | undefined;
  try {
    status = await attempt("HEAD");
  } catch {
    status = undefined;
  }
  // Some servers refuse HEAD (or fail on it); ask for one byte instead.
  if (status === undefined || status === 405 || status === 403 || status === 501 || status === 400) {
    try {
      return await attempt("GET");
    } catch {
      return undefined;
    }
  }
  return status;
}

export async function checkLinks(
  items: Resource[],
  opts: { verify: boolean; fetchImpl?: FetchLike; timeoutMs?: number } = { verify: true },
): Promise<LinkCheck> {
  const fetchImpl = opts.fetchImpl ?? ((u, i) => fetch(u, i));
  const seen = new Set<string>();
  const dropped: LinkCheck["dropped"] = [];
  const unique: Resource[] = [];
  for (const r of items) {
    const url = r.url.trim();
    if (!isWebUrl(url)) {
      dropped.push({ url, reason: "not an http(s) URL" });
      continue;
    }
    if (isMetadataHost(url)) {
      dropped.push({ url, reason: "not a public web page" });
      continue;
    }
    if (seen.has(url)) {
      continue;
    }
    seen.add(url);
    unique.push({ ...r, url });
  }
  if (!opts.verify) {
    return { kept: unique.map((r) => ({ ...r, verified: "unverified" as const })), dropped };
  }
  const statuses = await Promise.all(unique.map((r) => probe(r.url, fetchImpl, opts.timeoutMs ?? 4000)));
  const kept: Resource[] = [];
  unique.forEach((r, i) => {
    const s = statuses[i];
    if (s === 404 || s === 410) {
      dropped.push({ url: r.url, reason: `HTTP ${s}` });
    } else {
      kept.push({ ...r, verified: s !== undefined && s >= 200 && s < 400 ? "ok" : "unverified" });
    }
  });
  return { kept, dropped };
}
