# VulcanSkills

[English](README.md)

VulcanSkills 面向 Vulcan Code 和 [DeepSeek Harness（DSH）](https://github.com/deepseek-ai/deepseek-harness)，提供语言无关的技能包。技能包可以为 AI 提供使用说明、可调用工具，或同时提供两者。每个工具分别声明入口，同一个包可以混用不同语言。

## 本地试用

在源码目录用 Node.js 24 或更新版本运行：

```sh
npm ci
node src/cli.js install ./examples/echo
node src/cli.js list
node src/cli.js show openvulcan.echo
node src/cli.js run openvulcan.echo node_echo --args '{"text":"hello"}'
node src/cli.js run openvulcan.echo python_echo --args '{"text":"hello"}'
```

CLI 支持安装、升级、查看、启停、卸载及切换单个工具的调用模式。技能可以从发布目录、npm `.tgz` 或配置的 npm Registry 安装。安装时校验协议和包内容，第一次调用时准备共享解释器和该技能的锁定依赖。

## 接入 DSH

VulcanSkills 自带 DSH bundle，可加载到基于 DSH 的 Vulcan Code，也可和 [dsh-vulcancode](https://github.com/OpenVulcan/dsh-vulcancode) 装进同一个兼容 profile。显式工具直接出现在宿主工具列表，隐式工具从技能指引发现，通过 `vulcan_skills_call` 执行。两种方式都经过 DSH 工具策略。

详见[使用与接入](docs/usage.md)。第一版实现了 Node.js 和 Python；[技能包协议](docs/package-protocol.md)和[清单 Schema](schemas/1.0.0/vulcan-skill.schema.json)供技能作者使用。

## 许可证

[MIT](LICENSE)
