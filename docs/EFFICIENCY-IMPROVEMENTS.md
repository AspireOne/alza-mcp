# Efficiency improvements

This is the canonical record of the browser/Docker efficiency investigation: requirements, evidence, experiments, unresolved questions, and the direction for further work. Update the relevant sections as findings change. Deployment and logging instructions belong in the [README](../README.md#configuration-and-local-development); architectural contracts belong in [ARCHITECTURE.md](../ARCHITECTURE.md).

Last reconciled on 2026-10-26 with the production logs, local environment fixes, two-request concurrency, and the Pi/desktop profiling and optimization comparisons below. The logged shopping session used logging commit `f25433f`; it preceded the efficiency changes.

## Goal and constraints

Improve response speed and resource efficiency while preserving the deployed system's reliability and data completeness.

- Keep Alza signed in and preserve the expected account and its pricing context. Long-lived Alza sessions have worked in practice; expiration has not been an observed operational problem for the user.
- Preserve automatic challenge recovery. Manual CAPTCHA clicking or session repair is not an acceptable operating model. A proposed remote browser administration page was rejected as the recovery solution.
- Persist the managed browser's disk state across restarts and container replacements. Do not confuse a selective cookie/storage export with a complete browser profile or a portable machine identity.
- Preserve complete product sections, filters, pagination, identity validation, cancellation, and explicit failures. Faster incomplete results are not an improvement.
- Prefer a simple, reproducible setup with user-specific configuration outside source code.
- Optimize the existing Pi deployment. Moving browser computation to the user's German server through a Tailscale home exit node is deferred.
- Treat RAM pressure as a hypothesis to investigate, not an established primary bottleneck. Correlate resource observations with actual slow requests before changing limits or prioritizing RAM reductions.

The existing Pi deployment is the reliability baseline. The user reports that it has worked very well over an extended period without CAPTCHA interruptions; slow requests are the known issue. Do not start by rebuilding or re-proving that baseline, removing its solvers, or replacing its browser stack.

Theory, source inspection, and focused local experiments should guide changes. A 48-hour deployment pilot can confirm a selected improvement; long-running experiments must not substitute for design work. No longer trial is currently agreed.

## What the subagents investigated

The user authorized GPT-6.1-sol agents at medium reasoning effort. Their work was read-only research and isolated experiments; they did not implement optimizations.

| Investigation | Findings and limits |
| --- | --- |
| Architecture audit | Traced browser ownership, authentication checks, cache access, navigation, hydration, solver fallback, and Docker persistence. Found redundant homepage loads and unnecessary product hydration. Identified invariants that optimizations must preserve. |
| Browser and solver research | Compared dedicated Docker browsers, native/CDP attachment, everyday-browser reuse, and remote-display components. Confirmed that a profile copy cannot reproduce the original machine. Investigated actual automatic solver capabilities and their separate browser ownership. |
| Local readiness experiments | Compared host and Docker navigation, investigated the stalled local page, measured tab creation and warm loads, corrected misleading memory accounting, and tested native browser HTML fetch. Invalid measurements were excluded. |
| Detailed logging design | Prepared timing, challenge/authentication evidence, durable storage, privacy, and request-scoped resource-monitoring recommendations. This was a design proposal; the user subsequently implemented logging independently. Current behavior is described below and in the README. |

Research supported retaining Chromium-native requests. Playwright's API request context shares cookies but uses a different network implementation; it is not equivalent to `fetch` inside Chromium. Broad request interception is also not automatically a performance improvement: Playwright documents that routing disables HTTP caching. See [API request context](https://playwright.dev/docs/api/class-apirequestcontext), [request implementation](https://github.com/microsoft/playwright/blob/v1.64.0/packages/playwright-core/src/server/fetch.ts), and [routing](https://playwright.dev/docs/api/class-page#page-route).

## Production inspection

The deployment runs on a 4 GB Raspberry Pi 5 with Coolify and Cloudflare Tunnel. Inspection connected through Windows PowerShell's `ssh pi5`, because the Windows SSH agent held the keys. Linux-side SSH did not authenticate. Sudo was available during inspection; subsequent connections began rejecting authentication. No deployment settings, services, memory limits, or profiles were changed.

### Retained request evidence

The inspected container was created on 2026-10-24. Its retained application events covered approximately 21:41–21:52 UTC that day. This is a short activity window, not the deployment's full operational history.

| Observation | Result |
| --- | --- |
| Successful primary-browser requests | 23 |
| Successful FlareSolverr requests | 1 |
| Recognized challenge failures | 0 |
| Browser success attempt duration | Minimum 6.2 s; median 8.1 s; maximum 16.2 s |
| Other recorded failures | Browser: one upstream error and two timeouts; FlareSolverr and Byparr: one timeout each |

One recovered request timed out in the primary browser after approximately 30 seconds, then succeeded through FlareSolverr in 42.7 seconds. That is roughly 73 seconds across the attempts, before any queueing or additional cleanup. A timeout followed by solver success does not establish that a CAPTCHA occurred.

The old `access.success` duration measured only the winning provider attempt. It omitted earlier failed attempts and queueing. These historical timings must not be interpreted as complete client-visible durations.

The deployed compiled browser, access coordinator, and research modules matched the local compiled files inspected. Node was 24.22.1 and Patchright 1.64.1. No exact application revision label was available.

### Persistence and authentication

- The account manifest's import timestamp was 2026-09-26. Its managed account profile contained History, Cookies, Preferences, and Local State files. The attempted read-only history count failed, so no visit count was established.
- This confirms retained managed-profile state. The earlier import limitation concerns how desktop state enters that profile: the importer extracts selected Alza cookies/localStorage into a fresh profile and excludes Cloudflare cookies.
- Authentication was configured as `preferred`, allowing explicit anonymous fallback. This needs reconciliation with the required-sign-in goal; observed tool success alone does not prove every result was authenticated.

### Resources

The host reported about 2.6 GB available RAM, low load, and approximately 1.4 GB swap in use. Brief idle samples showed no ongoing swap-in/out activity. Existing swap occupancy alone does not prove a current bottleneck.

The application had a 1.5 GiB memory limit; each solver had a 1 GiB limit. Cgroup counters showed that the application and FlareSolverr had encountered their limits and used swap. Neither recorded an OOM kill or container restart. These observations justify correlation with slow requests, not a conclusion that RAM caused them. The kernel defines `memory.events:max` as occasions when usage was about to exceed the limit; it is not an OOM counter. See [cgroup memory counters](https://docs.kernel.org/admin-guide/cgroup-v2.html#memory-interface-files).

At one idle sample, Docker reported approximately 425 MiB for the application, 42 MiB for FlareSolverr, and 62 MiB for Byparr. These working-set-style figures differ from full cgroup accounting and do not describe peak browsing use.

## Inspection of the logged shopping session

On 2026-10-26, persistent application logs and the three containers' output were copied from the Pi into the Git-ignored `.artifacts/pi5-logs/20261026T031702Z/` directory. Checksums and application JSONL validity were verified; originals remained on the Pi. The snapshot includes a manifest, `analysis.json` with request-level decomposition, and `ANALYSIS.md` with detailed findings. These artifacts are local evidence and are not committed with this document.

The 8,806 application records cover 2026-10-25 17:36 UTC through 2026-10-26 03:16 UTC. Analyze the persistent application records once; container stderr duplicates them. There were 86 completed tool calls:

- 79 successful data calls, all verified signed in, plus three successful local session-status calls.
- Four explicit errors: one `INVALID_INPUT`, two `CATEGORY_ID_MISMATCH`, and one `CATEGORY_NOT_LISTABLE`. Their causes need separate investigation; the logs do not retain enough arguments or redirect context to attribute them conclusively.
- All 82 upstream access attempts used the primary browser. No solver invocation, recognized challenge, anonymous fallback, network retry, timeout, or partial response was recorded. All 215 logged upstream responses were HTTP 200; semantic validation still reports explicit errors independently of HTTP status.

### The largest elapsed-time component was queueing

Up to five tool calls were in flight. Sixty calls waited in the single browser queue, with median wait 29.8 seconds and maximum wait 57.4 seconds. Across 83 data calls, including errors, queueing accounted for 68.9% of summed elapsed call time. Overlapping waits are counted per call; this percentage is not a partition of wall-clock session duration.

| Tool | Calls | Median total duration | Median duration excluding queue wait |
| --- | --- | --- | --- |
| Product detail | 29 | 45.7 s | 12.4 s |
| Search | 34 | 24.2 s | 8.7 s |
| Reviews | 13 | 28.3 s | 6.6 s |

The slowest request took 70.35 seconds: 57.44 seconds waiting, then 12.91 seconds in service/cleanup. Queueing amplifies per-request work; making the client send sequential requests would move the waiting elsewhere without improving throughput.

There were 83 homepage navigations out of 159 page operations. Homepage work consumed 273.2 seconds, and browser preparation took a median 3.27 seconds per access. The browser launched only once. Repeated browser startup was therefore not the cause of these slow calls.

Twenty-nine product hydration operations consumed 161.0 seconds, with median 5.18 seconds. Approximately 98.5 seconds falls outside the nested tab/scroll/section/variant spans. That residual needs finer attribution; it must not be assumed to be removable waiting. Browser JSON calls had median duration 0.34 seconds; tab creation had median duration 0.097 seconds. Six calls reported cache hits, potentially for only part of their result, and still passed through queueing and authentication preflight.

### Container memory pressure occurred, but its latency contribution is unresolved

Host available RAM remained above approximately 1.66 GiB in the samples. Application cgroup usage reached a sampled 1.46 GiB under its 1.5 GiB limit; the limit-event counter increased from zero to 54. Application swap reached approximately 410 MiB. There were no OOM events or OOM kills. Thus container-limit pressure is observed, while whole-host RAM exhaustion is unsupported by these samples.

New limit events appeared around 02:07:54, 02:08:44, and 02:09:55 UTC. Slow queued calls also occurred before those events. Product service-time medians before and after the first recorded event were both approximately 12.4 seconds. This is not a controlled comparison, but does not support treating RAM as the demonstrated primary cause. Ten-second sampling can miss peaks, and request/step snapshots do not contain the full cgroup counters.

The evidence favors reducing redundant authentication navigation and investigating selective hydration first. Evaluate memory-limit changes and bounded concurrency separately, with measurements; increasing parallel browser activity blindly could worsen resource pressure. Preserve the successful unattended access path.

## Local experiments

Experiments used temporary anonymous profiles and test containers, without accessing personal browser state or changing the deployed system. Temporary resources were cleaned up. They establish mechanisms and candidates for improvement, not signed-in production parity.

### Host versus Docker navigation

Both environments used Node 24.22.1, Patchright 1.64.1, and headed Chromium 156.0.8078.4.

| Measurement | Host | Docker |
| --- | --- | --- |
| Main response | HTTP 200 at 156 ms | HTTP 200 at 135 ms |
| DOMContentLoaded | Not reached within 30.5 s | 1,006 ms |
| Full load | Timed out at 30 s | 2,410 ms |
| Final application links | 0 | 87 |
| Recognized `_pageData` | Absent | Present |
| Recognized challenge indicators | None | None |

The host failure was more than waiting for optional images: parsing had not produced useful application content. Changing only `waitUntil` to `domcontentloaded` would not fix that observation.

Network probes found that `www.googleoptimize.com` resolved to `0.0.0.0`/`::` in both environments. IPv4 connections hung on the host but were immediately refused in Docker. Host loopback connections to ports 80/443 also timed out despite no listeners; Docker refused them immediately. The tested CDN origins had matching DNS results and working IPv4 TLS/HTTP paths.

The initial probes suggested a sinkholed script blocking parsing but did not prove causation. CDN root responses did not prove delivery of the actual script resources. A later causal experiment and local environment adaptation resolved the native-host stall; see [Local testing environment](#local-testing-environment).

### Navigation, tab reuse, and useful readiness

Four Docker homepage navigations used one persistent anonymous context and cache, in cold → warm reuse → warm new tab → warm reuse order.

| Navigation | DOMContentLoaded | Full load |
| --- | --- | --- |
| Cold initial tab | 931 ms | 2,199 ms |
| Warm reused tab | 358 ms | 1,163 ms |
| Warm new tab | 429 ms | 1,268 ms |
| Warm reused tab | 287 ms | 1,139 ms |

Browser launch took 720 ms; creating the new tab took 52 ms and closing its predecessor took 9 ms. This small sample suggests avoiding redundant page loads is a larger opportunity than avoiding tab creation alone.

Recognized bootstrap plus application links could be captured before full load: approximately 745 ms cold and 541 ms in the new-tab sample, compared with full-load-plus-capture times of 2,226 ms and 1,292 ms. Reused-tab semantic-readiness timings were discarded because polling could see the previous document before navigation committed. Any implementation must prevent that stale-document race.

Homepage bootstrap readiness does not prove that product sections, filters, or account-sensitive UI are ready. Required readiness must be defined per operation. See [Playwright navigation and hydration](https://playwright.dev/docs/navigations).

### Native browser HTML fetch

After one fresh homepage navigation, two requests used `page.evaluate(fetch(...))` with `credentials: include` and `cache: no-store`. Existing application helpers classified and parsed the returned HTML outside the browser.

| Measurement | Navigation | Fetch 1 | Fetch 2 |
| --- | --- | --- | --- |
| Main HTTP response | 147 ms | 126 ms | 99 ms |
| Full load | 1,858 ms | Not applicable | Not applicable |
| Total transport/read/classification/bootstrap parse | 2,030 ms | 200 ms | 170 ms |

All returned HTTP 200, recognized anonymous identity bootstrap, `Cache-Control: no-cache`, and `CF-Cache-Status: DYNAMIC`. No service-worker controller was present. Response HTML sizes differed; only identity-bootstrap recognition was compared. Returned fetch HTML was not rendered or executed.

An earlier attempt incorrectly called browser `Response.url()` rather than reading `Response.url`; its fetch results were discarded. The corrected results suggest a cheaper fresh identity check for cached/JSON-first operations. Signed-in equivalence, freshness with service workers, and challenge recovery still need verification. It is not a substitute for rendered product hydration.

### Memory accounting correction

Early process-tree RSS sums double-counted shared mappings and were rejected for sizing. Use cgroup/container measurements, retaining their distinction from working-set figures.

A separate blank-browser experiment measured approximately 106 MiB before Chromium and 300 MiB with Chromium idle: roughly 195 MiB additional usage. A later real-page experiment reached approximately 1.35 GiB cgroup peak. These runs had different cache/accounting conditions and must not be treated as a controlled before/after comparison. After-close readings were not fully quiescent. Neither result establishes Pi memory requirements or a production bottleneck.

## Logging: current implementation

The user implemented persistent logging in `f25433f`. Logging is complete as an implementation milestone, rather than pending work from the subagent proposal. Its behavior has been inspected in source, and the shopping-session snapshot above confirms persistent request, step, and memory events in production. The snapshot records image/module identity; it does not establish an exact Git revision label.

For storage, rotation, retrieval, event fields, metric scope, and limitations, use the [README logging documentation](../README.md#configuration-and-local-development). It owns the operational instructions.

One discrepancy remains explicit: the earlier conversation requested resource sampling only during active requests, with no idle polling. The current implementation also samples at startup and every 10 seconds while idle. Record this for reconciliation; documenting it here does not change the implementation or imply acceptance of the difference.

## Local testing environment

A repeatable harness now runs the production Compose stack locally, with required account verification, separate persistent state, generated private credentials, and loopback-only application/solver access. Native execution uses a separate profile and the same solver services. The native listener is explicitly bound to loopback; production's default bind behavior is unchanged. Setup, commands, ports and credential handling belong in [CONTRIBUTING.md](../CONTRIBUTING.md#local-docker-stack).

The local Docker and native profiles were seeded from the production account's saved portable Alza session export. This was a read-only transfer: the running Pi browser/database and services were not changed. Both profiles independently validated the expected account. Exports and account metadata remain private under Git-ignored `.artifacts/`; no account IDs or credentials are stored in this document.

Live HTTP smoke checks passed all six tools in Docker and natively. Every data call verified signed-in authentication; the local status tool intentionally does not verify a session. The smoke mode limits search/review calls to one page each; the original fuller validator and deterministic pagination tests remain available. Actual pinned FlareSolverr access verified the signed-in account, and actual Byparr access verified an anonymous page. No CAPTCHA challenge occurred, so these checks establish service integration rather than guaranteed challenge-solving success.

The signed-in Docker smoke check passed again after container replacement. A subsequent full product read passed with the application limit set to the inspected Pi's 1.5 GiB; the profile was not reimported. Native signed-in access also survived server restart. Persistent local logs and profiles remain separate from production.

A lifecycle check uncovered Patchright's default SIGINT handler forcing exit 130 after browser launch, racing application cleanup. The managed browser now disables that handler so the application owns request draining, browser close, log flushing and lease release. A subprocess test with actual Chromium verifies post-browser cleanup and lock removal; restoring the default handler makes it fail. The complete suite now passes 125 tests.

The native stall was traced to two already-blocked analytics names: `www.googleoptimize.com` and `static.cloudflareinsights.com`. They resolved to `0.0.0.0`/`::`; WSL mirrored networking converted IPv4 connections to a Windows-forwarded localhost path that hung. Temporarily failing the Google Optimize request let parsing proceed, while Cloudflare Insights remained pending. A packet-filter experiment matching destination zero had no effect because the kernel had already normalized the destination; its temporary rules were removed.

The machine-local adaptation maps only names still confirmed as DNS sinkholes to non-forwarded `127.0.0.2`. A guarded boot service checks upstream A/AAAA answers directly, removes mappings for names that become routable, preserves unrelated hosts entries, and leaves hosts unchanged on DNS errors. Windows firewall, global DNS configuration, routing, WSL networking mode and browser flags were not changed. Two fresh native headed runs then completed full load in 2.84 and 2.62 seconds, with recognized bootstrap and no request interception. This preserves existing DNS blocks; it does not repair the underlying WSL bug.

The service start/restart and offline reconciliation tests passed. An actual WSL reboot has not been performed because it would interrupt the user's session. Local evidence and rollback instructions are under `.artifacts/local-environment/`; signed-in smoke reports are under `.artifacts/local-stack/reports/`. These contain machine-local evidence and are not committed.

## Optimization direction and validation

Prioritize changes that remove known extra work while preserving the successful access/recovery architecture:

1. **Attribute latency using the implemented logs.** Correlate end-to-end duration, queueing, provider attempts, navigation, hydration, cache behavior, and resource observations. Distinguish detected challenges from timeouts and cooldowns.
2. **Avoid duplicate homepage navigation.** Fresh target HTML already contains account evidence. Use that evidence where equivalent; retain a fresh verification path for cache-only and JSON-first operations. Do not trust cookie presence or stale retained DOM as proof of current account identity.
3. **Hydrate only required product sections.** Preserve section completeness and cache coverage: a minimally hydrated cached document must not satisfy a later full-detail request incorrectly.
4. **Reuse validated review-statistics context.** Avoid another product navigation when suitable context already exists, while preserving product/account/provider boundaries and response-identity validation.
5. **Evaluate useful readiness and tab reuse separately.** Avoid capturing the previous document or returning before required data loads. Keep full browser rendering where the requested information needs it.
6. **Change memory settings only with evidence.** Correlate limit events, swap activity, available memory, and latency. Do not remove useful browser state, reduce completeness, or raise limits indiscriminately.

Keep automatic solvers and their eligibility rules until a replacement is demonstrated to preserve unattended, signed-in success. Their existing HTTP APIs own separate browsers; neither is a drop-in controller for the primary Patchright tab. A successful solver response does not by itself establish that the primary session was repaired or that subsequent requests will succeed.

Validation must cover expired/wrong-account sessions on cache hits, JSON-first verification, incomplete required content, partial-then-full product cache use, statistics identity/context, challenge recovery, timeouts, cancellation, crashes, and persistence across restart. Local execution is now reproducible through the Docker/native harness above; the remaining environmental check is service behavior after a real WSL reboot.

The existing deployment can serve as the comparison baseline without deploying another baseline stack. If a candidate warrants a 48-hour pilot, use bounded realistic shopping bursts, isolated writable profiles, and signed-in semantic assertions. Report complete shopping-session success, latency, unresolved challenges, recovery recurrence, and resources. Do not count anonymous fallback or human repair as success. A clean 48-hour run is useful confirmation, not proof of long-term CAPTCHA immunity.

## First implementation milestone

The first per-request changes are implemented locally, with concurrency and memory settings unchanged:

- Fresh target pages verify their own account identity instead of first loading the homepage. Cached and JSON-first requests still establish fresh identity once per operation. Preferred-auth fallback and continuation-context protection remain in the access coordinator.
- Product hydration follows a normalized action plan derived from requested sections. Prices-only reads skip detail tabs; specification and download requests conservatively retain both tabs because their data can appear in either. Cache identity includes hydration coverage, preventing narrow captures from being reused as complete full-detail documents.
- Regression coverage includes actual Chromium interactions against an isolated storefront fixture, lazy account verification, expired/wrong-account cache access, JSON-first access, preferred fallback, continuation expiry, deadlines, and automatic challenge recovery. CI explicitly installs the package-matched Chromium for the browser tests.

A focused local Docker comparison used archived baseline `f25433f` and the candidate with separate anonymous profiles. Three sequential calls per version requested prices, repeated prices, then description/specifications/prices:

| Request | Baseline | Candidate |
| --- | --- | --- |
| Cold prices | 9.53 s | 4.44 s |
| Cached prices | 1.83 s | 2.26 s |
| Richer detail | 2.18 s | 5.02 s |
| Total | 13.54 s | 11.72 s |

The cold prices call improved by about 53%. The richer request was cached in the baseline because its first call hydrated everything; the candidate correctly fetched the newly requested sections. This is the deliberate cost of deferring unused work. All requested sections were available, and description/specification/offer hashes matched across the two versions, including the coupon offer. Cached requests still performed rendered identity verification and did not improve in this sample. A full hydrated cache entry can also serve narrower requests; that reuse is covered by the final regression suite.

The six-call comparison is a small anonymous sample, not signed-in Pi performance evidence. Initial cgroup charges differed between runs, so lower candidate memory readings do not establish a reliable savings percentage. Benchmark artifacts are under Git-ignored `.artifacts/efficiency-benchmark/`. The subsequent full-cache-reuse cleanup did not affect this benchmark's narrow-first call sequence.

Validation passed 124 tests, including isolated real-Chromium fixtures, expanded typechecking, the production build, and a dependency audit with zero vulnerabilities. Removing fresh cache authentication temporarily caused the intended regression tests to fail; the mutation was restored. Independent functional and quality reviews found no remaining actionable issues. The final Docker image built successfully; its HTTP health, authorization, tool discovery, local status, missing-account rejection, and headed Chromium display checks passed. No Pi performance benchmark of these changes has been performed; deployment state after the push was not verified during this investigation.

The cheaper native-fetch identity check remains experimental; it was not substituted for rendered identity verification. Navigation still waits for full load, and solver order/budgets, serialization, and memory limits are unchanged. Review-statistics context reuse remains later work. Bounded concurrency is addressed in the comparison below.

The logging commit is a separate completed change. Dependency updates were previously committed in `25f1cdd`; they are background context rather than the optimization outcome.

## Bounded concurrency

The end goal is shorter end-to-end latency for parallel shopping batches while retaining complete requested information, verified account identity, correct per-request products/filters/cursors, cancellation and automatic recovery. Faster partial results do not qualify. Memory-pressure benchmarking is explicitly outside this comparison.

The comparison uses the fixed 12-call workload in [CONTRIBUTING.md](../CONTRIBUTING.md#concurrency-comparison), matching requested data with five client calls in flight. Both admission settings use the same candidate code and separately seeded signed-in profiles. See [ARCHITECTURE.md](../ARCHITECTURE.md#concurrency-transport-and-observability) for ownership, interaction-gate, deadline and shutdown rules.

An initial run with overlapping detail interactions reduced cold-batch duration from 23.3 to 15.7 seconds but returned one incomplete variant section. It was rejected. Offline Patchright testing did not establish a generic background-tab focus defect, and another unrestricted run passed; the precise cause of that first intermittent failure was not proven. The implementation therefore conservatively serializes detail interactions and tab creation while allowing independent navigation/JSON work to overlap. A real-browser regression fixture verifies that a held variant snapshot blocks peer hydration and new-page creation, while peer navigation still proceeds. Recovery waits also remain cancellable without closing another reader's tab.

The guarded local comparison passed all 24 data calls across the two arms, all signed in, with no failed sections:

| Phase | One active read | Two active reads | Reduction |
| --- | --- | --- | --- |
| Cold shopping batch | 24.73 s | 17.68 s | 28.5% |
| Warm shopping batch | 9.28 s | 5.16 s | 44.5% |
| Two review pages | 3.68 s | 2.16 s | 41.4% |
| Total | 37.69 s | 24.99 s | 33.7% |

Product, search and review semantic hashes matched. Category hashes differed; controlled calls without parallel peers showed the same manufacturer members in a different upstream display order, with the other category fields equal. The application preserves that source ordering rather than normalizing its output for the benchmark. This is a small matched sample, not a claim of fixed speedup on other hardware or under arbitrary future storefront changes.

Artifacts retain the rejected run under `.artifacts/concurrency/`, the diagnostic repeat under `.artifacts/concurrency-diagnostic/`, and the guarded comparison and category check under `.artifacts/concurrency-guarded/`. The candidate passes 151 automated tests, typechecking, build and audit. The packaged Docker image also passed two simultaneous full-detail reads with complete variant sections. Before deployment, the Pi's current production image was tested in an isolated operator container with a separately seeded profile: all 12 calls passed, taking 51.54 seconds cold, 18.35 seconds warm and 6.93 seconds for reviews (76.81 seconds total). The live profile and Access gateway were unchanged. Concurrency commit `125c06a` was pushed and automatically deployed by Coolify. The production container was healthy with concurrency 2, and all four inspected compiled module hashes matched the committed implementation. The matching Pi check used an isolated operator container built from that exact deployed image, with a separately seeded account profile; it left the live profile and public Access configuration unchanged.

All 12 target calls passed, with signed-in data and complete requested sections:

| Pi phase | Serial production baseline | Deployed concurrency candidate | Reduction |
| --- | --- | --- | --- |
| Cold shopping batch | 51.54 s | 44.45 s | 13.7% |
| Warm shopping batch | 18.35 s | 10.04 s | 45.3% |
| Two review pages | 6.93 s | 4.72 s | 31.8% |
| Total | 76.81 s | 59.21 s | 22.9% |

Product, review and category hashes matched across the Pi arms. The free-text search returned 24 valid products in both but its hash changed between the original runs. A controlled serial/concurrent recheck on the current candidate returned identical search data; the earlier difference did not reproduce. This does not establish the exact historical source of that hash change. The gateway itself was not benchmarked: the operator check exercised HTTP MCP and browser/provider behavior through a private SSH forward.

A final startup audit found that a caller with little primary budget could shorten a shared launch and fail a healthy follower. Shared startup now owns its fixed launch budget, while each reader bounds its own wait independently. Regression tests cover both a short-budget leader with a healthy follower and shutdown after the sole launch caller cancels. The old deadline coupling fails those tests. The final suite passes 153 tests. The final startup fix was pushed as `66c27a8`; the healthy production container again matched all expected module hashes and advertised concurrency 2. Repeating all 12 calls on that exact final image passed with complete signed-in results: 42.14 seconds cold, 12.77 seconds warm and 4.56 seconds for reviews, totaling 59.47 seconds (22.6% below the original serial baseline). The two successful target totals, 59.21 and 59.47 seconds, support the overall improvement while showing phase-level timing variation. Temporary operator containers and profile volumes are removed after collecting their reports. Target reports, module verification, controlled search data and operator cleanup records are retained under Git-ignored `.artifacts/concurrency/`. No memory-pressure measurements were added to this comparison.

## Pi versus desktop diagnosis

A subsequent diagnostic compared identical headed Docker environments on the desktop (Ryzen 7 7735HS, x86-64) and Pi (four Cortex-A76 cores, ARM64), using Node 24.22.1, Patchright 1.64.1 and Chromium 156.0.8078.4. It profiled two sequential signed-in product reads with API timing hooks and Node CPU profiles. All diagnostic reads retained successful signed-in results and complete variants. Production code and settings were unchanged; the probes used isolated profiles.

| Two profiled product reads | Desktop | Pi |
| --- | --- | --- |
| Total elapsed time | 14.67 s | 32.33 s |
| Detail hydration | 5.72 s | 19.96 s |
| Explicit locator counts within hydration | 2.18 s | 12.11 s |
| Node CPU time, all process threads | 5.41 s | 8.33 s |
| Renderer task duration | 11.31 s | 27.52 s |

These are diagnostic, instrumented timings rather than a replacement for the matched shopping benchmark. Hydration accounts for approximately 81% of the additional elapsed time in these two reads; explicit locator counts alone account for approximately 56%. These percentages locate elapsed time, not removable overhead: implementation experiments moved part of that delay from a removed count into the next click or selector read while Chromium remained busy. Parent/child spans overlap and must not be added. Full-load navigation was approximately 3–4 seconds on both platforms. Browser task duration was 2.43 times higher on the Pi; Node CPU time was 1.54 times higher. Final top-document element counts matched (2,949 and 2,802), and final HTML sizes were almost identical. Initial Pi HTML snapshots were smaller, consistent with more post-load work still pending.

The largest individual gap was the first parameter-tab locator count: 4.08/5.08 seconds on the Pi versus 0.09/0.18 seconds locally. Bringing the page forward was negligible by comparison, and section-readiness waits did not exhaust their five-second limit. Client-minus-server timing in the preceding benchmark was only about 58 ms per call on the Pi versus 19 ms locally, ruling out the SSH forward as the main gap.

Installed Patchright source shows that ordinary counts can deeply describe the document, discover closed shadow roots, resolve handles and issue many browser-control calls. A matching offline fixture of roughly 6,000 elements took 0.96 seconds locally versus 1.70 seconds on the Pi for the read-only hydration sequence, without network traffic or application code. A deep document response was approximately 1.47 MB. This establishes nontrivial DOM-dependent framework overhead, but does not alone explain the much larger live-page delays.

A low-overhead hook on the actual in-process CDP session traced approximately two dozen commands in a first live count. Many simple commands took 100–900 ms while the live page was active, with relatively little Node CPU during those waits. An additional control on the Pi returned the same parameter-tab count of one through an in-page DOM query in 97.5 ms, while the subsequent Patchright locator count took 3,356 ms. A cheap scalar evaluation before a count did not eliminate the count delay. The evidence points to chatty selector machinery interacting with ongoing browser work, rather than a single unconditional sleep. Chromium's inspected `DOM.describeNode` implementation does not explicitly force a style/layout flush; do not claim that as the proven cause.

The Pi reported no application CPU quota, 2.4 GHz operation and no throttling before the probes. Memory-pressure analysis was explicitly excluded. CPU profiles also show HTML parsing and garbage collection as secondary work. Slower requests do not establish CPU or RAM exhaustion.

### Optimization decision and validation

The selected pass reuses parsed HTML within a capture and batches variant-control discovery. It retains the original browser clicks, scrolling, readiness checks, interaction gate and two-request admission limit. Parsed-document ownership follows the [source-fidelity contract](../ARCHITECTURE.md#completeness-and-source-fidelity). Variant tests cover closed shadow roots, re-rendered controls, late groups and changed labels; identity tests reject using an earlier capture to authorize a changed final document.

Direct DOM tab activation with browser-click fallback was also tested. Its full Pi workload took 55.84 seconds versus 57.23 seconds for the simpler selected implementation. Only 0.39 seconds separated their cold phases, where tab activation occurs; the other difference was in unchanged warm/review work. That sample does not justify another interaction path, so the extra mechanism was removed.

The matched comparison used the existing deployed image and an isolated candidate with the compiled application mounted into the same image. Each arm imported a separate profile and called the real research service with the same twelve-call shopping schedule, including five concurrent client calls per shopping batch. These timings exclude MCP transport and the public Cloudflare gateway. Both arms retained concurrency 2 and the same container limits.

| Pi workload | Existing implementation | Selected implementation | Deployed-image repeat |
| --- | --- | --- | --- |
| Cold shopping batch | 44.39 s | 39.05 s | 38.65 s |
| Warm shopping batch | 13.84 s | 13.19 s | 11.57 s |
| Two review pages | 5.34 s | 4.99 s | 4.41 s |
| Total | 63.58 s | 57.23 s | 54.64 s |

All twelve selected calls succeeded while signed in. Every product section, category search, category details and review result matched the baseline semantically. The free-text search supplied a changed first-page membership in the later arm; repeating it with the unchanged deployed implementation returned exactly the same current results, confirming upstream variation. The measured total improvement is approximately 10–14% across the two selected runs, not a promise of that reduction for every request. Broader claims that most hydration time can simply be removed are unsupported.

Validation covers 158 automated tests, typechecking, build, and signed-in MCP smoke checks in Docker and on the native host. Mutation checks confirm that stale final identity verification and incomplete variant snapshots are rejected. Commit `2d6e6ad` passed [GitHub CI](https://github.com/AspireOne/alza-mcp/actions/runs/40311156305) and deployed successfully: the healthy production container matched all eight changed runtime module hashes. The repeat used that exact image with an isolated profile; all twelve results matched the selected candidate semantically. Temporary operator containers, volumes and files were removed after collecting reports. A local Docker smoke run also encountered a real challenge before product hydration and recovered through FlareSolverr while retaining signed-in results; this is evidence for the retained recovery path, not a long-term CAPTCHA frequency estimate.

Diagnostic source probes and CPU profiles remain under Git-ignored `.artifacts/platform-diagnosis/`; optimization comparisons, rejected candidates, mutation checks and local validation reports are under `.artifacts/dom-optimization/`. No memory limits or memory-monitoring behavior were changed.
