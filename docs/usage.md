# VulcanSkills 0.1.0 使用与接入

## 管理技能

在项目目录运行 `npm ci`。以下命令使用源码入口。安装了运行器 npm 包时，也可以使用 `vulcan-skills` 命令。

```sh
node src/cli.js install ./examples/echo
node src/cli.js list
node src/cli.js show openvulcan.echo
node src/cli.js mode openvulcan.echo node_echo implicit
node src/cli.js mode openvulcan.echo node_echo default
node src/cli.js disable openvulcan.echo
node src/cli.js enable openvulcan.echo
node src/cli.js uninstall openvulcan.echo
```

`show` 返回技能的版本、安装来源、指引内容、工具名和生效模式。再次安装同 ID 的更高版本时保留启停和仍有效的模式设置。卸载会移除注册，已安装的不可变包和依赖缓存保留在数据目录中。

CLI 和 DSH 共用 `VULCANSKILLS_HOME`。未设置时使用 `$DSH_HOME/vulcan-skills`，DSH home 未设置时使用 `~/.dsh/vulcan-skills`。`--home` 可为单次 CLI 命令指定其他目录。

## 从 npm 源安装技能

Registry 中的技能包须在 tarball 根目录包含 `vulcan-skill.json`，清单的技能包版本须等于 npm 包版本。下面的名字和版本是命令示例，可替换为实际发布的技能包。

```sh
node src/cli.js registry https://registry.npmjs.org/
node src/cli.js install npm:@example/my-skill@1.2.3
node src/cli.js install ./my-skill-1.2.3.tgz
```

`registry` 管理默认 npm 源。`install --registry <url>` 只覆盖本次技能包下载，生产依赖继续使用默认源。安装器要求精确版本并校验 Registry 公布的 SHA-512。Node 生产依赖由 pnpm 读取锁文件，Python 生产依赖由 uv 从 PyPI 锁定的 Wheel 安装。

## 接入兼容的 DSH profile

在源码目录打包，把生成的本地 `.tgz` 安装到实际使用的 profile。

```sh
npm pack
dsh plugin --profile web add ./openvulcan-vulcan-skills-0.1.0.tgz
dsh --profile web
```

也可以在自建的 profile 中加入同一个 DSH bundle。开发时可用 `--patch` 加载源码，将绝对路径写入 `name`。

```yaml
- insert:
    - id: vulcan-skills
      name: /absolute/path/to/vulcan-skills/src/dsh.js
```

同一个目录下的管理变更会更新 DSH 技能和工具目录。显式动作使用 `show` 返回的工具名。隐式动作须有 `SKILL.md`，模型可从 DSH 的技能列表加载其指引，再传入指引标出的技能名、动作 ID 和参数。可见性和权限仍由宿主判断。`run` 命令用于本机用户直接测试，与 DSH 中的工具调用入口独立。

## 运行时

0.1.0 统一使用 Node.js `24.18.0`、CPython `3.14.6`、pnpm `11.11.0` 和 uv `0.12.10`。解释器首次按需下载，同一份发行版中的技能共享解释器，每个技能使用自己的锁定依赖环境。TypeScript 入口须构建成 ESM 后打包。

Worker 按技能版本、语言、依赖环境、工作目录与宿主会话策略隔离，空闲时回收。取消会终止当前 Worker，后续调用重新分配。第一版的管理入口是 CLI，源码提供可加载的 DSH bundle。
