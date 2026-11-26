# VulcanSkills

[简体中文](README.zh-CN.md)

VulcanSkills is a language-independent skill package project for Vulcan Code and [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness). A skill package can provide instructions for an agent, callable tools, or both. Tool entry points are declared individually, so one package can mix languages.

## Try the first version

From the checkout, with Node.js 24 or later:

```sh
npm ci
node src/cli.js install ./examples/echo
node src/cli.js list
node src/cli.js show openvulcan.echo
node src/cli.js run openvulcan.echo node_echo --args '{"text":"hello"}'
node src/cli.js run openvulcan.echo python_echo --args '{"text":"hello"}'
```

The CLI installs, upgrades, inspects, enables, disables, and uninstalls skills, and changes each tool's invocation mode. Install from a prepared directory, an npm `.tgz`, or a configured npm registry. The first call prepares the shared interpreter and the skill's locked dependencies.

## DSH integration

The bundled DSH plugin can be loaded by a compatible DSH-based Vulcan Code host or installed alongside [dsh-vulcancode](https://github.com/OpenVulcan/dsh-vulcancode). Explicit tools appear individually in the host tool list. Implicit actions are documented in skill guides and routed through `vulcan_skills_call`. Both modes go through DSH's tool policies.

See the [usage and integration guide in Chinese](docs/usage.md), the [package protocol](docs/package-protocol.md), and the [manifest schema](schemas/1.0.0/vulcan-skill.schema.json). The first version implements Node.js and Python.

## License

[MIT](LICENSE)
