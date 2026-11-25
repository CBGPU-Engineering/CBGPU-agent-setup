# Private Hermes server

Deploy this directory as a CBGPU Compose project with gateway service `hermes`,
port `8642`, and private access. The `hermes-data` volume retains the profile
and `/opt/data/workspace`. On first start the container creates a gateway key
in `/opt/data/.env` with owner-only permissions.

The gateway can start before a model is configured. Add these variables to the
CBGPU project, then redeploy:

- `HERMES_MODEL_BASE_URL` — the HTTPS base URL of the OpenAI-compatible API
- `HERMES_MODEL_ID` — the API's model identifier
- `HERMES_MODEL_API_KEY` — inference key if required by the selected provider

The configured model uses streaming chat completions. The gateway and inference
keys serve different purposes. The container reads the inference key from its
environment.
