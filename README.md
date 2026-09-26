# alza-mcp

An unofficial, read-only Alza.cz research server for MCP clients. Search and traverse product listings, inspect product detail, and read full reviews. It runs on a home Linux server with a persistent Chromium profile. An imported Alza login is optional.

The server attempts automatic challenge recovery, but cannot guarantee CAPTCHA-free access. It reports unsuccessful recovery, expired login, changed pagination, and incomplete parsing explicitly. It provides no checkout, order, pickup-point, or store-inventory tools.

## Run on a home server

Use Docker on x86_64 or ARM64 Linux. Chromium and both recovery images have native builds for these architectures. Account for the application and recovery browsers alongside the host's existing services; verify peak memory during recovery as well as normal requests.

```sh
cp .env.example .env
openssl rand -hex 32
# Put the generated value in ALZA_MCP_TOKEN in .env.
# Set ALZA_PUBLIC_URL to your HTTPS origin, or leave it empty for local use.
docker compose up -d --build
```

Connect an MCP client with:

```text
Transport: Streamable HTTP
URL: https://your-alza-domain.example/mcp
Authorization: Bearer <ALZA_MCP_TOKEN>
```

For ChatGPT web, protect the public hostname with a Cloudflare Access self-hosted application and enable **Managed OAuth** on that application. Give its Allow policy only the intended email address. Enable dynamic client registration and allow `https://chatgpt.com/connector/oauth/*` as a redirect URI; add `https://chatgpt.com/connector_platform_oauth_redirect` if the client uses the stable callback. Set `ALZA_HTTP_AUTH=cloudflare-access`, `ALZA_ACCESS_TEAM_DOMAIN` to the Access team hostname (for example, `yourteam.cloudflareaccess.com`), `ALZA_ACCESS_AUDIENCE` to that application's AUD tag, and `ALZA_ACCESS_EMAIL` to the same allowed email. `ALZA_PUBLIC_URL` must be the MCP endpoint's HTTPS origin. The server validates Cloudflare's signed `Cf-Access-Jwt-Assertion` on every MCP request; an old `ALZA_MCP_TOKEN` cannot grant access in this mode. In ChatGPT, create an MCP app with URL `https://your-alza-domain.example/mcp` and OAuth authentication. Leave the optional advanced OAuth fields empty so the client can use discovery. Cloudflare Access handles the OAuth flow and prompts the user to sign in.

Set the client’s per-tool timeout to at least 130 seconds to allow [bounded recovery](ARCHITECTURE.md#access-and-recovery) to finish and report its result.

The endpoint uses stateless JSON responses. GET/SSE sessions and DELETE session termination are not supported. Use a client that accepts Streamable HTTP JSON responses. Locally, use `http://127.0.0.1:3000/mcp`.

For Coolify, deploy [compose.yaml](compose.yaml), set the environment values, and retain the `alza-data` volume. Route Cloudflare Tunnel to the application's port 3000. A tunnel on the host can use `http://127.0.0.1:3000`; a tunnel container must share the application's Docker network and use `http://alza:3000`. Preserve the public Host header and set `ALZA_PUBLIC_URL` to that exact HTTPS origin. Expose only the application; both recovery services stay on the private Docker network. Cloudflare Access needs no additional client credential at the origin; use the Managed OAuth configuration above.

Container health checks, including the application’s `/healthz`, test local HTTP readiness. They do not contact Alza or prove that challenges can be solved. Compose replaces Byparr’s bundled browser-based Google probe with a local HTTP check to avoid background browser load. An unhealthy Alza session should not trigger a container restart loop.

On a Raspberry Pi, Docker must report working memory-limit support before relying on Compose limits. If the memory controller is disabled, back up `/boot/firmware/cmdline.txt`, append `cgroup_enable=memory` to its existing single line, and reboot during a maintenance window. Verify `memory` appears in `/sys/fs/cgroup/cgroup.controllers` and that `docker info` no longer warns about missing memory-limit support.

For a 4 GB Pi sharing the host with other services, start with `ALZA_MEMORY_LIMIT=1536m`, `FLARESOLVERR_MEMORY_LIMIT=1g`, and `BYPARR_MEMORY_LIMIT=1g`. These are ceilings, not reservations. Acceptance requires successful live browsing and forced recovery without out-of-memory kills or disruption to other services; insufficient capacity is a deployment failure. See [the recovery lifetime constraints](ARCHITECTURE.md#access-and-recovery).

Use a Git-based Docker Compose application in Coolify. Coolify clones the selected branch and builds the Alza image on the deployment server; it does not need an image registry. Set `ALZA_IMAGE=<coolify-application-uuid>:main` at build time and runtime so automatic builds and deployments use the same local image tag. For automatic updates, leave the Git commit SHA unpinned, enable **Auto Deploy**, and add a signed GitHub push webhook using Coolify's **Manual Git Webhooks** endpoint and a secret. If the dashboard is private, publish only `POST /webhooks/source/github/events/manual` through an HTTPS ingress and use that public URL in GitHub; keep all other Coolify paths private. A push to the configured branch then starts a new build; verify the first webhook delivery and deployment before relying on it. Pin a commit and deploy manually when a rollback is needed. With Cloudflare Tunnel terminating public HTTPS and forwarding to the local HTTP proxy, configure an HTTP origin route in Coolify and set `ALZA_PUBLIC_URL` to the external HTTPS origin. Avoid an origin HTTPS redirect loop. Store the bearer token or Cloudflare Access settings, according to the selected HTTP auth mode, in Coolify's runtime environment and retain the same application volume across deployments.

## Research tools

| Tool | Input and result |
|---|---|
| `list_categories` | Current category navigation. |
| `get_category` | `category_id`; child categories, manufacturers, facets and supported sort orders. Some navigation pages do not support direct listings. |
| `search_products` | `query` or `category_id`, optional filters and sort; one complete upstream page and a continuation cursor. |
| `get_product` | Exactly one of `product_id`, `url`, or `code`; optional `sections`. Codes can match multiple conditions, so numeric IDs are preferred. |
| `get_product_reviews` | `product_id`, optional `limit` from 1 to 50; written reviews, statistics and a continuation cursor. |
| `get_session_status` | Local browser, account-configuration, queue and recovery state. Does not verify a login. |

For example, start with:

```json
{
  "category_id": 18845887,
  "filters": { "max_price": 4000, "in_stock": true },
  "sort": "price_asc",
  "auth": "anonymous"
}
```

Then call the same tool with only `{"cursor":"<next_cursor>"}` until `exhausted` is true. Do not change query, filters, page size, or authentication during a traversal. Cursors expire after an hour and are invalidated by a server restart or account replacement. There is no fixed total-result cap and no giant `get_all` response.

Price, manufacturer, condition, stock and parameter filters are applied by Alza. Get enum IDs and numeric range boundaries from `get_category`; numeric values use Alza's source units, which may differ from the displayed label. Unsupported filters fail explicitly.

Product sections are `description`, `specifications`, `variants`, `media`, `documents`, `offers`, `attributes`, and `ratings`. Each requested section is available, not provided by the page, or failed. Variant selectors expose their displayed options and price differences; these do not always include another product's ID. Search for that variant to retrieve its full detail. Document and media results are links, not downloaded files.

## Read results correctly

Every tool result includes matching JSON in `structuredContent` and `content[0].text`:

- `status: "ok"`: the requested operation succeeded.
- `status: "partial"`: useful data is included with explicit `errors`; inspect each section and pagination state. MCP `isError` is true.
- `status: "error"`: an explicit `error` with `code`, `message`, and `retryable`. MCP `isError` is true.

Metadata identifies the provider, attempted recovery steps, verified authentication state, source URLs, cache age and warnings. `meta.challenge.status` is `not_detected`, `detected` (recovery failed), or `solved`; a solved challenge includes the recovery provider and milliseconds from detection to success. Detection covers Alza human-verification pages, including CAPTCHAs; a generic timeout followed by solver success is not evidence that a CAPTCHA occurred. `meta.auth.session_issue` is `null` unless a configured account failed verification during that request. `AUTH_REQUIRED` means the session is no longer signed in; `AUTH_ACCOUNT_MISMATCH` means it is signed into another account. This field remains set when `auth=preferred` falls back to public prices. `get_session_status` does not contact Alza, so a data call is needed to check the current login. For a response combining fresh and cached sections, cache age identifies the oldest cached contribution. Missing values are not zero. `exhausted: false` with no cursor means traversal failed; it does not mean all results were returned. A traversal is not a snapshot: additions, removals or reordered results can require a restart.

Offers distinguish public, effective, conditional and reference prices. Decimal amounts preserve upstream precision; `display` preserves Alza's displayed rounding. VAT-inclusive and VAT-exclusive offers remain separate. A conditional coupon or AlzaPlus promotion is not automatically the price you can pay. Rating counts, written-review counts and translated-review counts can differ; reviews preserve the displayed variant and verified-purchase label.

## Optional account session

`auth` is accepted on data tools:

| Mode | Behavior |
|---|---|
| `anonymous` | Dedicated anonymous profile; public pricing. |
| `preferred` | Uses the configured account when verified. May use anonymous access with an explicit warning if the login expires or cannot survive recovery. |
| `required` | Must verify the configured account, including on cache hits. Never silently returns anonymous pricing. |

Stop the application before importing a session. The data-directory lock also enforces this. The import validates the expected numeric account ID on Alza before atomically replacing the existing account. A failed validation leaves the previous account in place.

The portable import is a Playwright/Patchright storage-state JSON file containing Alza cookies and local storage. To export from a Chromium instance with an explicitly enabled, private CDP endpoint, build this repository and run:

```sh
node scripts/export-session.mjs http://127.0.0.1:9222 /private/alza-session.json
```

Only Alza session data is exported; Cloudflare cookies are excluded because they are not portable browser identity. The exporter detaches after reading. Do not expose the debugging port to the internet. Chromium may require a dedicated user-data directory to enable remote debugging.

Copy the export to the home server, then import it:

```sh
docker compose stop alza
docker compose run --rm --no-deps \
  -v /private/alza-session.json:/import/session.json:ro \
  alza session import --storage /import/session.json --expected-user-id YOUR_NUMERIC_ID
docker compose up -d alza
```

You can instead use `--profile /import/browser` with a mounted, **closed Chromium user-data directory containing the Default profile**. The importer reads a temporary copy, extracts Alza state, and validates it in a fresh managed profile. It does not preserve a complete device fingerprint. Encrypted browser cookies may not be readable across machines or operating systems; use a storage-state export when that happens. Never copy a running profile.

You can find your numeric ID in the signed-in site's `_pageData.userId` page bootstrap. After import, call a data tool with `auth: "required"` to verify the actual server session. Company discounts and AlzaPlus prices still need comparison against your signed-in browser; a configured session alone does not prove benefit eligibility.

Protect the data volume and export like a password. Delete the transfer file after a successful import. The application does not expose cookies, profile downloads or session-import tools over MCP.

For Coolify session renewal, stop the application through Coolify and mount its existing `/data` volume into a one-off import container using the deployed image. Obtain the actual volume name from the application's container mounts; running Compose under a different project name can create an unrelated empty volume. Use Coolify’s **Deploy** action after import and verify an `auth=required` product request. Compose applications use Deploy to start the complete stack; do not use the generic application-restart API.

For a consistent backup, stop the application, archive the complete `/data` volume with file permissions preserved, then restart it. Keep the archive private and copy it off the Pi. Record the deployed Git commit with the backup. Roll back application code by deploying the prior verified commit; restore the matching volume backup only when needed. A restarted server invalidates existing traversal cursors.

## Configuration and local development

| Variable | Default | Purpose |
|---|---|---|
| `ALZA_DATA_DIR` | `.alza-mcp` locally, `/data` in Docker | Persistent profiles, account manifest and cursor key. |
| `ALZA_AUTH_MODE` | `preferred` | Default authentication mode. |
| `ALZA_HTTP_AUTH` | `token` | `token` for a static bearer token or `cloudflare-access` for Cloudflare Access Managed OAuth. |
| `ALZA_MCP_TOKEN` | Required in `token` mode | At least 32 characters; use a random value. Ignored in Cloudflare Access mode. |
| `ALZA_ACCESS_TEAM_DOMAIN` | Required in Cloudflare Access mode | Access team hostname without `https://` or a path. |
| `ALZA_ACCESS_AUDIENCE` | Required in Cloudflare Access mode | AUD tag of the self-hosted Access application. |
| `ALZA_ACCESS_EMAIL` | Required in Cloudflare Access mode | Email identity that the origin accepts. |
| `ALZA_PUBLIC_URL` | Unset | Allowed public HTTPS origin. |
| `PORT` | `3000` | HTTP listening port. |
| `ALZA_TRANSPORT` | stdio | Set `http`, or pass `--http`. |
| `ALZA_FLARESOLVERR_URL` | Unset locally | Private solver URL; Compose configures it. |
| `ALZA_BYPARR_URL` | Unset locally | Private final anonymous solver URL; Compose configures it. |
| `ALZA_HEADLESS` | `false` | Headed browser is the intended deployment. Docker supplies Xvfb. |
| `ALZA_BROWSER_EXECUTABLE` | Bundled Chromium | Diagnostic override; mismatched versions are not the tested configuration. |
| `ALZA_LOG_LEVEL` | `info` | Structured stderr logging. |
| `ALZA_MEMORY_LIMIT` | `2g` | Compose memory ceiling for the application and its browser. |
| `ALZA_IMAGE` | `alza-mcp:0.2.0` | Compose image reference; use `<coolify-application-uuid>:main` for automatic deployment or a commit tag for a pinned deployment. |
| `FLARESOLVERR_MEMORY_LIMIT` | `1g` | Compose memory ceiling for FlareSolverr. |
| `BYPARR_MEMORY_LIMIT` | `1g` | Compose memory ceiling for Byparr. |

Only `www.alza.cz` is supported. Old CDP attachment, locale switching, pickup tools, product resources and shopping prompts were removed in 0.2. Browser downloads happen during explicit installation or Docker build, never during an MCP call.

For local Node.js development:

```sh
npm ci --ignore-scripts
npx patchright install --with-deps chromium
npm run typecheck
npm test
npm run build
xvfb-run -a node dist/index.js
```

Without `--http`, stdout is reserved for MCP stdio. A desktop MCP client can launch `xvfb-run -a node /absolute/path/dist/index.js`; use an absolute `ALZA_DATA_DIR`. Only one server or import command may own that directory.

See [ARCHITECTURE.md](ARCHITECTURE.md) for design constraints and [CONTRIBUTING.md](CONTRIBUTING.md) for verification and development conventions.

Unofficial; not affiliated with or endorsed by Alza.cz a.s. Licensed under [MIT](LICENSE).
