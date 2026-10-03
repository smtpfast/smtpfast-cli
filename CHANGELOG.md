# Changelog

All notable changes to the smtpfast CLI. The spec sync workflow adds an entry for each release it publishes.

## [0.3.0] - 2026-10-03

Updated from the live API spec.

The API spec changed, but no command, argument or flag did. Help text may have changed.

## [0.2.2] - 2026-10-03

### Changed

- The release workflow no longer reads an npm token at all; publishing relies only on trusted publishing.

## [0.2.1] - 2026-10-03

### Changed

- Releases are published with npm trusted publishing: GitHub Actions proves its identity to npm, so no npm token is stored anywhere. Each version carries provenance that links it to the commit and workflow that built it.

## [0.2.0] - 2026-10-03

Updated from the live API spec.

### New commands

- `smtpfast broadcasts audience` (GET /v1/broadcasts/audience): Preview a broadcast audience
- `smtpfast broadcasts recipients` (GET /v1/broadcasts/{id}/recipients): List broadcast recipients
- `smtpfast contacts add-to-segment` (POST /v1/contacts/{id}/segments/{segment_id}): Add a contact to a segment
- `smtpfast contacts delete-many` (DELETE /v1/contacts): Delete contacts in bulk
- `smtpfast contacts remove-from-segment` (DELETE /v1/contacts/{id}/segments/{segment_id}): Remove a contact from a segment
- `smtpfast contacts segments` (GET /v1/contacts/{id}/segments): List a contact's segments
- `smtpfast domains delete` (DELETE /v1/domains/{id}): Delete a domain
- `smtpfast domains start-cloudflare-connect` (POST /v1/domains/{id}/domain-connect/cloudflare): Set up sending DNS on Cloudflare in one click
- `smtpfast domains start-cloudflare-inbound-connect` (POST /v1/domains/{id}/domain-connect/cloudflare-inbound): Set up receiving DNS on Cloudflare in one click
- `smtpfast emails clicked-links` (GET /v1/emails/clicked-links): List clicked links
- `smtpfast emails metrics` (GET /v1/emails/metrics): Retrieve email metrics
- `smtpfast forms preview-welcome-email` (POST /v1/forms/{id}/welcome-preview): Preview a form's welcome email
- `smtpfast inboxes create` (POST /v1/inboxes): Create an inbox
- `smtpfast inboxes create-draft` (POST /v1/inboxes/{inbox_id}/drafts): Create a draft
- `smtpfast inboxes create-label` (POST /v1/inboxes/{inbox_id}/labels): Create a label
- `smtpfast inboxes delete` (DELETE /v1/inboxes/{inbox_id}): Delete an inbox
- `smtpfast inboxes delete-draft` (DELETE /v1/inboxes/{inbox_id}/drafts/{draft_id}): Delete a draft
- `smtpfast inboxes delete-label` (DELETE /v1/inboxes/{inbox_id}/labels/{label_id}): Delete a label
- `smtpfast inboxes delete-thread` (DELETE /v1/inboxes/{inbox_id}/threads/{thread_id}): Delete a thread
- `smtpfast inboxes drafts` (GET /v1/inboxes/{inbox_id}/drafts): List drafts
- `smtpfast inboxes forward-thread-email` (POST /v1/inboxes/{inbox_id}/threads/{thread_id}/emails/{email_id}/forward): Forward a thread email
- `smtpfast inboxes get` (GET /v1/inboxes/{inbox_id}): Retrieve an inbox
- `smtpfast inboxes get-draft` (GET /v1/inboxes/{inbox_id}/drafts/{draft_id}): Retrieve a draft
- `smtpfast inboxes get-thread` (GET /v1/inboxes/{inbox_id}/threads/{thread_id}): Retrieve a thread
- `smtpfast inboxes get-thread-email` (GET /v1/inboxes/{inbox_id}/threads/{thread_id}/emails/{email_id}): Retrieve a thread email
- `smtpfast inboxes labels` (GET /v1/inboxes/{inbox_id}/labels): List labels
- `smtpfast inboxes list` (GET /v1/inboxes): List inboxes
- `smtpfast inboxes reply-to-thread-email` (POST /v1/inboxes/{inbox_id}/threads/{thread_id}/emails/{email_id}/reply): Reply to a thread email
- `smtpfast inboxes send-draft` (POST /v1/inboxes/{inbox_id}/drafts/{draft_id}/send): Send a draft
- `smtpfast inboxes thread-emails` (GET /v1/inboxes/{inbox_id}/threads/{thread_id}/emails): List thread emails
- `smtpfast inboxes threads` (GET /v1/inboxes/{inbox_id}/threads): List threads
- `smtpfast inboxes update` (PATCH /v1/inboxes/{inbox_id}): Update an inbox
- `smtpfast inboxes update-draft` (PATCH /v1/inboxes/{inbox_id}/drafts/{draft_id}): Update a draft
- `smtpfast inboxes update-label` (PATCH /v1/inboxes/{inbox_id}/labels/{label_id}): Update a label
- `smtpfast inboxes update-thread` (PATCH /v1/inboxes/{inbox_id}/threads/{thread_id}): Update a thread
- `smtpfast received mark` (PATCH /v1/emails/receiving): Mark received emails read or unread
- `smtpfast received update` (PATCH /v1/emails/receiving/{id}): Mark a received email read or unread
- `smtpfast suppressions add-batch` (POST /v1/suppressions/batch/add): Suppress addresses in bulk
- `smtpfast suppressions remove-batch` (POST /v1/suppressions/batch/remove): Remove suppressions in bulk
- `smtpfast team create-invite` (POST /v1/team/invites): Invite someone to the team
- `smtpfast team invites` (GET /v1/team/invites): List pending invitations
- `smtpfast team members` (GET /v1/team/members): List team members
- `smtpfast team remove-member` (DELETE /v1/team/members/{id}): Remove a member
- `smtpfast team revoke-invite` (DELETE /v1/team/invites/{id}): Revoke an invitation
- `smtpfast team update-member` (PATCH /v1/team/members/{id}): Change a member's role or billing access
- `smtpfast templates create` (POST /v1/templates): Create a template
- `smtpfast templates delete` (DELETE /v1/templates/{id}): Delete a template
- `smtpfast templates duplicate` (POST /v1/templates/{id}/duplicate): Duplicate a template
- `smtpfast templates get` (GET /v1/templates/{id}): Get a template
- `smtpfast templates list` (GET /v1/templates): List templates
- `smtpfast templates publish` (POST /v1/templates/{id}/publish): Publish a template
- `smtpfast templates update` (PATCH /v1/templates/{id}): Update a template
- `smtpfast webhooks event-attempts` (GET /v1/webhooks/{id}/events/{event_id}/attempts): List the attempts of a webhook event
- `smtpfast webhooks events` (GET /v1/webhooks/{id}/events): List webhook events
- `smtpfast webhooks get-event` (GET /v1/webhooks/{id}/events/{event_id}): Retrieve a webhook event
- `smtpfast webhooks replay-event` (POST /v1/webhooks/{id}/events/{event_id}/replay): Replay a webhook event
- `smtpfast webhooks rotate-signing-secret` (POST /v1/webhooks/{id}/signing-secret/rotate): Rotate a webhook signing secret

### Changed commands

- `smtpfast broadcasts create`: new flags --template-id; now optional: --name
- `smtpfast broadcasts update`: new flags --template-id; now optional: --name
- `smtpfast contact-properties create`: new flags --fallback-value, --key, --type
- `smtpfast contact-properties update`: new flags --fallback-value
- `smtpfast emails send`: new flags --bcc, --cc, --headers, --reply-to, --scheduled-at, --tags, --template; now optional: --from, --subject
- `smtpfast received list`: new flags --domain-id, --q, --to, --unread

## [0.1.0] - 2026-10-03

First release.

- A command for each of the 78 operations in the SMTPfast API spec, generated from the OpenAPI document.
- Hand-written commands: `send`, `domains verify --wait`, `logs tail`, `api`, `login`, `logout`, `whoami`, `profiles`, `commands`, `completion` and `version`.
- Named profiles, with the key stored in a config file readable only by its owner.
- Tables on a terminal, JSON when piped, and `--quiet` for ids.
- One retry on HTTP 429 after `Retry-After`, and `--idempotency-key` on any command.
- A background refresh of the live spec, so new API operations run before the next release.
- Completion for bash, zsh and fish.
- Standalone binaries for Linux, macOS and Windows.
