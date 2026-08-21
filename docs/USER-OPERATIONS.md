# Three.js Editor MCP 用户操作

## 三个项目的关系

| 组件 | 类型 | 职责 |
|---|---|---|
| `deepseek-harness` / `dsh` | Agent Runtime 与 Web Host | 启动 Web、管理 Profile、Session、LLM、Workspace 和 Agent Loop |
| `dsh-uni-editor` | DSH Cordis bundle 插件 | 管理 MCP 连接，把 MCP tools 注册到 DSH，并在 Web 中托管 MCP App |
| `threejs-editor-mcp` | stdio MCP Server + MCP App Resource | 提供 Three.js tools、Editor HTML、Workspace revision 和文件事务 |

`threejs-editor-mcp` **不是 DSH 插件**，不会被 `dsh plugin add` 直接加载。
DSH 只加载 `dsh-uni-editor`；`dsh-uni-editor` 再根据自己的 `servers` 配置启动
`threejs-editor-mcp` 子进程：

```text
dsh web
  -> Web profile 加载 dsh-uni-editor
  -> dsh-uni-editor 读取 config.servers
  -> spawn threejs-editor-mcp (stdio)
  -> tools/list 注册为 DSH model tools
  -> resources/read 获取 Three.js Editor MCP App
  -> dsh-uni-editor 在 Chat 卡片中渲染 App
```

用户在 DSH Web 中选择游戏目录后：

```text
DSH Workspace picker
  -> Session.header.cwd
  -> dsh-uni-editor request _meta
  -> threejs-editor-mcp 动态注册 Linked Workspace
  -> 返回 opaque projectId
  -> Editor 原地读写该工程
```

`forwardWorkspace: true` 只把 DSH 已授权的 Session Workspace 作为可信
request metadata 传给本地 stdio Server。绝对路径不进入模型工具参数和结果。

## 为什么之前能运行，但 `~/.dsh` 没有配置

此前的 M6/M6.1 和真实 LLM 验收都使用了独立的临时 Harness Home：

```text
DSH_HOME=/tmp/threejs-editor-...
```

因此它们从未使用或修改默认的：

```text
~/.dsh/profiles/web/
```

各类验收的配置来源如下：

| 验收 | `dsh-uni-editor` 安装位置 | Three.js Server 配置 | LLM |
|---|---|---|---|
| M6/M6.1 确定性测试 | 临时 `$DSH_HOME/profiles/web` | 启动参数 `--patch tests/fixtures/m6/cordis.patch.yml` | Replay |
| M6.1 真实 LLM | 临时 `$DSH_HOME/profiles/web` | 临时 profile 的 `cordis.patch.yml` | `deepseek-official` |
| 普通用户长期使用 | 默认或自定义 Web profile | profile 的 `cordis.patch.yml` | 用户配置的真实 LLM |

Replay 验收的实际组合方式是：

```bash
DSH_HOME=/tmp/threejs-editor-m61-home \
pnpm dsh --profile web \
  --patch tests/fixtures/m6/replay.patch.yml \
  --patch tests/fixtures/m6/cordis.patch.yml
```

真实 LLM 验收没有加载 Replay。它先把 MCP Server 配置写入临时 profile，再启动：

```bash
DSH_HOME=/tmp/threejs-editor-real-home pnpm dsh web
```

所以“曾成功运行”只证明临时组合配置有效，不表示默认 `~/.dsh` 已经持久化。
测试使用临时 Home 是为了不污染用户已有的插件、凭据、Session 和 Workspace。

## `dsh-uni-editor` 如何配置 `threejs-editor-mcp`

配置分为两步。

### 第一步：把 `dsh-uni-editor` 安装到 Web profile

```bash
cd /path/to/deepseek-harness
pnpm dsh plugin --profile web add /path/to/dsh-uni-editor
```

该命令自动修改：

```text
~/.dsh/profiles/web/package.json
```

设置了 `DSH_HOME` 时，路径改为：

```text
$DSH_HOME/profiles/web/package.json
```

安装后 manifest 会包含：

```json
{
  "dependencies": {
    "@creative-dswork/dsh-uni-editor": "link:/path/to/dsh-uni-editor"
  },
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app",
        "@creative-dswork/dsh-uni-editor"
      ]
    }
  }
}
```

不要手工编辑该 `package.json`。`dsh plugin` 负责安装依赖和维护 bundle 列表。

`dsh-uni-editor` 自带的 `cordis.patch.yml` 只做一件事：

```yaml
- insert:
    - id: mcp-apps
      name: '@creative-dswork/dsh-uni-editor'
```

它把 Host 插件插入 DSH 配置树，但不知道用户要连接哪个 MCP Server。

### 第二步：在 Web profile 中配置 Three.js Server

编辑：

```text
~/.dsh/profiles/web/cordis.patch.yml
```

设置了 `DSH_HOME` 时，编辑：

```text
$DSH_HOME/profiles/web/cordis.patch.yml
```

将初始的 `[]` 替换为：

```yaml
- id: mcp-apps
  config:
    maxBodyBytes: 2097152
    servers:
      - serverName: threejs
        transport: stdio
        command: /absolute/path/to/threejs-editor-mcp/dist/server.js
        args:
          - --root
          - /absolute/path/to/threejs-editor-data
        cwd: /absolute/path/to/threejs-editor-mcp
        forwardWorkspace: true
```

字段含义：

| 字段 | 含义 |
|---|---|
| `serverName` | MCP 工具前缀，最终工具名类似 `mcp__threejs__open_editor` |
| `transport` | 使用本地 stdio MCP transport |
| `command` | `dsh-uni-editor` 要启动的 Server 可执行文件 |
| `args --root` | Editor Managed Workspace 数据目录，不是用户游戏目录 |
| `cwd` | MCP Server 子进程工作目录 |
| `forwardWorkspace` | 将当前 DSH Session Workspace 可信传给 Server |

不要修改 `/path/to/dsh-uni-editor/cordis.patch.yml` 来添加 Server。它是 npm bundle
的默认层；本机连接配置属于用户的 Web profile。

Cordis 按以下顺序组合配置：

```text
dsh-base bundle
  -> dsh-web-app bundle
  -> dsh-uni-editor bundle（插入 mcp-apps）
  -> Web profile cordis.patch.yml（配置 servers）
  -> $DSH_HOME/cordis.patch.yml
  -> 命令行 --patch overlays
```

## 当前本地 checkout 的持久配置步骤

### 1. 构建两个插件项目

```bash
cd /Users/bytedanceo/Workspace/DeepSeekSpace/dsh-uni-editor
pnpm run build

cd /Users/bytedanceo/Workspace/DeepSeekSpace/threejs-editor-mcp
pnpm run build
```

### 2. 安装 `dsh-uni-editor`

```bash
cd /Users/bytedanceo/Workspace/DeepSeekSpace/deepseek-harness
pnpm dsh plugin --profile web add \
  /Users/bytedanceo/Workspace/DeepSeekSpace/dsh-uni-editor
```

### 3. 写入 MCP Server 配置

编辑 `~/.dsh/profiles/web/cordis.patch.yml`：

```yaml
- id: mcp-apps
  config:
    maxBodyBytes: 2097152
    servers:
      - serverName: threejs
        transport: stdio
        command: /Users/bytedanceo/Workspace/DeepSeekSpace/threejs-editor-mcp/dist/server.js
        args:
          - --root
          - /Users/bytedanceo/Workspace/DeepSeekSpace/threejs-editor-mcp/.tmp/projects
        cwd: /Users/bytedanceo/Workspace/DeepSeekSpace/threejs-editor-mcp
        forwardWorkspace: true
```

检查最终组合结果：

```bash
cd /Users/bytedanceo/Workspace/DeepSeekSpace/deepseek-harness
pnpm dsh --profile web --dump-config
```

输出中应同时出现：

```text
@creative-dswork/dsh-uni-editor
serverName: threejs
forwardWorkspace: true
```

### 4. 配置真实 DeepSeek Key

推荐在启动终端中隐藏输入，不落盘：

```bash
cd /Users/bytedanceo/Workspace/DeepSeekSpace/deepseek-harness
printf "DeepSeek API Key: "
IFS= read -r -s DEEPSEEK_API_KEY
printf '\n'
export DEEPSEEK_API_KEY
pnpm dsh web
unset DEEPSEEK_API_KEY
```

也可以在 DSH Web 左下角打开“设置” -> “模型”，编辑
`DeepSeek (deepseek-official)`。DSH 会将凭据保存到：

```text
~/.dsh/.credentials.yaml
```

文件权限为 `0600`。不要把 Key 写入 `cordis.patch.yml`、测试 fixture 或 Git。

### 5. 打开本地 Three.js 工程

1. 打开 `dsh web` 输出的 URL。
2. 点击“添加工作区”。
3. 选择已有的本地 Three.js 游戏目录。
4. 在该 Workspace 中新建 Session。
5. 输入“用 Three.js Editor 打开当前工程”。
6. `dsh-uni-editor` 启动的 Three.js MCP tools 会在同一 Chat 卡片中打开 Editor。

不需要先进入游戏目录启动 DSH，也不需要把游戏路径写进 MCP 配置。

### 6. 从多项目仓库打开一个演示工程

以 `Threejs-Awesome-Graphics-Agent-Skills` 为例，可以直接把 Gallery 的示例
目录选为 DSH Workspace：

```text
dev/example-gallery/examples
```

Three.js MCP Server 会识别该 Gallery 的固定 corpus 布局，并只读解析同一
仓库中的：

```text
dev/example-gallery/support
skills
```

然后直接发送：

```text
列出当前threejs工程有哪些
打开这个 threejs-procedural-geometry/formula-one-race-car
```

预期工具序列只有：

```text
list_projects({})
open_editor({
  "projectPath":
    "threejs-procedural-geometry/formula-one-race-car"
})
```

`list_projects` 只返回相对 `projectPath`。`open_editor` 会在 Editor 的
`--root/.managed-workspaces` 下创建绑定源文件 revision 的受管投影，并通过 MCP App
打开；它不会修改示例仓库、执行 `npm install`、启动 gallery server 或打开 HTML
页面。

打开完成后会自动构建 exact revision，并直接进入编辑态，不需要点击 Play：

- 画布应显示真实 Formula One Race Car，而不是黑色空 Scene；
- Scene graph 应包含 `VF-26`、`hull` 等真实 Runtime 对象；
- 可以从 Scene graph 或画布选择对象，通过 Properties 或 TransformControls
  修改位置、旋转、缩放、可见性和支持的材质属性；
- Save 将官方 Editor Command 覆盖写入 Managed Workspace 的
  `threejs.editor.json` 并产生新 revision，不修改只读 corpus；
- Play 只负责从当前编辑状态进入运行态；Stop 返回同一编辑场景并保留修改。

该只读父级映射只适用于已识别的 `dev/example-gallery/examples` 固定布局，并且
只允许 `dev/` 和 `skills/`。普通 Workspace 不会自动向父目录扩大范围，也不会
退回外部 dev server。

## 真实 LLM 验收

真实模型运行时不要加载：

```text
tests/fixtures/m6/replay.patch.yml
tests/fixtures/m6/replay/replay.override.json
```

可以发送：

```text
请用 Three.js Editor 打开当前工程，检查 Scene，然后把 Ball 的材质颜色改成
#4CC9F0，并告诉我修改后的 revision。必须自主使用 Three.js Editor MCP tools，
不能使用普通文件工具直接修改。
```

预期模型自主调用：

```text
open_editor
  -> inspect_project
  -> inspect_editor
  -> apply_editor_commands
  -> inspect_project
  -> check_project
```

最终应产生新 revision，`check_project` 返回 `0 errors, 0 warnings`，并且只有预期
Scene 文件发生变化。真实模型验证证据见
[`../reports/M6.1-real-llm-validation.md`](../reports/M6.1-real-llm-validation.md)。

## 当前限制

- 当前开发模式是本地单用户 Harness；动态 Workspace 注册不提供多租户隔离。
- M6.1 可原地打开、编辑和 revision 化本地工程文件。
- 通用 Vite、TypeScript、ESM module graph 和 source map 构建属于 M7。
