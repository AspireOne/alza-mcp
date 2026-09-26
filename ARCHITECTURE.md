# Architecture

The server is a single-account research adapter around the current Alza.cz storefront. The goal is evidence that an agent can inspect: product identity, complete traversal state, prices with their conditions, and explicit failures. The storefront is an undocumented dependency, so success means validating the response's meaning, not merely receiving HTTP 200.

## Access and recovery

A managed, persistent Patchright Chromium profile is the primary data source. Running headed under Xvfb keeps the same browser mode on the home server and in container checks. Browser, operating-system and network identity still differ from a copied desktop session; copying cookies cannot guarantee trust or prevent a challenge.

The browser executes storefront GET requests and the read-only catalogue filter POST in its own context. Page scripts may perform their normal browser traffic; the adapter exposes no transaction operations. It does not block media or replace Chromium's native user agent.

FlareSolverr is the second provider. It uses a temporary session, can receive scoped Alza cookies, and must independently verify an imported account. Byparr is the final anonymous provider. Its pinned version has no equivalent account-session import contract, so `auth=required` cannot use it. Both are private services, not proxies exposed to MCP clients. Before external recovery starts, the primary browser closes to release memory; its persistent profile is reopened on the next primary operation.

Recovery repeats a read operation through an eligible provider. A 120-second operation deadline includes queueing and cleanup. Provider budgets are capped by the remaining operation time: primary browser 30 seconds, FlareSolverr 50 seconds, Byparr 30 seconds. The browser and solver budgets accommodate full product hydration and account verification on ARM64 home servers. One transient browser request retry shares that deadline. Rate limiting, account mismatch and parser failures are not treated as reasons to hammer another provider. Failed challenge recovery starts a five-minute context-specific cooldown. No human CAPTCHA flow or paid solver is required.

Solvers can return synthetic HTTP 200 and HTML wrappers around JSON. The adapter validates challenge markers and payload schemas instead of treating the solver status as Alza's original HTTP status. Recovery renderers cannot always prove selected filter state or hydrate all lazy product sections. Such limitations are explicit errors or failed sections, never unfiltered successful results.

The dependency versions are fixed in [package-lock.json](package-lock.json), [Dockerfile](Dockerfile) and [compose.yaml](compose.yaml). Upgrade a browser package and its installed binary together; keep provider contract tests and live probes in the same change.

## Identity and state boundaries

A numeric Alza product ID identifies a listing. A product code can appear on new, opened or used listings with different IDs, so code resolution must establish a unique exact match. A canonical product request must return the requested ID before any detail is accepted.

Anonymous and imported-account profiles are separate. Account identity comes from a fresh first-party page's signed-in state and numeric user ID, not from cookie presence. This check also precedes cache hits. Account replacement creates a new generation, which invalidates prior cache and traversal contexts. A filesystem lock prevents two processes from owning the same profiles. Never launch a separate browser against these managed directories. Under the exclusive lease, stale Chromium locks from a replaced container can be removed; a live local browser PID is still rejected.

Session import is an offline administrative action. It validates a temporary profile before replacing the manifest. Filesystem protection matters because Chromium cookies and storage state remain credentials even when the MCP surface is read-only. Whole-profile import is an extraction path, not a promise that encrypted cookies, device-bound tokens or browser fingerprints are portable.

## Completeness and source fidelity

Catalogue results use the filter response's count and paginator rather than guessing a result limit from the first page. Filters are discovered from the page bootstrap and advertised controls. Enum keys, range values, ordering and availability are sent in the storefront's own request format.

Continuation state retains seen product/review identities and the original query, count and account context. Signed tokens reference bounded in-memory traversal state. They are replayable within the state lifetime, but cannot resume after a server restart. Count changes, repeated identities and inconsistent terminal pages produce explicit incomplete results. Offset pagination cannot detect every possible same-count edit; the API therefore never promises snapshot isolation.

Products combine structured data with rendered, lazy-loaded sections. Structured price precision and displayed rounding are both retained, including upstream fractions smaller than one haléř. A listing's membership price is effective only when verified authentication and applied-membership markup agree; advertised conditional offers remain conditional. “Bez členství” is a reference within the current account context, not proof of the anonymous price. Variant-selector options preserve Alza's displayed labels and price differences; a linked numeric product ID is not invented when the selector supplies none. Reviews use the paginated review endpoint, not the SEO sample. Review statistics require context parameters from the actual product page.

Search and product caches last 60 seconds, reviews five minutes, and category data 24 hours. Keys include account generation and provider. Caches are bounded and private to the process; an anonymous operation cannot reuse an account price. This short lifetime reduces repeat traffic without pretending prices are immutable.

## Concurrency, transport and observability

One access queue owns browser activity. It permits eight waiting operations, each waiting at most five seconds. This prevents concurrent navigation or authentication contexts from interfering and makes overload visible as `BUSY`. Shutdown drains active work before releasing the profile lock.

Stdio and HTTP share the same research service. HTTP creates an MCP protocol instance per request and retains shared cancellation controllers for explicitly cancelled request IDs. It validates bearer credentials, Host and Origin, and limits request bodies. A socket disconnect does not implicitly cancel a read that may already be running.

Tool-level validation and upstream failures share the [result contract](src/domain/contracts.ts). Protocol-level malformed JSON and unknown tools remain transport/protocol errors. Text content contains the same complete JSON as structured content, so clients without structured-output rendering do not receive a shortened success story.

Logs record request IDs, providers, durations and failure codes. Raw browser messages, cookies, HTML and imported storage are not logged. Health checks inspect only the local process; recovery and last-failure state are available through `get_session_status`.

The adapters own upstream interpretation; the research service owns traversal and cache context; the access coordinator owns browser/provider lifetimes. Changes should stay at the boundary that owns the failure. Avoid creating a generic scraping framework until another actual source needs one.
