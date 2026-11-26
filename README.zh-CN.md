# VulcanSkills

[English](README.md)

VulcanSkills 面向 Vulcan Code 和 [DeepSeek Harness（DSH）](https://github.com/deepseek-ai/deepseek-harness)，提供语言无关的技能包。技能包可以为 AI 提供使用说明、可调用工具，或同时提供两者。每个工具分别声明入口，同一个包可以混用不同语言。

## 接入目标

1. **基于 DSH fork 的 Vulcan Code** 是首要接入目标。VulcanSkills 将复用产品宿主的工具注册、审批、取消和结果展示。
2. **[dsh-vulcancode](https://github.com/OpenVulcan/dsh-vulcancode)** 面向使用上游 DSH 的用户，计划通过插件套件加载同一套技能包。

## 技能包

- `SKILL.md` 说明技能的使用时机和用法。纯指引技能可以只包含这一个文件。
- **TypeScript（Node.js）** 优先用于工具入口和任务编排，**Python** 用于文档处理、PDF 解析和 OCR 等任务。
- **Lua** 是可选运行时，供声明了 Lua 入口的技能包使用。
- 两种宿主接入使用同一套包格式。可执行工具进入宿主现有的工具执行和审批流程。

## 项目状态

当前仓库记录项目方向和计划中的宿主接入。技能包规范与运行时处于早期设计阶段。

## 许可证

[MIT](LICENSE)
