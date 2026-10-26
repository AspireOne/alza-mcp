# Contributing

Start with the [setup instructions](README.md#configuration-and-local-development) and [architecture constraints](ARCHITECTURE.md). Keep changes focused on reliable, read-only Alza.cz research.

Run the required checks after the final change:

```sh
npm run typecheck
npm test
npm run build
npm audit
```

Tests use real application collaborators and MCP transports where practical. Replace only browser, API-transport or network boundaries to force challenge, expiration, pagination and schema failures. Preserve source values and test meaningful distinctions: no results versus failed parsing, public versus conditional prices, rating count versus review count, and partial versus exhausted traversal.

New upstream behavior belongs in `src/adapters`; provider lifetime and authentication belong in `src/infra`. Tool inputs and research results are defined in `src/domain`. Keep endpoint restrictions, account checks and error metadata intact. Do not log raw HTML, credentials, session exports or browser exception messages.

## Local Docker stack

Use Linux, Docker Compose 2.24.4 or newer, and Node 24. The local override runs the production Dockerfile, headed Chromium under Xvfb, and both pinned recovery services. It isolates the project as `alza-mcp-local`, uses the `alza-mcp:local` application image, and retains its own `alza-data` volume across `down` and `up`. The application is published on loopback port 3001. Recovery services bind only to loopback, on ports 8191 and 8192, so the native comparison can use the same services.

```sh
node scripts/local-stack.mjs status
node scripts/local-stack.mjs import-session --storage /private/alza-session.json --expected-user-id YOUR_NUMERIC_ID
node scripts/local-stack.mjs up
node scripts/local-stack.mjs validate
```

Session import requires the local application to be stopped. Use the [portable export procedure](README.md#optional-account-session) to obtain the input; the runner never fetches or copies production state. For an already prepared private seed, `import-session` without options reads `.artifacts/local-stack/session.json` and `.artifacts/local-stack/account-seed.json`, whose `expectedUserId` field identifies the account to verify. Remove transfer files after import. A rejected import leaves the previous managed account intact.

The first operational command creates `.artifacts/local-stack/.env` with a random bearer token and `ALZA_LOCAL_PORT=3001`, protected with mode 600. Edit that file to change `ALZA_LOCAL_PORT` (3001), `ALZA_LOCAL_NATIVE_PORT` (3002), `ALZA_LOCAL_FLARE_PORT` (8191), or `ALZA_LOCAL_BYPARR_PORT` (8192), or set `ALZA_TEST_CATEGORY` and `ALZA_TEST_PRODUCT` for current test listings. The runner isolates Compose from inherited production authentication settings and always requires a verified Alza account. It does not print the token; configure a native MCP client from the private file if needed. Do not commit the file, session exports or the volume contents.

For resource comparisons, set `ALZA_MEMORY_LIMIT`, `FLARESOLVERR_MEMORY_LIMIT` and `BYPARR_MEMORY_LIMIT` in the private configuration to the deployed limits. Desktop CPU architecture and available host memory still differ from the Pi; native execution is not constrained by Docker's limits.

`up` builds and waits for local container health, then checks `/healthz`; this confirms local readiness, not a valid Alza login. `validate` builds the Docker validation target and runs a signed-in smoke check through `localhost` in the application's network namespace, using the same configured port as native clients. This preserves Host-header validation without publishing another port. It calls all six tools once, with one search page and one review page, and checks product sections without following cursors. Reports accumulate in `.artifacts/local-stack/reports/smoke.jsonl`, readable by the invoking user. Validation does not mount the browser profile or restart the application. Product retirement or catalogue changes can still require changing the validator's test fixtures.

Use `node scripts/local-stack.mjs logs` for recent and following stack logs, `status` for container state, and `down` to stop the entire local stack while retaining the account volume. The same commands are available through `npm run stack:local -- <command>` or `pnpm stack:local <command>`.

### Native comparison

Install the [local browser and dependencies](README.md#configuration-and-local-development) first. The native commands compile the source with the installed TypeScript compiler directly; a global npm executable is unnecessary. They use the same private bearer token and account seed as the Docker commands, but retain a separate profile in `.artifacts/native-state`. They do not copy an existing managed profile.

```sh
node scripts/local-stack.mjs native-import
node scripts/local-stack.mjs native
# In another terminal:
node scripts/local-stack.mjs native-validate
```

`native-import` also accepts `--storage FILE --expected-user-id ID`. Stop the native server before importing; its profile lock prevents concurrent ownership. `native` starts or reuses the local Compose recovery services and runs the complete HTTP application in the foreground at `http://127.0.0.1:3002/mcp`. Required account verification and both automatic recovery URLs match the local Docker setup. Stop it with Ctrl+C; helper containers remain available until `down`. Run `native-validate` while the server is running; its bounded report is `.artifacts/local-stack/reports/native-smoke.jsonl`.

Native Chromium runs headed. On a Linux server without a graphical session, use `xvfb-run -a node scripts/local-stack.mjs native-import` and `xvfb-run -a node scripts/local-stack.mjs native`. Under WSL, ensure the graphical display is available or use Xvfb. The Docker browser always uses its own Xvfb display. Keep Docker and native calls sequential when comparing them: both use the same account, host network and recovery services.

### Native WSL networking

If Docker browsing works but native Chromium stalls before usable content appears, inspect pending script hosts and their DNS answers. In WSL mirrored networking, an existing DNS block returning `0.0.0.0` can enter Windows localhost forwarding and hang instead of failing promptly. Changing page readiness or disabling arbitrary resources does not fix that network behavior.

On the investigated machine, a local `wsl-dns-sinkholes.service` reconciles only the two confirmed blocked analytics names to non-forwarded loopback, preserving the upstream blocking policy and other hosts entries. It does not change the application's browser settings or production configuration. Check that service after restarting WSL; its installation, evidence and rollback are recorded in the local `.artifacts/local-environment/remediation.md`. This machine-specific adaptation is not required or installed automatically by the project. See [WSL networking](https://learn.microsoft.com/windows/wsl/networking) and the [investigation record](docs/EFFICIENCY-IMPROVEMENTS.md#local-testing-environment).

## Concurrency comparison

Use `node scripts/benchmark-concurrency.mjs --dry-run` to inspect the fixed workload. A live run sends five shopping calls, repeats those five for warm-cache behavior, then reads one review page for each shortlisted product. Calls go through the HTTP MCP client with a dispatch window of five; there is no unbounded traversal. Every data result must be successful and signed in, with matching identity and valid requested sections. No memory-pressure measurements are collected by this benchmark.

Set `ALZA_BROWSER_CONCURRENCY=1` or `2` in the private local configuration and restart the target server before each arm. Use matching test data and fresh server caches for each comparison. Example against the native harness:

```sh
node scripts/benchmark-concurrency.mjs --url http://127.0.0.1:3002/mcp --label serial --concurrency 1 --output .artifacts/concurrency-serial.json
# Restart the server with concurrency 2 before the next command.
node scripts/benchmark-concurrency.mjs --url http://127.0.0.1:3002/mcp --label parallel --concurrency 2 --output .artifacts/concurrency-parallel.json
```

The client reads the existing private local bearer token, checks the advertised server concurrency, and writes a mode-600 report without response bodies or account identifiers. Reports retain semantic hashes, section states and request IDs for comparison and server-log correlation. Output files must be new. Client duration minus provider-attempt time is only an approximation of queueing; use correlated `queue.wait` records for exact waits. Browser HTTP caches and upstream content may differ between runs, so inspect mismatches and keep failed runs rather than treating speed alone as success.

## Live verification

The live validator calls the actual MCP tool interface and checks semantic results. Use `npm run validate:smoke` for one bounded call per tool. The default `validate:api` additionally follows a test category and a product's reviews to completion; its traffic depends on the current upstream result counts. It writes metadata-only JSONL under `.artifacts`; reports contain no review bodies or account cookies.

Against the local source tree:

```sh
xvfb-run -a npm run validate:api
ALZA_BACKEND=api npm run validate:api
```

Against the deployed server:

```sh
ALZA_MCP_URL=https://your-alza-domain.example/mcp npm run validate:api
```

Set `ALZA_MCP_TOKEN` through a private environment or secret manager. Optional `ALZA_TEST_CATEGORY`, `ALZA_TEST_PRODUCT`, and `ALZA_TEST_AUTH` select the test data and authentication policy. Defaults use an SSD category and a reviewed Samsung SSD. When changing the API backend, also compare its results with the browser backend's for the same calls; the [documented differences](README.md#choose-a-backend) are the only expected ones. Use `required` to test the configured account. Product retirement or catalogue changes may require updating those test IDs; an empty or partial response is a failed check.

Exercise the Docker deployment as well as the local browser. Confirm that the data volume survives a container replacement, both solver ports remain private, bad credentials and origins fail, and required authentication fails explicitly without an imported account. Compare a required-auth result's effective price against the same account in the normal storefront before relying on company or AlzaPlus benefits.

The Docker `validation` target includes the validator and its development dependencies without installing a browser. Build it with `docker build --target validation -t alza-mcp-validation .`. Run it with `ALZA_MCP_URL`, `ALZA_MCP_TOKEN`, and a writable, persistent `ALZA_VALIDATION_REPORT` path. Add `--soak` after the image name for the acceptance trial. The runner must reach the public endpoint; it does not need access to the browser profile volume.

## Home-server acceptance trial

Run `npm run validate:soak` with `ALZA_MCP_URL` pointing to the actual home deployment. The default trial lasts seven days and samples one data operation every 30 minutes. Its acceptance rule requires at least 200 calls and at least 99% successful, semantically valid responses across a full seven days. Failures remain in the report even when a later call succeeds.

`ALZA_SOAK_INTERVAL_MS`, `ALZA_SOAK_DURATION_MS`, and `ALZA_VALIDATION_REPORT` allow a shorter diagnostic run or a separate report path. A shortened run cannot pass seven-day acceptance. Keep the client process supervised for the whole trial; inspect authentication, challenge recovery, memory growth and restart behavior alongside the numerical result. A source-tree smoke test is not evidence that the home server passed this trial.

To resume an existing trial, set `ALZA_SOAK_STARTED_AT` to its original ISO start time and reuse its report. This preserves the deadline and recorded failures.

For a Discord completion notification, supply `ALZA_VALIDATION_DISCORD_WEBHOOK` through a private environment. The runner saves the outcome and delivery status to `${ALZA_VALIDATION_REPORT}.summary.json`, then reports success, failure, or interruption to Discord. Delivery retries are bounded; a failed delivery remains visible in the saved summary and process exit status. Allow at least 130 seconds for graceful container shutdown. A forced kill or power loss cannot send a notification.

When reporting breakage, include the operation, failure code, provider attempts and a sanitized description of the expected response. Do not attach a full HAR or session export: those can contain credentials. Commit self-contained milestones using conventional commit messages.
