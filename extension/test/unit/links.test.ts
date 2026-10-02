import * as assert from "node:assert";
import { checkLinks, isWebUrl } from "../../src/resources/links";
import type { Resource } from "../../src/types";

// Every test injects a fake fetch: nothing here touches the network.

type Reply = number | Error;

interface Call {
  url: string;
  method: string;
  init: RequestInit;
}

/** A scripted fetch. Keys are "METHOD url"; an unscripted request throws (and is recorded in `calls`). */
function makeFetch(script: Record<string, Reply>) {
  const calls: Call[] = [];
  const fetchImpl = async (url: string, init: RequestInit): Promise<Response> => {
    calls.push({ url, method: String(init.method), init });
    const reply = script[`${init.method} ${url}`];
    if (reply === undefined) {
      throw new Error(`unscripted request: ${init.method} ${url}`);
    }
    if (reply instanceof Error) {
      throw reply;
    }
    return new Response(null, { status: reply });
  };
  return { fetchImpl, calls };
}

function resource(url: string, over: Partial<Resource> = {}): Resource {
  return { title: `Title of ${url}`, url, type: "docs", why: "because", ...over };
}

const A = "https://a.example.com/docs";
const B = "https://b.example.com/tutorial";
const C = "https://c.example.com/guide";

const methods = (calls: Call[]) => calls.map((c) => `${c.method} ${c.url}`);

describe("isWebUrl", () => {
  it("accepts http and https URLs", () => {
    for (const u of [
      "https://example.com",
      "http://example.com",
      "https://example.com/path/to/page?q=1&r=2#section",
      "http://localhost:3000/docs",
      "https://sub.domain.example.co.uk/x",
      "HTTPS://EXAMPLE.COM/Path",
      "http://127.0.0.1:8080/",
      "https://user:pw@example.com/",
    ]) {
      assert.strictEqual(isWebUrl(u), true, u);
    }
  });

  it("rejects other schemes", () => {
    for (const u of ["ftp://example.com/file", "file:///etc/passwd", "javascript:alert(1)", "mailto:someone@example.com", "data:text/html,<b>hi</b>", "ws://example.com", "vscode://file/x"]) {
      assert.strictEqual(isWebUrl(u), false, u);
    }
  });

  it("rejects things that are not absolute URLs", () => {
    for (const u of ["", "   ", "example.com", "www.example.com/docs", "/relative/path", "//example.com/x", "not a url", "https://"]) {
      assert.strictEqual(isWebUrl(u), false, JSON.stringify(u));
    }
  });
});

describe("checkLinks: filtering and dedupe", () => {
  it("returns nothing for no input without calling fetch", async () => {
    const { fetchImpl, calls } = makeFetch({});
    assert.deepStrictEqual(await checkLinks([], { verify: true, fetchImpl }), { kept: [], dropped: [] });
    assert.deepStrictEqual(await checkLinks([]), { kept: [], dropped: [] });
    assert.strictEqual(calls.length, 0);
  });

  it("drops non-http(s) URLs with a reason and never fetches them", async () => {
    const { fetchImpl, calls } = makeFetch({ [`HEAD ${A}`]: 200 });
    const out = await checkLinks(
      [resource("ftp://files.example.com/x"), resource(A), resource("javascript:alert(1)"), resource("not a url"), resource("")],
      { verify: true, fetchImpl },
    );
    assert.deepStrictEqual(
      out.kept.map((r) => r.url),
      [A],
    );
    assert.deepStrictEqual(out.dropped, [
      { url: "ftp://files.example.com/x", reason: "not an http(s) URL" },
      { url: "javascript:alert(1)", reason: "not an http(s) URL" },
      { url: "not a url", reason: "not an http(s) URL" },
      { url: "", reason: "not an http(s) URL" },
    ]);
    assert.deepStrictEqual(methods(calls), [`HEAD ${A}`]);
  });

  it("reports the trimmed URL for a dropped entry", async () => {
    const { fetchImpl } = makeFetch({});
    const out = await checkLinks([resource("  ftp://x.example.com/f  ")], { verify: true, fetchImpl });
    assert.deepStrictEqual(out.dropped, [{ url: "ftp://x.example.com/f", reason: "not an http(s) URL" }]);
  });

  it("trims whitespace around kept URLs", async () => {
    const { fetchImpl, calls } = makeFetch({ [`HEAD ${A}`]: 200 });
    const out = await checkLinks([resource(`  ${A}\n`)], { verify: true, fetchImpl });
    assert.strictEqual(out.kept[0].url, A);
    assert.strictEqual(calls[0].url, A);
  });

  it("dedupes identical URLs, keeping the first entry, without listing the repeat as dropped", async () => {
    const { fetchImpl, calls } = makeFetch({ [`HEAD ${A}`]: 200, [`HEAD ${B}`]: 200 });
    const out = await checkLinks(
      [resource(A, { title: "first" }), resource(B), resource(A, { title: "second" }), resource(` ${A} `, { title: "third" })],
      { verify: true, fetchImpl },
    );
    assert.deepStrictEqual(
      out.kept.map((r) => r.title),
      ["first", `Title of ${B}`],
    );
    assert.deepStrictEqual(out.dropped, []);
    assert.deepStrictEqual(methods(calls).sort(), [`HEAD ${A}`, `HEAD ${B}`].sort(), "each unique URL is probed once");
  });

  it("dedupes when not verifying too", async () => {
    const out = await checkLinks([resource(A), resource(A), resource(B)], { verify: false });
    assert.deepStrictEqual(
      out.kept.map((r) => r.url),
      [A, B],
    );
  });

  it("URLs that differ only in a trailing slash or fragment are distinct", async () => {
    const { fetchImpl } = makeFetch({ [`HEAD ${A}`]: 200, [`HEAD ${A}/`]: 200, [`HEAD ${A}#x`]: 200 });
    const out = await checkLinks([resource(A), resource(`${A}/`), resource(`${A}#x`)], { verify: true, fetchImpl });
    assert.strictEqual(out.kept.length, 3);
  });
});

describe("checkLinks: verify = false", () => {
  it("keeps every web URL as 'unverified' and never calls fetch", async () => {
    const fetchImpl = async (): Promise<Response> => {
      throw new Error("fetch must not be called");
    };
    const out = await checkLinks([resource(A), resource(B), resource("ftp://nope.example.com")], { verify: false, fetchImpl });
    assert.deepStrictEqual(
      out.kept.map((r) => [r.url, r.verified]),
      [
        [A, "unverified"],
        [B, "unverified"],
      ],
    );
    assert.deepStrictEqual(out.dropped, [{ url: "ftp://nope.example.com", reason: "not an http(s) URL" }]);
  });

  it("preserves the other resource fields", async () => {
    const r = resource(A, { title: "Docs", type: "tutorial", why: "covers it" });
    const out = await checkLinks([r], { verify: false });
    assert.deepStrictEqual(out.kept, [{ title: "Docs", url: A, type: "tutorial", why: "covers it", verified: "unverified" }]);
  });

  it("does not modify the input resources", async () => {
    const r = resource(`  ${A}  `);
    const copy = { ...r };
    await checkLinks([r], { verify: false });
    assert.deepStrictEqual(r, copy);
    const { fetchImpl } = makeFetch({ [`HEAD ${A}`]: 200 });
    await checkLinks([r], { verify: true, fetchImpl });
    assert.deepStrictEqual(r, copy);
    assert.strictEqual(r.verified, undefined);
  });
});

describe("checkLinks: verification", () => {
  it("a 200 is kept and marked ok, with one HEAD request", async () => {
    const { fetchImpl, calls } = makeFetch({ [`HEAD ${A}`]: 200 });
    const out = await checkLinks([resource(A, { title: "Docs", type: "reference", why: "w" })], { verify: true, fetchImpl });
    assert.deepStrictEqual(out.kept, [{ title: "Docs", url: A, type: "reference", why: "w", verified: "ok" }]);
    assert.deepStrictEqual(out.dropped, []);
    assert.deepStrictEqual(methods(calls), [`HEAD ${A}`]);
  });

  it("other 2xx and 3xx statuses are ok", async () => {
    for (const status of [200, 201, 204, 206, 301, 302, 304]) {
      const { fetchImpl } = makeFetch({ [`HEAD ${A}`]: status });
      const out = await checkLinks([resource(A)], { verify: true, fetchImpl });
      assert.strictEqual(out.kept[0]?.verified, "ok", String(status));
    }
  });

  it("a 404 is dropped with 'HTTP 404'", async () => {
    const { fetchImpl, calls } = makeFetch({ [`HEAD ${A}`]: 404 });
    const out = await checkLinks([resource(A)], { verify: true, fetchImpl });
    assert.deepStrictEqual(out.kept, []);
    assert.deepStrictEqual(out.dropped, [{ url: A, reason: "HTTP 404" }]);
    assert.deepStrictEqual(methods(calls), [`HEAD ${A}`], "no retry for a definite 404");
  });

  it("a 410 is dropped with 'HTTP 410'", async () => {
    const { fetchImpl } = makeFetch({ [`HEAD ${A}`]: 410 });
    const out = await checkLinks([resource(A)], { verify: true, fetchImpl });
    assert.deepStrictEqual(out.kept, []);
    assert.deepStrictEqual(out.dropped, [{ url: A, reason: "HTTP 410" }]);
  });

  it("500, 502, 503 and 429 are kept as unverified (the server may be having a bad moment)", async () => {
    for (const status of [500, 502, 503, 429]) {
      const { fetchImpl, calls } = makeFetch({ [`HEAD ${A}`]: status });
      const out = await checkLinks([resource(A)], { verify: true, fetchImpl });
      assert.deepStrictEqual(out.dropped, [], String(status));
      assert.strictEqual(out.kept.length, 1, String(status));
      assert.strictEqual(out.kept[0].verified, "unverified", String(status));
      assert.strictEqual(calls.length, 1, `${status}: no GET retry`);
    }
  });

  it("401 and 451 are kept as unverified", async () => {
    for (const status of [401, 451]) {
      const { fetchImpl } = makeFetch({ [`HEAD ${A}`]: status });
      const out = await checkLinks([resource(A)], { verify: true, fetchImpl });
      assert.strictEqual(out.kept[0]?.verified, "unverified", String(status));
    }
  });

  it("HEAD requests are sent with follow-redirects, a user agent and a timeout signal, and no Range header", async () => {
    const { fetchImpl, calls } = makeFetch({ [`HEAD ${A}`]: 200 });
    await checkLinks([resource(A)], { verify: true, fetchImpl });
    const init = calls[0].init;
    assert.strictEqual(init.method, "HEAD");
    assert.strictEqual(init.redirect, "follow");
    const headers = init.headers as Record<string, string>;
    assert.strictEqual(headers["User-Agent"], "Assistive-link-check");
    assert.ok(!("Range" in headers));
    assert.ok(init.signal instanceof AbortSignal);
    assert.strictEqual((init.signal as AbortSignal).aborted, false);
  });
});

describe("checkLinks: HEAD refused, GET retried", () => {
  for (const status of [405, 403, 501, 400]) {
    it(`HEAD ${status} is retried with a ranged GET`, async () => {
      const { fetchImpl, calls } = makeFetch({ [`HEAD ${A}`]: status, [`GET ${A}`]: 200 });
      const out = await checkLinks([resource(A)], { verify: true, fetchImpl });
      assert.deepStrictEqual(methods(calls), [`HEAD ${A}`, `GET ${A}`]);
      assert.strictEqual(out.kept[0].verified, "ok");
      assert.deepStrictEqual(out.dropped, []);
    });
  }

  it("the retry is a GET that asks for a single byte", async () => {
    const { fetchImpl, calls } = makeFetch({ [`HEAD ${A}`]: 405, [`GET ${A}`]: 206 });
    const out = await checkLinks([resource(A)], { verify: true, fetchImpl });
    assert.strictEqual(calls.length, 2);
    const get = calls[1].init;
    assert.strictEqual(get.method, "GET");
    assert.strictEqual((get.headers as Record<string, string>).Range, "bytes=0-0");
    assert.strictEqual((get.headers as Record<string, string>)["User-Agent"], "Assistive-link-check");
    assert.strictEqual(get.redirect, "follow");
    assert.ok(get.signal instanceof AbortSignal);
    assert.strictEqual(out.kept[0].verified, "ok");
  });

  it("the GET's status decides: a 404 after HEAD 405 is dropped", async () => {
    const { fetchImpl } = makeFetch({ [`HEAD ${A}`]: 405, [`GET ${A}`]: 404 });
    const out = await checkLinks([resource(A)], { verify: true, fetchImpl });
    assert.deepStrictEqual(out.kept, []);
    assert.deepStrictEqual(out.dropped, [{ url: A, reason: "HTTP 404" }]);
  });

  it("the GET's status decides: 410 after HEAD 403 is dropped", async () => {
    const { fetchImpl } = makeFetch({ [`HEAD ${A}`]: 403, [`GET ${A}`]: 410 });
    const out = await checkLinks([resource(A)], { verify: true, fetchImpl });
    assert.deepStrictEqual(out.dropped, [{ url: A, reason: "HTTP 410" }]);
  });

  it("a 403 that stays 403 on GET is kept as unverified", async () => {
    const { fetchImpl, calls } = makeFetch({ [`HEAD ${A}`]: 403, [`GET ${A}`]: 403 });
    const out = await checkLinks([resource(A)], { verify: true, fetchImpl });
    assert.strictEqual(out.kept[0].verified, "unverified");
    assert.deepStrictEqual(out.dropped, []);
    assert.deepStrictEqual(methods(calls), [`HEAD ${A}`, `GET ${A}`]);
  });

  it("a 405 followed by a GET that fails is kept as unverified", async () => {
    const { fetchImpl, calls } = makeFetch({ [`HEAD ${A}`]: 405, [`GET ${A}`]: new Error("connection reset") });
    const out = await checkLinks([resource(A)], { verify: true, fetchImpl });
    assert.strictEqual(out.kept[0].verified, "unverified");
    assert.deepStrictEqual(out.dropped, []);
    assert.strictEqual(calls[0].method, "HEAD");
    assert.ok(calls.slice(1).every((c) => c.method === "GET"));
  });

  it("a 500 is not retried", async () => {
    const { fetchImpl, calls } = makeFetch({ [`HEAD ${A}`]: 500 });
    await checkLinks([resource(A)], { verify: true, fetchImpl });
    assert.strictEqual(calls.length, 1);
  });
});

describe("checkLinks: network failures", () => {
  it("a HEAD that throws falls back to GET", async () => {
    const { fetchImpl, calls } = makeFetch({ [`HEAD ${A}`]: new TypeError("fetch failed"), [`GET ${A}`]: 200 });
    const out = await checkLinks([resource(A)], { verify: true, fetchImpl });
    assert.deepStrictEqual(methods(calls), [`HEAD ${A}`, `GET ${A}`]);
    assert.strictEqual((calls[1].init.headers as Record<string, string>).Range, "bytes=0-0");
    assert.strictEqual(out.kept[0].verified, "ok");
  });

  it("a HEAD that throws and a GET that says 404 is dropped", async () => {
    const { fetchImpl } = makeFetch({ [`HEAD ${A}`]: new Error("boom"), [`GET ${A}`]: 404 });
    const out = await checkLinks([resource(A)], { verify: true, fetchImpl });
    assert.deepStrictEqual(out.dropped, [{ url: A, reason: "HTTP 404" }]);
  });

  it("both HEAD and GET throwing keeps the link as unverified", async () => {
    const { fetchImpl, calls } = makeFetch({ [`HEAD ${A}`]: new Error("dns"), [`GET ${A}`]: new Error("dns") });
    const out = await checkLinks([resource(A, { title: "Offline docs" })], { verify: true, fetchImpl });
    assert.deepStrictEqual(out.kept, [{ title: "Offline docs", url: A, type: "docs", why: "because", verified: "unverified" }]);
    assert.deepStrictEqual(out.dropped, []);
    assert.deepStrictEqual(methods(calls), [`HEAD ${A}`, `GET ${A}`]);
  });

  it("an unreachable network keeps every link, all unverified", async () => {
    const fetchImpl = async (): Promise<Response> => {
      throw new TypeError("fetch failed");
    };
    const out = await checkLinks([resource(A), resource(B), resource(C)], { verify: true, fetchImpl });
    assert.deepStrictEqual(
      out.kept.map((r) => r.verified),
      ["unverified", "unverified", "unverified"],
    );
    assert.deepStrictEqual(out.dropped, []);
  });

  it("a request that outlives the timeout is aborted and the link is kept as unverified", async () => {
    let aborts = 0;
    const fetchImpl = (_url: string, init: RequestInit): Promise<Response> =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => {
          aborts++;
          reject(new DOMException("timed out", "TimeoutError"));
        });
      });
    const started = Date.now();
    const out = await checkLinks([resource(A)], { verify: true, fetchImpl, timeoutMs: 20 });
    assert.ok(Date.now() - started < 5000, "must not hang");
    assert.strictEqual(out.kept[0].verified, "unverified");
    assert.deepStrictEqual(out.dropped, []);
    assert.ok(aborts >= 1);
  });
});

describe("checkLinks: several links", () => {
  it("classifies each link independently and keeps the input order", async () => {
    const D = "https://d.example.com/gone";
    const E = "https://e.example.com/refuses-head";
    const F = "https://f.example.com/flaky";
    const { fetchImpl } = makeFetch({
      [`HEAD ${A}`]: 200,
      [`HEAD ${B}`]: 404,
      [`HEAD ${C}`]: new Error("offline"),
      [`GET ${C}`]: new Error("offline"),
      [`HEAD ${D}`]: 410,
      [`HEAD ${E}`]: 405,
      [`GET ${E}`]: 200,
      [`HEAD ${F}`]: 503,
    });
    const out = await checkLinks([resource(A), resource(B), resource(C), resource("mailto:x@example.com"), resource(D), resource(E), resource(F)], {
      verify: true,
      fetchImpl,
    });
    assert.deepStrictEqual(
      out.kept.map((r) => [r.url, r.verified]),
      [
        [A, "ok"],
        [C, "unverified"],
        [E, "ok"],
        [F, "unverified"],
      ],
    );
    assert.deepStrictEqual(out.dropped, [
      { url: "mailto:x@example.com", reason: "not an http(s) URL" },
      { url: B, reason: "HTTP 404" },
      { url: D, reason: "HTTP 410" },
    ]);
  });

  it("probes the links concurrently, not one after another", async () => {
    let inFlight = 0;
    let peak = 0;
    const fetchImpl = async (): Promise<Response> => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 15));
      inFlight--;
      return new Response(null, { status: 200 });
    };
    const out = await checkLinks([resource(A), resource(B), resource(C)], { verify: true, fetchImpl });
    assert.strictEqual(out.kept.length, 3);
    assert.strictEqual(peak, 3);
  });

  it("releases the response body of each probe", async () => {
    let cancelled = 0;
    const fetchImpl = async (): Promise<Response> =>
      new Response(
        new ReadableStream({
          cancel() {
            cancelled++;
          },
        }),
        { status: 200 },
      );
    await checkLinks([resource(A), resource(B)], { verify: true, fetchImpl });
    await new Promise((r) => setImmediate(r));
    assert.strictEqual(cancelled, 2);
  });
});
