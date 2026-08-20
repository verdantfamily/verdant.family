/**
 * The tools, tested where they are deterministic.
 *
 * What is checked here is the part that does not depend on a model's judgement: that a capability a
 * deployment lacks is reported as missing rather than faked, that a URL is fetched in the form that
 * actually contains the content, that a search asked for recent results asks for recent results, and
 * that a relationship the API could not confirm comes back as "could not confirm" rather than "no".
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  agenRegistry,
  agenTools,
  inspectUrlTool,
  webSearchTool,
  xAccountPostsTool,
  xFollowsTool,
  type AgenDeps,
  type PortAccount,
  type XPort,
} from "./tools";

function account(over: Partial<PortAccount> = {}): PortAccount {
  return {
    id: "1",
    username: "useagen",
    name: "Agen",
    description: "markets from posts",
    followers: 1_200,
    following: 30,
    posts: 400,
    createdAt: "2026-01-01T00:00:00.000Z",
    verified: false,
    ...over,
  };
}

function port(over: Partial<XPort> = {}): XPort {
  return {
    post: async () => null,
    search: async () => [],
    ...over,
  };
}

function deps(over: Partial<AgenDeps> = {}): AgenDeps {
  return { fetch: globalThis.fetch, x: null, ...over };
}

function html(body: string, type = "text/html"): Response {
  return new Response(body, { status: 200, headers: { "content-type": type } });
}

describe("the catalogue", () => {
  it("registers without duplicate or badly named tools", () => {
    expect(() => agenRegistry()).not.toThrow();
  });

  it("gives every read tool a source category, because that is what generates the routing advice", () => {
    // A tool that forgets its category silently falls into `other`, which routes nowhere — the model
    // is never told when to use it, and the bug looks like a tool that is simply never called.
    const uncategorised = agenTools().filter(
      (tool) => tool.kind === "read" && (tool.category === undefined || tool.category === "other"),
    );
    expect(uncategorised.map((tool) => tool.name)).toEqual([]);
  });

  it("ships exactly one tool that spends money", () => {
    expect(agenTools().filter((tool) => tool.kind === "execute").map((tool) => tool.name)).toEqual([
      "launch_instant",
    ]);
  });
});

describe("degrading when X access is limited", () => {
  it("reports every X tool as unavailable when there is no X access at all", () => {
    const { ready, unavailable } = agenRegistry().usable(deps({ x: null }));

    expect(unavailable.map((entry) => entry.name)).toContain("search_x");
    expect(unavailable.map((entry) => entry.name)).toContain("x_follows");
    expect(unavailable.every((entry) => entry.reason.length > 0)).toBe(true);
    // The market and chain tools do not depend on X and must survive its absence.
    expect(ready.map((tool) => tool.name)).toContain("inspect_token");
  });

  it("keeps the endpoints a restricted plan does have, and reports only the rest", () => {
    // The real shape of the problem: likes and follower lists are gated separately from search, so
    // an all-or-nothing check would throw away working capability.
    const { ready, unavailable } = agenRegistry().usable(
      deps({ x: port({ account: async () => account() }) }),
    );

    const names = ready.map((tool) => tool.name);
    expect(names).toContain("search_x");
    expect(names).toContain("x_account");
    expect(names).not.toContain("x_likers");

    const likers = unavailable.find((entry) => entry.name === "x_likers");
    expect(likers?.reason).toMatch(/does not include that endpoint/i);
  });

  it("needs both the lookup and the timeline before it offers an account's posts", () => {
    // Resolving a handle is the first half of the call. Offering the tool with only the second half
    // configured would produce a tool that always fails on its first step.
    expect(xAccountPostsTool().available(deps({ x: port({ accountPosts: async () => [] }) }))).not.toBe(
      true,
    );
    expect(
      xAccountPostsTool().available(
        deps({ x: port({ account: async () => account(), accountPosts: async () => [] }) }),
      ),
    ).toBe(true);
  });
});

describe("x_follows", () => {
  const both = (verdict: boolean | null): AgenDeps =>
    deps({
      x: port({
        account: async (handle) => account({ id: handle === "a" ? "10" : "20", username: handle }),
        follows: async () => verdict,
      }),
    });

  it("answers plainly when the API could tell", async () => {
    const yes = await xFollowsTool().run({ source: "@a", target: "b" }, both(true));
    expect(yes.text).toMatch(/^Yes: @a follows @b\.$/);

    const no = await xFollowsTool().run({ source: "a", target: "b" }, both(false));
    expect(no.text).toMatch(/^No: @a does not follow @b\.$/);
  });

  it("says it could not tell rather than saying no", async () => {
    // The check walks a capped number of pages, so a very large following list ends inconclusive.
    // Reporting that as "no" is a fabricated fact about a relationship between two real people.
    const unknown = await xFollowsTool().run({ source: "a", target: "b" }, both(null));
    expect(unknown.text).toMatch(/[Cc]ould not determine/);
    expect(unknown.text).toMatch(/Do not guess either way/);
    expect(unknown.text).not.toMatch(/\bNo\b/);
  });

  it("accepts a handle however it was written", async () => {
    const found = await xFollowsTool().run(
      { source: "https://x.com/a", target: "@b" },
      both(true),
    );
    expect(found.text).toContain("@a follows @b");
  });

  it("does not ask whether an account follows itself", async () => {
    const same = await xFollowsTool().run({ source: "@a", target: "A" }, both(true));
    expect(same.text).toBe("Those are the same account.");
  });

  it("says which handle does not exist", async () => {
    const missing = await xFollowsTool().run(
      { source: "a", target: "ghost" },
      deps({
        x: port({
          account: async (handle) => (handle === "a" ? account({ username: "a" }) : null),
          follows: async () => true,
        }),
      }),
    );
    expect(missing.text).toContain("@ghost");
  });
});

describe("inspect_url", () => {
  it("fetches a GitHub file from the host that serves the file", async () => {
    // A blob page is an application shell: the HTML has navigation in it and no code, so reading it
    // returns a menu and the model reports that the file is empty.
    const fetch = vi.fn(async (url: string) => html(`contract Foo {} // ${url}`, "text/plain"));
    await inspectUrlTool().run(
      { url: "https://github.com/verdant/agen/blob/main/src/Foo.sol" },
      deps({ fetch: fetch as unknown as typeof globalThis.fetch }),
    );

    expect(fetch.mock.calls[0]?.[0]).toBe(
      "https://raw.githubusercontent.com/verdant/agen/main/src/Foo.sol",
    );
  });

  it("returns the article and not the chrome around it", async () => {
    const page = html(`
      <html><head>
        <title>The exchange halted withdrawals</title>
        <meta name="description" content="What we know so far.">
        <meta property="article:published_time" content="2026-08-20T09:00:00Z">
      </head><body>
        <nav>Home Markets Login Subscribe</nav>
        <script>tracker("pageview")</script>
        <article><p>Withdrawals were suspended at 09:00 UTC.</p><p>No cause was given.</p></article>
        <footer>Cookie preferences</footer>
      </body></html>
    `);

    const outcome = await inspectUrlTool().run(
      { url: "https://example.com/story" },
      deps({ fetch: (async () => page) as unknown as typeof globalThis.fetch }),
    );

    expect(outcome.text).toContain("title: The exchange halted withdrawals");
    expect(outcome.text).toContain("published: 2026-08-20T09:00:00Z");
    expect(outcome.text).toContain("Withdrawals were suspended at 09:00 UTC.");
    // Boilerplate flattened into prose is indistinguishable from prose, and a model handed a cookie
    // notice will summarise the cookie notice.
    expect(outcome.text).not.toContain("Cookie preferences");
    expect(outcome.text).not.toContain("Subscribe");
    expect(outcome.text).not.toContain("tracker");
  });

  /**
   * The weakest reply in the acceptance run came from here.
   *
   * Asked to summarise a docs hub, Agen answered with the hub's own menu — "core concepts, guides,
   * SDKs, deployments, audits" — which is accurate, reads like an answer, and is worth nothing. The
   * tool had handed it forty link labels and no prose, so a summary of the navigation was the only
   * summary available.
   */
  const HUB_ENTRIES = [
    // Ordered so the ranking is doing real work: the administrative links come first in the document,
    // and a tool that simply took the first link would open the audit report.
    "Whitepaper",
    "Concepts",
    "Audits",
    "Bug bounty",
    "Governance",
    "Introduction to v4",
    "Hooks",
    "Flash accounting",
    "Dynamic fees",
    "Pools",
    "Swaps",
    "Liquidity",
    "SDKs",
    "Contracts",
    "Deployments",
  ];

  // A factory rather than a constant: a Response body can be read once, so a shared instance is
  // already consumed by the time the second test asks for it.
  const hub = (): Response =>
    html(`
      <html><head><title>Uniswap v4 Documentation</title></head><body>
        <main>
          ${HUB_ENTRIES.map((entry, index) => `<li><a href="/v4/${String(index)}">${entry}</a></li>`).join("")}
        </main>
      </body></html>
    `);

  it("follows a docs hub to a real page instead of handing back its menu", async () => {
    // Asking the model to open one of the links did not work: it summarised the menu anyway, because
    // `summarise this` gives it no question to choose a link with. So the tool chooses.
    const fetch = vi.fn(async (url: string) =>
      url.endsWith("/v4/5")
        ? html(`
            <html><head><title>Introduction to v4</title></head><body>
              <article><p>v4 keeps the swap fee with liquidity providers. A hook may set that fee per
              swap, which is what "dynamic fees" means, and hook fees are accounted separately.</p></article>
            </body></html>
          `)
        : hub(),
    );

    const outcome = await inspectUrlTool().run(
      { url: "https://docs.uniswap.org/contracts/v4/overview" },
      deps({ fetch: fetch as unknown as typeof globalThis.fetch }),
    );

    // The introduction, not the first link in the document — an audit report is a document nobody
    // asking for a summary of a docs hub wanted.
    expect(fetch.mock.calls[1]?.[0]).toBe("https://docs.uniswap.org/v4/5");
    expect(outcome.text).toContain("keeps the swap fee with liquidity providers");
    expect(outcome.text).toContain("Introduction to v4");
    // And it says where the content came from, since it is not the URL it was given.
    expect(outcome.text).toContain("is an index page with no prose of its own");
    expect(outcome.detail).toMatchObject({
      url: "https://docs.uniswap.org/v4/5",
      via: "https://docs.uniswap.org/contracts/v4/overview",
    });
  });

  it("moves to the next entry when the best one is a PDF", async () => {
    /*
     * The live failure this covers. The highest-ranked entry on the Uniswap v4 hub is its whitepaper,
     * the whitepaper is a PDF, and this tool cannot read a PDF — so the first attempt came back as a
     * note, the fallback handed over the menu, and the model summarised the menu, which is the exact
     * reply the whole change exists to stop.
     */
    const fetch = vi.fn(async (url: string) => {
      if (url.endsWith("/v4/5")) return html("%PDF-1.7 …", "application/pdf");
      if (url.endsWith("/v4/1")) {
        return html(`
          <html><head><title>Concepts</title></head><body>
            <article><p>A hook is a contract the pool calls at fixed points in a swap.</p></article>
          </body></html>
        `);
      }
      return hub();
    });

    const outcome = await inspectUrlTool().run(
      { url: "https://docs.uniswap.org/v4" },
      deps({ fetch: fetch as unknown as typeof globalThis.fetch }),
    );

    expect(fetch.mock.calls.map((call) => call[0])).toEqual([
      "https://docs.uniswap.org/v4",
      "https://docs.uniswap.org/v4/5",
      "https://docs.uniswap.org/v4/1",
    ]);
    expect(outcome.text).toContain("A hook is a contract the pool calls");
    expect(outcome.text).not.toContain("cannot read PDF");
  });

  it("hands back the links when the entry it followed turned out to be empty too", async () => {
    // The fallback has to exist: a hub whose pages render entirely in the browser leaves nothing to
    // follow, and inventing a summary of an unreadable page is the one outcome worse than saying so.
    const fetch = vi.fn(async (url: string) =>
      /\/v4\/\d+$/.test(url) ? html("<html><body><main></main></body></html>") : hub(),
    );

    const outcome = await inspectUrlTool().run(
      { url: "https://docs.uniswap.org/contracts/v4/overview" },
      deps({ fetch: fetch as unknown as typeof globalThis.fetch }),
    );

    // Three attempts and then it stops, rather than walking the whole menu.
    expect(fetch.mock.calls).toHaveLength(4);
    expect(outcome.text).toContain("This page is an index");
    expect(outcome.text).toContain("Hooks — https://docs.uniswap.org/v4/6");
  });

  it("does not call an article an index because it cites things", async () => {
    // Prose carries a link every few sentences. The threshold has to sit above that or every
    // well-sourced news story is reported as navigation and its content thrown away.
    const page = html(`
      <html><head><title>The exchange halted withdrawals</title></head><body>
        <article>
          <p>Withdrawals were suspended at 09:00 UTC, according to
          <a href="/a">a statement</a> the exchange published on its status page. The company gave no
          cause and did not say when it expects to resume, though
          <a href="/b">earlier filings</a> had described a custody migration in progress.</p>
          <p>Two market makers said they had been told nothing in advance. A third, quoted by
          <a href="/c">a trade publication</a>, said it had withdrawn its inventory a week ago after
          settlement times began to slip. None of the three would be named.</p>
        </article>
      </body></html>
    `);

    const outcome = await inspectUrlTool().run(
      { url: "https://example.com/story" },
      deps({ fetch: (async () => page) as unknown as typeof globalThis.fetch }),
    );

    expect(outcome.text).not.toContain("index page");
    expect(outcome.text).toContain("Withdrawals were suspended at 09:00 UTC");
  });

  it("says a PDF is a PDF instead of quoting the bytes", async () => {
    const outcome = await inspectUrlTool().run(
      { url: "https://example.com/paper.pdf" },
      deps({
        fetch: (async () => html("%PDF-1.7 …", "application/pdf")) as unknown as typeof globalThis.fetch,
      }),
    );

    expect(outcome.text).toContain("is a PDF");
    expect(outcome.text).toMatch(/cannot read PDF text/i);
  });

  it("hands back JSON as JSON", async () => {
    const outcome = await inspectUrlTool().run(
      { url: "https://example.com/api" },
      deps({
        fetch: (async () => html('{"volume":18}', "application/json")) as unknown as typeof globalThis.fetch,
      }),
    );
    expect(outcome.text).toContain('{"volume":18}');
  });

  it("says when a page blocked it, rather than saying it was empty", async () => {
    const outcome = await inspectUrlTool().run(
      { url: "https://example.com/paywalled" },
      deps({
        fetch: (async () => new Response("no", { status: 403 })) as unknown as typeof globalThis.fetch,
      }),
    );
    expect(outcome.text).toMatch(/403/);
    expect(outcome.text).toMatch(/blocks automated readers/i);
  });

  it("says when a page rendered nothing readable", async () => {
    // A single-page app returns a body with no text in it. "No text" and "the page did not load" are
    // different findings and the model should be able to tell somebody which happened.
    const outcome = await inspectUrlTool().run(
      { url: "https://example.com/app" },
      deps({
        fetch: (async () => html("<html><body><div id=root></div></body></html>")) as unknown as typeof globalThis.fetch,
      }),
    );
    expect(outcome.text).toMatch(/no readable text/i);
  });

  it("refuses anything that is not a public https page", async () => {
    const never = vi.fn();
    const guarded = deps({ fetch: never as unknown as typeof globalThis.fetch });

    expect((await inspectUrlTool().run({ url: "not a url" }, guarded)).text).toBe("That is not a URL.");
    expect((await inspectUrlTool().run({ url: "http://example.com" }, guarded)).text).toBe("Only https URLs.");
    expect((await inspectUrlTool().run({ url: "https://127.0.0.1/admin" }, guarded)).text).toMatch(
      /not reachable/i,
    );
    expect((await inspectUrlTool().run({ url: "https://localhost:3000/api" }, guarded)).text).toMatch(
      /not reachable/i,
    );
    expect(never).not.toHaveBeenCalled();
  });
});

describe("web_search", () => {
  beforeEach(() => {
    process.env.BRAVE_SEARCH_API_KEY = "brave-test";
  });

  function searchWith(body: unknown): { readonly fetch: ReturnType<typeof vi.fn>; readonly deps: AgenDeps } {
    const fetch = vi.fn(async () => html(JSON.stringify(body), "application/json"));
    return { fetch, deps: deps({ fetch: fetch as unknown as typeof globalThis.fetch }) };
  }

  it("asks the search engine for recent pages when recency was requested", async () => {
    const { fetch, deps: given } = searchWith({ web: { results: [{ title: "t", url: "u", description: "d" }] } });
    await webSearchTool().run({ query: "exchange outage", recency: "day" }, given);

    const url = new URL(String(fetch.mock.calls[0]?.[0]));
    expect(url.searchParams.get("freshness")).toBe("pd");
    expect(url.searchParams.get("q")).toBe("exchange outage");
  });

  it("does not constrain freshness when none was asked for", async () => {
    const { fetch, deps: given } = searchWith({ web: { results: [{ title: "t", url: "u" }] } });
    await webSearchTool().run({ query: "how tcp works" }, given);

    expect(new URL(String(fetch.mock.calls[0]?.[0])).searchParams.has("freshness")).toBe(false);
  });

  it("keeps the publication date next to each result", async () => {
    // Without it a story from this morning and one from last year read identically, and the model
    // presents both as current.
    const { deps: given } = searchWith({
      web: { results: [{ title: "Halt confirmed", url: "https://r.com/a", description: "…", age: "2 hours ago" }] },
    });

    const outcome = await webSearchTool().run({ query: "halt" }, given);
    expect(outcome.text).toContain("Halt confirmed — 2 hours ago");
  });

  it("tells the model that a fresh search found nothing, and how to widen it", async () => {
    const { deps: given } = searchWith({ web: { results: [] } });
    const outcome = await webSearchTool().run({ query: "nothing", recency: "day" }, given);

    expect(outcome.text).toMatch(/No results published within the last day/);
    expect(outcome.text).toMatch(/recency=any/);
  });

  it("is reported as unavailable, with a reason, when there is no key", () => {
    delete process.env.BRAVE_SEARCH_API_KEY;
    expect(webSearchTool().available(deps())).toMatch(/BRAVE_SEARCH_API_KEY is not set/);
  });
});
