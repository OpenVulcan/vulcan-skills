# VulcanSkills

[简体中文](README.zh-CN.md)

VulcanSkills is a language-independent skill package project for Vulcan Code and [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness). A skill package can provide instructions for an agent, callable tools, or both. Tool entry points are declared individually, so one package can mix languages.

## Integration targets

1. **Vulcan Code built on a DSH fork** is the primary integration target. VulcanSkills will use the bundled host's tool registry, approval flow, cancellation, and result display.
2. **[dsh-vulcancode](https://github.com/OpenVulcan/dsh-vulcancode)** is the integration target for users of upstream DSH. It is intended to load the same skill packages through its plugin suite.

## Skill packages

- `SKILL.md` explains when and how to use a skill. An instruction-only skill can consist of this file alone.
- **TypeScript on Node.js** is the first target for tool entry points and orchestration. **Python** covers tasks such as document processing, PDF parsing, and OCR.
- **Lua** is an optional runtime target for packages that declare Lua entry points.
- Each host integration will use the same package format and register executable tools through the host's normal execution and approval flow.

## Status

This repository currently documents the project direction and planned host integrations. The package specification and runtime are in early design.

## License

[MIT](LICENSE)
