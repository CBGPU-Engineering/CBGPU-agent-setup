# Hermes on CBGPU Server Deployment

Use this directory as the Compose project root. Select the `hermes` gateway
service with container port `8642` and private access. The gateway API requires
its own key, supplied as `HERMES_GATEWAY_API_KEY` in the deployment's secret
environment variables. The dashboard stays disabled.

Set `CBGPU_API_KEY` to a key for this Hermes instance. To connect Telegram, use
a separate bot and set `HERMES_TELEGRAM_BOT_TOKEN` and
`HERMES_TELEGRAM_ALLOWED_USERS`. Leave both variables unset to run without it.

The managed `hermes-data` volume mounts at `/opt/data`. The operator can prepare
`/opt/data/workspace` and initialize `/opt/data/config.yaml` with:

```yaml
model:
  default: cbgpu-qwen38
  provider: custom
  base_url: https://cbgpu.com/api/ai/v1
  key_env: CBGPU_API_KEY
terminal:
  backend: local
  cwd: /opt/data/workspace
```

Run Hermes with UID/GID 10000 inside the container. Config, history and output
files persist under `/opt/data` across container replacement. Keep the same
Compose volume name when upgrading. The workspace and session database should
both be included in any project backup.
