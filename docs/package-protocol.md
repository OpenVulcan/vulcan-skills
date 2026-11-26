# VulcanSkills 技能包协议 v1

本文定义 VulcanSkills `0.1.0` 实现的技能包协议 `1.0.0`，供基于 DSH 分支的 Vulcan Code 和 `dsh-vulcancode` 共用。安装与宿主接入见[使用文档](usage.md)。进程通信和 Worker 池属于宿主实现。

## 版本与兼容

| 值 | 来源 | 含义 |
| --- | --- | --- |
| `version` | 技能清单 | 技能包自己的 [SemVer](https://semver.org/lang/zh-CN/)，用于发布和升级。 |
| `protocol` | 技能清单 | 技能包支持的 **VulcanSkills 技能包协议版本范围**。 |
| 具体协议版本集合 | 宿主实现 | 当前宿主实际实现的协议及其对应的 Schema 和语义校验。 |
| VulcanSkills 发行版本 | 宿主集成 | 选择随该发行版发布的共享工具链，包括解释器和依赖管理器。 |

VulcanSkills 自身的发布版本与 DSH 版本属于宿主实现。清单的 `protocol` 不引用这两个版本。

`protocol` 由一个或多个 `>=A <B` 区间组成，多个区间用 ` || ` 分隔。端点必须是无预发行和构建后缀的完整三段版本。每个区间必须满足 `A < B`，上界最多到下一个主版本的 `.0.0`。例如 `>=1.0.0 <2.0.0`。技能包使用协议 1.1 才引入的字段时，左端点须至少为 `1.1.0`。声明多个主版本时，同一份清单和行为必须满足声明的各个区间。

宿主先按 UTF-8 JSON 读取固定的 `id`、`version`、`protocol` 字段并校验它们，同一对象内重复的键须拒绝。随后在自身实现的具体协议版本中选择满足范围的最高版本。不存在交集时直接拒绝。版本选定后，用对应 Schema 和语义规则校验整包，失败时返回错误。在此之前不得加载入口、注册工具或准备依赖。宿主记录实际选中的协议版本，与已安装包的内容摘要关联。

不兼容的包结构或行为变更增加协议主版本，可选的兼容扩展增加次版本，兼容的勘误增加修订版本。已经发布的协议 Schema 按版本保留。旧包能否继续运行，取决于协议范围和共享工具链能否满足依赖。技能包版本另行递增，同一 `id + version` 只能对应一份发布内容。

## 发行版共享工具链

一个 VulcanSkills 发行主版本固定一个 Node.js 主版本和一个 CPython `major.minor` 系列。例如可以选 Node.js `24.x` 和 CPython `3.14.x` 作为一组长期基线。CPython 锁到 `major.minor`，因为带扩展的 Wheel 可能要求该次版本的 ABI。实际基线以 VulcanSkills 发行清单为准。 [Python Wheel 兼容标签](https://packaging.python.org/en/latest/specifications/platform-compatibility-tags/)

每次 VulcanSkills 发布为每种受支持平台列出该发行版实际使用的 Node.js、CPython、pnpm 和 uv 精确版本，以及对应下载产物和校验摘要。基于 DSH 分支的 Vulcan Code 和 `dsh-vulcancode` 选用同一 VulcanSkills 发行版时，解析到同一组工具链。Node 主版本和 CPython 次版本系列的切换随 VulcanSkills 主版本升级。系列内校验通过的补丁升级由发行版统一推进，技能清单无需因此改协议范围。

宿主只为当前发行版激活每种语言的一个解释器。有技能首次需要该语言时，按发行清单准备共享解释器，并合并并发请求。每个技能的 `node_modules` 或 Python 虚拟环境可以按锁文件隔离，所有环境都使用同一共享解释器。旧进程退出前可保留其原版本，之后旧版本退出当前调度。技能安装或调用只使用当前发行版选中的工具链。

## 包结构

```text
vulcan-skill.json
SKILL.md                         # 声明 guide 时包含
schemas/                         # 可执行工具的输入、输出 Schema
node/
  dist/                          # 发布时已构建的 .mjs 入口和随包模块
  package.json                   # 声明 Node 依赖时包含
  pnpm-lock.yaml
python/
  *.py                           # Python 入口和随包模块，可分子目录
  pyproject.toml                 # 声明 Python 依赖时包含
  uv.lock
```

`vulcan-skill.json` 位于包根目录。纯指引技能包含清单和 `SKILL.md`。可执行技能可选带指引，隐式工具必须有指引。清单引用的包内路径使用 ASCII 字母、数字、下划线、连字符、点和正斜杠，按包根目录解析。安装器须拒绝越界路径、符号链接、重复归档条目和在目标文件系统上冲突的路径。启用前核对清单引用的是普通文件。

依赖文件和入口归各自的语言目录。清单仅声明使用哪种运行时和是否有锁定依赖。

```json
{
  "id": "openvulcan.document-tools",
  "version": "0.1.0",
  "protocol": ">=1.0.0 <2.0.0",
  "name": "Document Tools",
  "description": "Inspect documents and extract text from PDFs.",
  "guide": "SKILL.md",
  "runtimes": {
    "node": { "dependencies": "locked" },
    "python": { "dependencies": "locked" }
  },
  "tools": [
    {
      "id": "inspect_document",
      "description": "Inspect a document's format and metadata.",
      "runtime": "node",
      "entry": "node/dist/inspect.mjs",
      "export": "run",
      "invocation": "explicit",
      "inputSchema": "schemas/inspect.input.json"
    },
    {
      "id": "extract_pdf_text",
      "description": "Extract text from a PDF.",
      "runtime": "python",
      "entry": "python/extract_pdf.py",
      "export": "run",
      "invocation": "implicit",
      "inputSchema": "schemas/extract_pdf.input.json",
      "outputSchema": "schemas/extract_pdf.output.json"
    }
  ]
}
```

`id` 是稳定的发布者命名空间加包名，安装来源由宿主绑定。包内工具 ID 唯一，由宿主以包 ID 和工具 ID 形成可调用名称，遇到冲突直接报错。每个工具固定选择一个运行时、相对入口和导出。注册只读声明。执行先按对应工具校验输入并通过 DSH 审批，再由宿主调用固定入口。隐式调用同样走具体工具的审批。输入 Schema 的根为对象，输入和可选输出 Schema 均使用 JSON Schema Draft 2020-12，引用限于当前 Schema 文档。

## 源码、发布包与依赖来源

技能仓库可以用 TypeScript 或 JavaScript 开发。发布端把 TypeScript 编译成 `node/dist/` 下的 ESM。宿主直接加载清单指向的 `.mjs` 导出。Python 发布 `.py` 和随包模块，从绑定的解释器环境加载。v1 的工具运行时定义 Node.js 与 Python，后续语言须有对应协议定义。

| 来源 | 负责方 | 约束 |
| --- | --- | --- |
| 技能包 | 宿主安装配置 | 可安装用户选择的准备目录或 npm `.tgz`，也可从配置的 npm Registry 下载精确版本并校验 SHA-512。安装目录记录技能包身份、版本与展开内容的 SHA-256。 |
| Node.js、Python、pnpm、uv | VulcanSkills 发行清单 | 依据当前 VulcanSkills 发行版和目标平台选择共享工具链并校验完整性。 |
| npm 包和 Python Wheel | 宿主依赖源配置 | Node 使用宿主配置的 npm Registry，Python 使用 PyPI。包清单不传 Registry URL、凭据、环境变量覆盖或安装命令。 |

`runtimes.<语言>.dependencies` 为 `locked` 时，必须提供对应目录中的依赖声明与锁文件。为 `none` 时，入口只依赖同包代码和该语言标准库。v1 每个语言目录是独立项目。

作者使用目标 VulcanSkills 发行版提供的 pnpm 或 uv 生成锁文件。`package.json` 的 `engines.node` 和 `pyproject.toml` 的 `requires-python` 可声明兼容要求，宿主用当前选定的解释器检查这些要求。`packageManager` 等构建元数据不参与宿主工具链选择，依赖管理器自动下载或切换解释器和管理器的功能须关闭。当前发行工具链不满足要求或无法读取锁文件时，返回明确错误。

- **Node.js** 使用固定版本的 pnpm，按 `pnpm install --prod --frozen-lockfile --ignore-scripts` 的行为安装生产依赖。宿主生成 Registry 配置，校验锁文件及实际拉取的依赖，限制到获准的 Registry 或经批准的镜像，并核对完整性。项目配置和锁文件中的直链不得绕过宿主源策略。v1 依赖来自 Registry，Git、任意 URL、本地目录和工作区引用均拒绝。需要安装脚本编译的依赖应在发布侧先解决，再以无需安装脚本的产物交付。 [pnpm 安装参数](https://pnpm.io/cli/install)
- **Python** 使用固定版本的 uv、`pyproject.toml` 和 `uv.lock` 解析指定平台的生产依赖。宿主按锁定版本和哈希安装已获准的第三方 Wheel，直接加载随包源码。锁文件发生变化、平台缺 Wheel、来源违规或依赖需要现场构建时，安装失败。开发组、可编辑安装、Git、任意 URL、本地目录和工作区依赖均不进入运行环境。 [uv 锁定与同步](https://docs.astral.sh/uv/concepts/projects/sync/)

依赖环境按技能内容摘要、语言、当前发行工具链、平台和获准来源配置区分。来源身份使用配置标识，不含凭据。宿主按环境身份合并并发准备请求，准备成功后发布可用标记。环境的绝对路径在准备时固定，便于 Python 虚拟环境记录解释器路径。旧环境继续供已接纳的调用使用。

## 校验入口

- [协议 1.0.0 清单 Schema](../schemas/1.0.0/vulcan-skill.schema.json) 校验字段、类型、固定目录与工具运行时映射。
- 宿主还须校验版本区间顺序、工具 ID 唯一性、声明资源是否存在、真实路径归属、依赖文件与来源、解释器和管理器可用性。所有工具使用的运行时都须声明。只有当某个运行时存在工具入口时才准备该语言环境。
- Worker 进程、复用策略、队列和配额属于宿主执行合同，技能包协议独立演进。
