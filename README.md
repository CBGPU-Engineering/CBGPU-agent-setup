# CBGPU Agent Setup

CBGPU Agent Setup is a portable installer for OpenClaw and Hermes Agent.
Download the executable for your laptop or desktop from
[GitHub Releases](https://github.com/CBGPU-Engineering/CBGPU-agent-setup/releases).
It opens a private setup screen in your browser. Once setup is finished, close
and remove the downloaded installer. The installed agent and any shortcuts
you enabled can run separately.

| Operating system | Download |
| --- | --- |
| Windows | The x64 `.exe` |
| Linux | The x64 or ARM64 `.AppImage` |
| macOS | The Apple Silicon or Intel `.zip`, containing a `.app` |

Choose OpenClaw for workflows involving several apps or websites. Choose Hermes
for longer tasks you want to resume and instructions you want to retain as
skills. Both can receive tasks through Telegram. Use a different bot for
each agent if running both.

Once a CBGPU model is connected, you can choose permissions, enable startup at
desktop login, and use the manual shortcut shown on the completion screen.
Windows still uses the system lid action. macOS uses its closed-display
requirements. The CBGPU API must list a compatible model for AI and Telegram
tasks. The installer can also install just the upstream program.

To update an existing Hermes (CBGPU) shortcut, open the new setup executable
and select **Hermes 바로가기 업데이트**. The updater preserves the Hermes
configuration, conversations and credentials.

The `cbgpu` terminal coding tool lives in
[CBGPU-agent](https://github.com/CBGPU-Engineering/CBGPU-agent).

## Development

```sh
npm ci
npm run check
npm test
npm run build:setup-executable
```

Use Node.js 26.13.1 for desktop releases. Outputs and checksums are written to
`release-setup/`. The build workflow checks Linux x64 and ARM64, Windows x64,
and macOS Intel and Apple Silicon.

## License

Apache 2.0. The original Node.js, OpenClaw and Hermes notices are included
under `assets/setup/`. The release files also include the ISC notice for the
bundled YAML parser.
