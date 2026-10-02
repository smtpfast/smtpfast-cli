# Keeping the CLI in sync with the API

Every SMTPfast API operation is a CLI command. Nobody writes those commands by
hand. They come from the API's OpenAPI spec, so a new endpoint reaches users
with no code change in this repo.

Three layers make that work. Each one covers a gap the others leave.

| Layer | When it runs | What it does |
| --- | --- | --- |
| Generated manifest | Every build | Turns `spec/openapi.json` into `src/generated/manifest.json`, one entry per operation. |
| Spec sync workflow | After an API deploy, and daily | Downloads the live spec. If it changed, regenerates, tests, bumps the minor version and publishes. |
| Runtime spec cache | At most once a day on each user's machine | Downloads the live spec in the background, so new operations run even before the user upgrades. |

## 1. The generated manifest

`scripts/generate.ts` reads the spec and writes two files:

- `src/generated/manifest.json`: each operation with its group, command name,
  path parameters, query parameters and top-level request body fields. `$ref`
  and `allOf` are resolved. The output is sorted, so a spec change gives a small,
  readable diff.
- The command reference in `README.md`, between the
  `<!-- BEGIN COMMAND REFERENCE -->` and `<!-- END COMMAND REFERENCE -->` markers.

```sh
bun scripts/generate.ts                                              # from spec/openapi.json
bun scripts/generate.ts --spec https://smtpfa.st/api/v1/openapi.json # download first, then generate
bun scripts/generate.ts --check                                      # fail if anything is out of date
```

CI runs `--check`, so a pull request cannot change the spec snapshot without the
generated files.

### Command names

`src/spec/naming.ts` holds the rules. The build and the CLI itself use the same
file, so an operation gets the same name whether it comes from the manifest or
from a newer live spec.

- The group is the first path segment after `/v1`. A few prefixes map to other
  names: `/emails/receiving` is `received`, and `/me` and `/usage` are `account`.
- The command is the operationId without the group's resource words, in kebab
  case: `listEmails` becomes `emails list`, `sendEmailBatch` becomes
  `emails send-batch`.
- `list` is dropped when a sub-resource follows: `listWebhookDeliveries` becomes
  `webhooks deliveries <id>`. `get` is dropped the same way on paths without an
  id: `getDomainClaimRecord` becomes `domains claim-record`.
- Path parameters become positional arguments, in path order.
- A path must start with `/v1/` and have no `.` or `..` segments (plain or
  percent-encoded), no empty segments, and no scheme or host. The generator
  skips any other path with a warning. The CLI applies the same rule to the
  runtime spec cache.

When a rule gives a bad name, add an entry to `COMMAND_OVERRIDES`,
`GROUP_ALIASES` or `GROUP_WORDS` in `src/spec/naming.ts`. Then update the
expected table in `test/naming.test.ts`. That test lists every command, so any
rename shows up in review.

If two operations would get the same name, the generator falls back to the
kebab-cased operationId for both and prints a warning. The CLI keeps working,
and the warning tells you to add an override.

## 2. The spec sync workflow

`.github/workflows/spec-sync.yml` runs on three triggers:

- `repository_dispatch` with the event type `spec-changed`, sent by the
  smtpfast app after a deploy (see below).
- A daily schedule, in case a dispatch was missed.
- A manual run from the Actions tab, with an optional spec URL.

Each run:

1. Downloads the live spec and runs the generator.
2. Stops if `spec/`, `src/generated/` and `README.md` did not change.
3. Runs the type check and the tests. A failure stops the release.
4. Bumps the minor version with `npm version minor`.
5. Writes a changelog entry with `scripts/spec-diff.ts`, which lists new,
   changed and removed commands.
6. Commits, tags `vX.Y.Z` and pushes to `main`.
7. Calls `.github/workflows/release.yml`, which publishes to npm with
   provenance, builds the standalone binaries and creates the GitHub release.

The release workflow is called directly, not through the tag push. A tag pushed
with `GITHUB_TOKEN` does not start other workflows.

The workflow ignores the dispatch payload. It always downloads the spec itself,
so a forged dispatch can at most start a run that finds nothing to do.

### Setup in this repo

- Add an `NPM_TOKEN` secret: an npm granular access token with publish rights
  for the `smtpfast` package.
- Under Settings, Actions, General, set workflow permissions to read and write.
- If `main` is protected, let the `github-actions[bot]` push to it, or the
  commit step fails. The tests already ran in the same job.

### Removed or renamed operations

A removed operation removes a command. The workflow still bumps the minor
version, and the changelog lists the command under "Removed commands". Before
1.0 a minor bump may break things, so this follows semver. After 1.0, consider
making the workflow stop for review when `spec-diff.ts` reports removals.

## 3. The runtime spec cache

The CLI also keeps a copy of the live spec in its config directory:

```
~/.config/smtpfast/spec.json        the last spec it downloaded
~/.config/smtpfast/spec-meta.json   when it checked, the ETag, the hash
```

`XDG_CONFIG_HOME` moves both. The rules:

- At most once every 24 hours, a command starts a detached child process that
  downloads `<base-url>/v1/openapi.json`. The command does not wait for it.
- The download has a 10 second timeout and sends `If-None-Match` when the server
  gave an ETag before. Any failure leaves the old cache alone.
- An operation that is in the cached spec but not in the built-in manifest still
  runs. Its name comes from the same rules.
- `smtpfast --version` and `smtpfast commands` say how many operations are newer
  than the installed version, and how to upgrade.
- `--no-update-check` or `SMTPFAST_NO_UPDATE_CHECK=1` turns the refresh off.
  `SMTPFAST_SPEC_URL` points it at another URL.

The refresh never sends the API key. The spec endpoint is public.

## The step for the smtpfast app's deploy workflow

Add this step to the `deploy` job in the app's `.github/workflows/deploy.yml`,
after the smoke test. It compares the live spec with the snapshot in this repo
and sends the dispatch only when they differ. `jq -S -c` sorts keys and drops
whitespace on both sides, so formatting does not count as a change.

```yaml
      - name: Tell the CLI when the API spec changed
        if: success()
        env:
          CLI_DISPATCH_TOKEN: ${{ secrets.CLI_DISPATCH_TOKEN }}
          APP_SHA: ${{ github.sha }}
        run: |
          if [ -z "$CLI_DISPATCH_TOKEN" ]; then
            echo "::warning::CLI_DISPATCH_TOKEN is not set, skipping the CLI spec check"
            exit 0
          fi
          live=$(curl -fsS --retry 3 "https://smtpfa.st/api/v1/openapi.json?deploy=$APP_SHA" | jq -S -c . | sha256sum | cut -d' ' -f1)
          shipped=$(curl -fsS --retry 3 https://raw.githubusercontent.com/smtpfast/smtpfast-cli/main/spec/openapi.json | jq -S -c . | sha256sum | cut -d' ' -f1)
          echo "live spec:    $live"
          echo "CLI snapshot: $shipped"
          if [ "$live" = "$shipped" ]; then
            echo "The spec did not change. Nothing to send."
            exit 0
          fi
          curl -fsS -X POST \
            -H "Accept: application/vnd.github+json" \
            -H "Authorization: Bearer $CLI_DISPATCH_TOKEN" \
            -H "X-GitHub-Api-Version: 2022-11-28" \
            https://api.github.com/repos/smtpfast/smtpfast-cli/dispatches \
            -d "{\"event_type\":\"spec-changed\",\"client_payload\":{\"spec_sha256\":\"$live\",\"app_sha\":\"$APP_SHA\"}}"
          echo "Sent spec-changed to smtpfast/smtpfast-cli"
```

The `?deploy=` query string keeps a CDN from answering with a cached spec from
before the deploy.

### The CLI_DISPATCH_TOKEN secret

Create a fine-grained personal access token:

- Resource owner: the `smtpfast` organization.
- Repository access: only `smtpfast/smtpfast-cli`.
- Repository permissions: Contents, read and write. The dispatches endpoint
  needs nothing else.
- Expiration: the longest your policy allows, with a calendar reminder to
  rotate it.

Save it in the app repo as an Actions secret named `CLI_DISPATCH_TOKEN`. To
test it without a deploy, run the `curl -X POST` part by hand and check that a
"Spec sync" run starts in this repo.

## Running a sync by hand

From the Actions tab, run "Spec sync". Leave the URL as is for production, or
point it at a staging spec to see what would change. Locally, without
publishing anything:

```sh
cp src/generated/manifest.json /tmp/old-manifest.json
bun scripts/generate.ts --spec https://smtpfa.st/api/v1/openapi.json
bun scripts/spec-diff.ts /tmp/old-manifest.json src/generated/manifest.json
bun test
git diff --stat
```
