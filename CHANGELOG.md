# Changelog

All notable changes to the smtpfast CLI. The spec sync workflow adds an entry for each release it publishes.

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
