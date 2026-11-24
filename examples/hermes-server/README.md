# Hermes on CBGPU Server Deployment

Use this directory as the Compose project root. Select the `hermes` gateway
service with container port `8642` and private access. Configure these deployment
environment variables in CBGPU:

- `HERMES_GATEWAY_API_KEY` — the key for the private gateway API
- `CBGPU_API_KEY` — the CBGPU AI key for this Hermes instance
- `HERMES_TELEGRAM_BOT_TOKEN` — a Telegram bot dedicated to this deployment
- `HERMES_TELEGRAM_ALLOWED_USERS` — the one Telegram user ID allowed to send DMs

The startup hook merges the CBGPU model, Telegram DM policy, and workspace
settings into the existing Hermes profile. The runtime uses UID/GID 10000.
The `hermes-data` volume retains config, history, and `/opt/data/workspace`
across container replacement. Keep the volume name when upgrading.

The health check requires Telegram polling to be connected. On every container
start it also verifies Telegram `getMe`, the CBGPU model catalog, a short answer
through the Hermes API, and workspace writes. It prints only safe failure
categories and sends no Telegram messages.
