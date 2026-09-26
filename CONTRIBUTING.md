# Contributing

Start with the [setup instructions](README.md#configuration-and-local-development) and [architecture constraints](ARCHITECTURE.md). Keep changes focused on reliable, read-only Alza.cz research.

Run the required checks after the final change:

```sh
npm run typecheck
npm test
npm run build
npm audit
```

Tests use real application collaborators and MCP transports where practical. Replace only browser/network boundaries to force challenge, expiration, pagination and schema failures. Preserve source values and test meaningful distinctions: no results versus failed parsing, public versus conditional prices, rating count versus review count, and partial versus exhausted traversal.

New upstream behavior belongs in `src/adapters`; provider lifetime and authentication belong in `src/infra`. Tool inputs and research results are defined in `src/domain`. Keep endpoint restrictions, account checks and error metadata intact. Do not log raw HTML, credentials, session exports or browser exception messages.

## Live verification

The live validator calls the actual MCP tool interface, checks semantic results, and traverses a bounded test category and a product's reviews to completion. It writes metadata-only JSONL under `.artifacts`; reports contain no review bodies or account cookies.

Against the local source tree:

```sh
xvfb-run -a npm run validate:api
```

Against the deployed server:

```sh
ALZA_MCP_URL=https://your-alza-domain.example/mcp npm run validate:api
```

Set `ALZA_MCP_TOKEN` through a private environment or secret manager. Optional `ALZA_TEST_CATEGORY`, `ALZA_TEST_PRODUCT`, and `ALZA_TEST_AUTH` select the test data and authentication policy. Defaults use an SSD category and a reviewed Samsung SSD. Use `required` to test an imported account. Product retirement or catalogue changes may require updating those test IDs; an empty or partial response is a failed check.

Exercise the Docker deployment as well as the local browser. Confirm that the data volume survives a container replacement, both solver ports remain private, bad credentials and origins fail, and required authentication fails explicitly without an imported account. Compare a required-auth result's effective price against the same account in the normal storefront before relying on company or AlzaPlus benefits.

The Docker `validation` target includes the validator and its development dependencies without installing a browser. Build it with `docker build --target validation -t alza-mcp-validation .`. Run it with `ALZA_MCP_URL`, `ALZA_MCP_TOKEN`, and a writable, persistent `ALZA_VALIDATION_REPORT` path. Add `--soak` after the image name for the acceptance trial. The runner must reach the public endpoint; it does not need access to the browser profile volume.

## Home-server acceptance trial

Run `npm run validate:soak` with `ALZA_MCP_URL` pointing to the actual home deployment. The default trial lasts seven days and samples one data operation every 30 minutes. Its acceptance rule requires at least 200 calls and at least 99% successful, semantically valid responses across a full seven days. Failures remain in the report even when a later call succeeds.

`ALZA_SOAK_INTERVAL_MS`, `ALZA_SOAK_DURATION_MS`, and `ALZA_VALIDATION_REPORT` allow a shorter diagnostic run or a separate report path. A shortened run cannot pass seven-day acceptance. Keep the client process supervised for the whole trial; inspect authentication, challenge recovery, memory growth and restart behavior alongside the numerical result. A source-tree smoke test is not evidence that the home server passed this trial.

When reporting breakage, include the operation, failure code, provider attempts and a sanitized description of the expected response. Do not attach a full HAR or session export: those can contain credentials. Commit self-contained milestones using conventional commit messages.
