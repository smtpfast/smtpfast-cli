# smtpfast

The command-line tool for [SMTPfast](https://smtpfa.st), the Resend-compatible email API.
Send email, manage domains, contacts and webhooks, and call every API endpoint from a terminal or a script.

- [Install](#install)
- [Quick start](#quick-start)
- [Authentication and profiles](#authentication-and-profiles)
- [Examples](#examples)
- [How commands map to the API](#how-commands-map-to-the-api)
- [Output and errors](#output-and-errors)
- [How it stays up to date](#how-it-stays-up-to-date)
- [Command reference](#command-reference)
- [Exit codes](#exit-codes)
- [Environment variables](#environment-variables)
- [Contributing](#contributing)

API documentation: <https://smtpfa.st/docs>

## Install

With Node 18 or later:

```sh
npx smtpfast --help        # run it without installing
npm install -g smtpfast    # or install it
```

Or download a standalone binary from the [latest release](https://github.com/smtpfast/smtpfast-cli/releases/latest). It does not need Node.

```sh
# Pick your platform: linux-x64, linux-arm64, darwin-x64, darwin-arm64
curl -fsSL -o smtpfast https://github.com/smtpfast/smtpfast-cli/releases/latest/download/smtpfast-linux-x64
chmod +x smtpfast
sudo mv smtpfast /usr/local/bin/
```

On Windows, download `smtpfast-windows-x64.exe`. Each release has a `SHA256SUMS` file to check the download. If macOS blocks a binary you downloaded in a browser, run `xattr -d com.apple.quarantine smtpfast`.

## Quick start

```sh
smtpfast login
smtpfast send --from hello@yourapp.com --to you@example.com --subject "Hello" --text "It works"
smtpfast emails get <id>
```

`login` asks for an API key without showing it, checks it with `GET /v1/me`, and saves it. `send` prints the new email's id. `emails get` shows its status.

## Authentication and profiles

The CLI looks for an API key in this order:

1. The `--api-key` flag
2. The `SMTPFAST_API_KEY` environment variable
3. The current profile in `~/.config/smtpfast/config.json`

`smtpfast login` writes the key to a profile. The file is readable only by you (mode 600), and a new config directory gets mode 700. If `config.json` is a symbolic link, the CLI refuses to write the key. Keep keys for several accounts or environments in named profiles:

```sh
smtpfast login --profile staging --base-url https://staging.example.com/api
smtpfast profiles list
smtpfast profiles use staging
smtpfast whoami --profile default
smtpfast logout --profile staging
```

The profile comes from `--profile`, then `SMTPFAST_PROFILE`, then the current profile. The base URL comes from `--base-url`, then `SMTPFAST_BASE_URL`, then the profile, then `https://smtpfa.st/api`.

`smtpfast whoami` shows the team, plan and scopes of the key in use. In CI, set `SMTPFAST_API_KEY` as a secret. You do not need to log in. To log in from a script, pipe the key: `echo "$KEY" | smtpfast login`.

## Examples

### Send an email with an attachment

```sh
smtpfast send \
  --from "Acme Billing <billing@acme.com>" \
  --to jane@example.com \
  --subject "Your invoice" \
  --html-file invoice.html \
  --attach invoice.pdf
```

The CLI reads each file and sends it base64 encoded. Repeat `--to`, `--cc`, `--bcc` and `--attach` as needed. Use `--text-file -` to read the body from stdin.

### Schedule an email

```sh
smtpfast send --from hi@acme.com --to jane@example.com --subject "Tomorrow" \
  --text "See you soon" --scheduled-at 2026-11-01T09:00:00Z

smtpfast emails update <id> --scheduled-at 2026-11-02T09:00:00Z   # move it
smtpfast emails cancel <id>                                        # or cancel it
```

### Add and verify a domain

```sh
smtpfast domains add --domain acme.com
smtpfast domains verify acme.com --wait --timeout 30m
```

`domains add` prints the DNS records to create. `domains verify --wait` checks the domain every 10 seconds and prints the DKIM, SPF, DMARC and MAIL FROM results until the domain is verified. It exits with code 1 if the timeout passes first. You can pass the domain name or its id.

### Follow email events as they happen

```sh
smtpfast logs tail
smtpfast logs tail --type bounced,complained
smtpfast logs tail --recipient jane@example.com --json | jq .
```

`logs tail` prints recent events, then new ones, oldest first. Press Ctrl-C to stop. It needs a key with the `logs:read` scope.

### Import contacts from a JSON file

The API creates one contact per request. Pipe each object in the file to `contacts create`:

```sh
# contacts.json: [{"email": "jane@example.com", "first_name": "Jane"}, ...]
jq -c '.[]' contacts.json | while read -r contact; do
  printf '%s' "$contact" | smtpfast contacts create --data - --quiet
done
```

### Create a webhook

```sh
smtpfast webhooks create --url https://acme.com/hooks/smtpfast --events email.delivered,email.bounced
smtpfast webhooks test <id>
smtpfast webhooks deliveries <id>
```

### Call any endpoint

```sh
smtpfast api GET /v1/usage
smtpfast api POST /v1/contacts --data '{"email":"jane@example.com"}'
```

`api` uses the same key, base URL, retries and output as every other command. The CLI refuses any request whose final URL is not under the base URL.

## How commands map to the API

Each API operation is a command: `smtpfast <group> <command> [args] [flags]`.

- The group is the resource: `emails`, `domains`, `contacts`, `webhooks` and so on. Received mail is under `received`. The key's own details are under `account`.
- Path parameters are positional arguments. `POST /v1/webhooks/{id}/deliveries/{delivery_id}/retry` is `smtpfast webhooks retry-delivery <id> <delivery_id>`. An argument cannot be `.` or `..`.
- Query parameters and body fields are flags in kebab case. `scheduled_at` is `--scheduled-at`. The exact API name works too.
- A list takes a repeated flag or a comma list: `--to a@x.com --to b@x.com` or `--to a@x.com,b@x.com`.
- A boolean is `--flag` or `--no-flag`.
- A flag that takes a value always takes the next word, even one that starts with a dash. `--subject --help` sets the subject to `--help`.
- Global flags like `--json` and `--profile` go before or after the command. After `--`, every word is an argument.
- An object takes JSON or `key=value` pairs: `--properties '{"plan":"pro"}'` or `--properties plan=pro`.
- `--data` sends a whole body: inline JSON, `@file.json`, or `-` for stdin. Flags override fields from `--data`.

Every command has help with its flags, their types, the required ones and an example:

```sh
smtpfast emails --help         # the commands in a group
smtpfast emails send --help    # one command
smtpfast commands              # every command
```

A few commands are written by hand for a smoother workflow: `send`, `domains verify --wait`, `logs tail` and `api`, plus `login`, `logout`, `whoami` and `profiles`. They call the same API.

## Output and errors

On a terminal, lists print as tables and single objects as keys and values. When you pipe the output, or pass `--json`, the CLI prints the API response as JSON. `--quiet` (`-q`) prints only ids.

```sh
smtpfast contacts list --json | jq -r '.data[].email'
id=$(smtpfast send --from hi@acme.com --to jane@example.com --subject Hi --text Hi --quiet)
```

Errors go to stderr with the HTTP status and the API's message. When a key lacks a scope, the CLI names the scope. On HTTP 429 the CLI waits for the `Retry-After` time and tries once more. Pass `--idempotency-key` to make a retried send safe. `--debug` prints each request and response status to stderr. Errors and debug output never show the API key. If a response repeats the key, the CLI prints `[redacted]` in its place. Set `NO_COLOR` to turn colors off.

## How it stays up to date

New API endpoints become commands without code changes in this repo:

- Each release ships a manifest generated from the API's OpenAPI spec.
- When the API spec changes, a workflow in this repo regenerates the manifest, runs the tests and publishes a new minor version.
- Between releases, the CLI downloads the live spec in the background, at most once a day. Operations that are new in it run right away. `smtpfast --version` and `smtpfast commands` tell you when your version is behind.

The background download never blocks or fails a command, and it never sends your key. Turn it off with `--no-update-check` or `SMTPFAST_NO_UPDATE_CHECK=1`. [docs/keeping-in-sync.md](docs/keeping-in-sync.md) explains the whole flow.

## Shell completion

```sh
source <(smtpfast completion bash)   # add this line to ~/.bashrc
source <(smtpfast completion zsh)    # add this line to ~/.zshrc, after compinit
smtpfast completion fish | source    # or save it in ~/.config/fish/completions/smtpfast.fish
```

The script asks the CLI for candidates each time, so new commands complete without reinstalling it.

## Command reference

<!-- BEGIN COMMAND REFERENCE -->
<!-- Generated by scripts/generate.ts from spec/openapi.json. Do not edit by hand. -->

78 API operations in 14 groups, plus the hand-written commands below.

#### Hand-written commands

| Command | What it does |
| --- | --- |
| `smtpfast send` | Send an email |
| `smtpfast login` | Store an API key |
| `smtpfast logout` | Remove the stored API key |
| `smtpfast whoami` | Show the team, plan and scopes of the API key in use |
| `smtpfast profiles <list\|use\|remove> [name]` | List, switch and remove stored profiles |
| `smtpfast api <method> <path>` | Make a raw API request |
| `smtpfast commands` | List every command |
| `smtpfast completion <bash\|zsh\|fish>` | Print a shell completion script |
| `smtpfast version` | Show the version and whether the live API is ahead of it |
| `smtpfast domains verify <id-or-name>` | Verify a domain, and optionally wait until its DNS records pass |
| `smtpfast logs tail` | Print email events as they happen |

#### account

The API key's scopes, plan, rate limit and usage

| Command | API | What it does |
| --- | --- | --- |
| `smtpfast account capabilities` | `GET /v1/me` | What this API key can do |
| `smtpfast account usage` | `GET /v1/usage` | Usage against the plan |

#### analytics

Email sending analytics and metrics

| Command | API | What it does |
| --- | --- | --- |
| `smtpfast analytics get` | `GET /v1/analytics` | Get analytics |

#### api-keys

Create, list, and revoke API keys

| Command | API | What it does |
| --- | --- | --- |
| `smtpfast api-keys create` | `POST /v1/api-keys` | Create API key |
| `smtpfast api-keys list` | `GET /v1/api-keys` | List API keys |
| `smtpfast api-keys revoke <id>` | `DELETE /v1/api-keys/{id}` | Revoke API key |
| `smtpfast api-keys update <id>` | `PATCH /v1/api-keys/{id}` | Update API key |

#### broadcasts

Create, test, schedule, cancel, and measure broadcast campaigns

| Command | API | What it does |
| --- | --- | --- |
| `smtpfast broadcasts cancel <id>` | `POST /v1/broadcasts/{id}/cancel` | Cancel a scheduled broadcast |
| `smtpfast broadcasts clicked-links <id>` | `GET /v1/broadcasts/{id}/clicked-links` | List clicked links |
| `smtpfast broadcasts create` | `POST /v1/broadcasts` | Create a broadcast draft |
| `smtpfast broadcasts delete <id>` | `DELETE /v1/broadcasts/{id}` | Delete a draft broadcast |
| `smtpfast broadcasts duplicate <id>` | `POST /v1/broadcasts/{id}/duplicate` | Duplicate broadcast |
| `smtpfast broadcasts get <id>` | `GET /v1/broadcasts/{id}` | Get broadcast details |
| `smtpfast broadcasts list` | `GET /v1/broadcasts` | List broadcasts |
| `smtpfast broadcasts send <id>` | `POST /v1/broadcasts/{id}/send` | Send or schedule a broadcast |
| `smtpfast broadcasts send-test <id>` | `POST /v1/broadcasts/{id}/test` | Send a test broadcast email |
| `smtpfast broadcasts update <id>` | `PATCH /v1/broadcasts/{id}` | Update a draft or scheduled broadcast |

#### contact-properties

Declare custom contact properties

| Command | API | What it does |
| --- | --- | --- |
| `smtpfast contact-properties create` | `POST /v1/contact-properties` | Declare a contact property |
| `smtpfast contact-properties delete <id>` | `DELETE /v1/contact-properties/{id}` | Delete a contact property |
| `smtpfast contact-properties get <id>` | `GET /v1/contact-properties/{id}` | Get a contact property |
| `smtpfast contact-properties list` | `GET /v1/contact-properties` | List contact properties |
| `smtpfast contact-properties update <id>` | `PATCH /v1/contact-properties/{id}` | Update a contact property default |

#### contacts

Manage subscribers, subscription status, and custom properties

| Command | API | What it does |
| --- | --- | --- |
| `smtpfast contacts create` | `POST /v1/contacts` | Create a contact |
| `smtpfast contacts delete <id>` | `DELETE /v1/contacts/{id}` | Delete a contact |
| `smtpfast contacts export` | `GET /v1/contacts/export` | Export contacts |
| `smtpfast contacts get <id>` | `GET /v1/contacts/{id}` | Retrieve a contact |
| `smtpfast contacts list` | `GET /v1/contacts` | List contacts |
| `smtpfast contacts update <id>` | `PATCH /v1/contacts/{id}` | Update a contact |

#### domains

Manage and verify sending domains

| Command | API | What it does |
| --- | --- | --- |
| `smtpfast domains add` | `POST /v1/domains` | Add a domain |
| `smtpfast domains claim` | `POST /v1/domains/claim` | Claim a domain held by another account |
| `smtpfast domains claim-record` | `GET /v1/domains/claim` | Get the claim record for a domain |
| `smtpfast domains get <id>` | `GET /v1/domains/{id}` | Get domain details |
| `smtpfast domains list` | `GET /v1/domains` | List domains |
| `smtpfast domains update-receiving <id>` | `PATCH /v1/domains/{id}` | Turn inbound receiving on or off |
| `smtpfast domains verify <id-or-name>` | `POST /v1/domains/{id}/verify` | Verify a domain, and optionally wait until its DNS records pass (hand-written) |

#### emails

Send and track transactional emails

| Command | API | What it does |
| --- | --- | --- |
| `smtpfast emails cancel <id>` | `POST /v1/emails/{id}/cancel` | Cancel a scheduled email |
| `smtpfast emails get <id>` | `GET /v1/emails/{id}` | Get email details |
| `smtpfast emails list` | `GET /v1/emails` | List sent emails |
| `smtpfast emails send` | `POST /v1/emails` | Send an email |
| `smtpfast emails send-batch` | `POST /v1/emails/batch` | Send a batch of emails |
| `smtpfast emails share <id>` | `POST /v1/emails/{id}/share` | Create a share link for a sent email |
| `smtpfast emails update <id>` | `PATCH /v1/emails/{id}` | Reschedule a scheduled email |

#### forms

Signup forms and pending double opt-in signups

| Command | API | What it does |
| --- | --- | --- |
| `smtpfast forms approve-all-pending <id>` | `POST /v1/forms/{id}/pending/approve-all` | Approve all pending signups |
| `smtpfast forms approve-pending <id> <pendingId>` | `POST /v1/forms/{id}/pending/{pendingId}/approve` | Approve a pending signup |
| `smtpfast forms create` | `POST /v1/forms` | Create a signup form |
| `smtpfast forms delete <id>` | `DELETE /v1/forms/{id}` | Delete a signup form |
| `smtpfast forms get <id>` | `GET /v1/forms/{id}` | Retrieve a signup form |
| `smtpfast forms list` | `GET /v1/forms` | List signup forms |
| `smtpfast forms pending <id>` | `GET /v1/forms/{id}/pending` | List pending signups |
| `smtpfast forms remove-pending <id> <pendingId>` | `DELETE /v1/forms/{id}/pending/{pendingId}` | Remove a pending signup |
| `smtpfast forms update <id>` | `PATCH /v1/forms/{id}` | Update a signup form |

#### logs

The event log behind the Logs page

| Command | API | What it does |
| --- | --- | --- |
| `smtpfast logs list` | `GET /v1/logs` | List email events |

#### received

Inbound email: received messages and attachments

| Command | API | What it does |
| --- | --- | --- |
| `smtpfast received attachments <id>` | `GET /v1/emails/receiving/{id}/attachments` | List attachments of a received email |
| `smtpfast received delete <id>` | `DELETE /v1/emails/receiving/{id}` | Delete a received email |
| `smtpfast received get <id>` | `GET /v1/emails/receiving/{id}` | Get a received email |
| `smtpfast received get-attachment <id> <attachment_id>` | `GET /v1/emails/receiving/{id}/attachments/{attachment_id}` | Get one attachment of a received email |
| `smtpfast received list` | `GET /v1/emails/receiving` | List received emails |
| `smtpfast received reply <id>` | `POST /v1/emails/receiving/{id}/reply` | Reply to a received email |

#### segments

Group contacts into segments

| Command | API | What it does |
| --- | --- | --- |
| `smtpfast segments contacts <id>` | `GET /v1/segments/{id}/contacts` | List contacts in a segment |
| `smtpfast segments create` | `POST /v1/segments` | Create a segment |
| `smtpfast segments delete <id>` | `DELETE /v1/segments/{id}` | Delete a segment |
| `smtpfast segments get <id>` | `GET /v1/segments/{id}` | Retrieve a segment |
| `smtpfast segments list` | `GET /v1/segments` | List segments |
| `smtpfast segments update <id>` | `PATCH /v1/segments/{id}` | Update a segment |

#### suppressions

Addresses that SMTPfast will not send to

| Command | API | What it does |
| --- | --- | --- |
| `smtpfast suppressions create` | `POST /v1/suppressions` | Create a manual suppression |
| `smtpfast suppressions delete <id>` | `DELETE /v1/suppressions/{id}` | Delete a suppression |
| `smtpfast suppressions get <id>` | `GET /v1/suppressions/{id}` | Retrieve a suppression |
| `smtpfast suppressions list` | `GET /v1/suppressions` | List suppressions |

#### webhooks

Configure webhook endpoints for delivery events

| Command | API | What it does |
| --- | --- | --- |
| `smtpfast webhooks create` | `POST /v1/webhooks` | Create webhook |
| `smtpfast webhooks delete <id>` | `DELETE /v1/webhooks/{id}` | Delete webhook |
| `smtpfast webhooks deliveries <id>` | `GET /v1/webhooks/{id}/deliveries` | List webhook deliveries |
| `smtpfast webhooks get <id>` | `GET /v1/webhooks/{id}` | Get webhook |
| `smtpfast webhooks get-delivery <id> <delivery_id>` | `GET /v1/webhooks/{id}/deliveries/{delivery_id}` | Get a webhook delivery |
| `smtpfast webhooks list` | `GET /v1/webhooks` | List webhooks |
| `smtpfast webhooks replace <id>` | `PUT /v1/webhooks/{id}` | Update webhook |
| `smtpfast webhooks retry-delivery <id> <delivery_id>` | `POST /v1/webhooks/{id}/deliveries/{delivery_id}/retry` | Retry a webhook delivery |
| `smtpfast webhooks test <id>` | `POST /v1/webhooks/{id}/test` | Test webhook |
| `smtpfast webhooks update <id>` | `PATCH /v1/webhooks/{id}` | Update webhook |
<!-- END COMMAND REFERENCE -->

## Exit codes

| Code | Meaning |
| --- | --- |
| 0 | Success |
| 1 | The API returned an error, the network failed, or `domains verify --wait` timed out |
| 2 | Usage or setup error: unknown command or flag, missing argument, invalid JSON, no API key |
| 130 | Stopped with Ctrl-C. `logs tail` exits with 0 instead, since Ctrl-C is how it ends. |

## Environment variables

| Variable | What it does |
| --- | --- |
| `SMTPFAST_API_KEY` | API key. Takes precedence over the stored profile. |
| `SMTPFAST_BASE_URL` | API base URL. Default `https://smtpfa.st/api`. |
| `SMTPFAST_PROFILE` | Profile to use. |
| `SMTPFAST_NO_UPDATE_CHECK` | Set to `1` to turn off the background spec refresh. |
| `SMTPFAST_SPEC_URL` | Where the background refresh gets the spec. Default `<base URL>/v1/openapi.json`. |
| `SMTPFAST_DEBUG` | Set to `1` to print each HTTP request to stderr, like `--debug`. |
| `NO_COLOR` | Turns colors off. |
| `XDG_CONFIG_HOME` | Moves the config directory. Default `~/.config/smtpfast`. |

## Contributing

You need [bun](https://bun.sh) 1.3 or later.

```sh
bun install
bun test                         # the full suite; it never touches the network
bun run typecheck
bun src/cli.ts --help            # run from source
npm run build                    # plain JavaScript in dist/ for Node
bun scripts/generate.ts          # regenerate after changing spec/openapi.json or the naming rules
bun scripts/build-binaries.ts    # standalone binaries in dist-bin/
```

Do not edit `src/generated/manifest.json` or the command reference above by hand. Change `spec/openapi.json`, the naming rules in `src/spec/naming.ts`, or a hand-written command in `src/commands/`, then run the generator. Bug reports and pull requests are welcome at <https://github.com/smtpfast/smtpfast-cli>.

## License

MIT. See [LICENSE](LICENSE).
