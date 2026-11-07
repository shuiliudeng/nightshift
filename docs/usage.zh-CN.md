# Nightshift 使用指南（中文）

Nightshift 是一个常驻的 GitHub 编码代理：你在 issue 里 `@` 它，它会把请求变成
ticket，在独立的 git worktree 里让 OpenCode 干活，然后自动 commit、push、开
PR，并回评论。

这份指南面向“拿到仓库后怎么用”，不重复设计细节。架构和取舍见
[design.md](design.md)，英文总览见 [README](../README.md)。

## 当前完成度

已经验证：

- 本地 ticket 编排：worktree → `opencode run` → commit → 状态落库
- 真实模型执行（沙盒里成功创建/修改文件并自动提交）
- SQLite 持久化、去重、重试、崩溃后 running ticket 回收
- 15 项自动化测试、TypeScript 类型检查
- GitHub 仓库上传（SSH）

还需要你配置后才能验证：

- 真实 GitHub issue 评论轮询 → 建 ticket → push → 开 PR → 回评论
- 原因：`gh` token 当前无效，且需要一个有写权限的 bot 账号

## 1. 前置条件

- Node.js **>= 22.18**（推荐 24.x）
- git
- OpenCode CLI，并且至少配置好一个模型：

  ```powershell
  opencode --version
  opencode models
  ```

- 如果要接真实 GitHub：GitHub CLI `gh`，以及一个有仓库写权限的 bot 账号

## 2. 安装

```powershell
cd D:\Code\nightshift
npm install
npm link
nightshift version
```

不想全局安装也可以直接用：

```powershell
node src\cli.ts version
```

## 3. 先看一个本地 demo（不碰 GitHub）

一条命令，自动建临时仓库、跑真实模型、提交并打印结果：

```powershell
cd D:\Code\nightshift
npm run demo -- --keep
```

指定其他模型：

```powershell
npm run demo -- --model opencode-go/glm-5.3 --keep
```

脚本会：

1. 在系统临时目录创建一个 bare git 仓库和种子提交
2. 写一份 `delivery.mode = "local"` 的配置
3. 运行 `nightshift inject --run`
4. 打印 ticket 状态、`DEMO.md` 内容和 commit
5. `--keep` 保留临时目录，方便你进去看

如果模型不可用，先运行 `opencode models` 找可用模型，再传给 `--model`。

## 4. 接到自己的 GitHub 仓库

### 4.1 准备 bot 账号

Nightshift 默认拒绝“自己触发自己”，所以不要用你的主账号当 `agentLogin`。

1. 注册/准备一个单独的 GitHub 账号，例如 `your-nightshift-bot`
2. 在目标仓库 **Settings → Collaborators** 邀请它，角色选 **Write**
3. 用 bot 账号接受邀请
4. 确认 bot 能 push 分支、开 PR

> 如果仓库属于组织，还需要组织允许 bot 作为 collaborator，或者用 GitHub App /
> machine user 方案。

### 4.2 让 `gh` 以 bot 身份登录

```powershell
gh auth logout -h github.com -u 你的主账号
gh auth login -h github.com
gh auth status
gh api user --jq .login
```

最后一条必须输出 **bot 的登录名**。

也可以不登录，改用环境变量（适合服务/容器）：

```powershell
$env:GH_TOKEN = "bot 的 token"
gh api user --jq .login
```

### 4.3 写配置

在你想让 Nightshift 工作的目录（不一定是 Nightshift 仓库本身）执行：

```powershell
cd D:\path\to\your-project
nightshift init `
  --repo owner/repo `
  --agent your-nightshift-bot `
  --allow 你的主账号 `
  --model opencode-go/glm-5.3
```

会生成 `nightshift.config.json`。关键字段：

```json
{
  "repo": "owner/repo",
  "agentLogin": "your-nightshift-bot",
  "allowedLogins": ["你的主账号"],
  "model": "opencode-go/glm-5.3",
  "pollSeconds": 10,
  "delivery": { "mode": "pr", "comment": true }
}
```

- `agentLogin`：bot 的登录名，评论里必须 `@` 它
- `allowedLogins`：允许下指令的人；不要写 bot 自己
- `pollSeconds`：测试时设 10，正式用 60
- `delivery.mode`：`pr` 会 push + 开 PR；`local` 只提交在 worktree 里

### 4.4 检查环境

```powershell
nightshift doctor
```

期望看到 `node`、`git`、`gh auth`、`config`、`opencode` 都是 `ok`。

### 4.5 先本地试一个请求（可选，但推荐）

```powershell
nightshift inject `
  --text "Add a CONTRIBUTING.md with a short contributor guide" `
  --actor 你的主账号 `
  --run
```

这会真实 clone 仓库、建 worktree、跑模型。`delivery.mode = "pr"` 时会 push 并开
PR；想先只看代码，把它改成 `"local"`。

### 4.6 启动常驻循环

```powershell
nightshift run
```

然后在 GitHub 上：

1. 新建一个 issue（内容随意，比如“Fix the flaky login test”）
2. 用你的主账号评论：

   ```text
   @your-nightshift-bot fix the flaky login test
   ```

3. 等待 `pollSeconds`，预期看到：
   - 一条“On it”确认评论
   - 一个新分支 `nightshift/t_xxxxxxxxxx`
   - 一个 pull request
   - 一条完成评论，带 PR 链接和 agent 报告

停止：`Ctrl+C`。启动时会自动把上次崩溃遗留的 `running` ticket 重新排队。

## 5. 常用命令

| 命令 | 作用 |
| --- | --- |
| `nightshift init` | 生成配置 |
| `nightshift run` | 常驻轮询并执行 |
| `nightshift once` | 只轮询一轮，跑完退出 |
| `nightshift status --all` | 查看所有 ticket |
| `nightshift inject --text "..." --run` | 不经过 GitHub，直接跑一个请求 |
| `nightshift retry <ticketId> --run` | 重试失败/中断的 ticket |
| `nightshift doctor` | 检查 Node、git、gh、配置、OpenCode |
| `nightshift version` | 版本 |

全局选项：`--config <path>`、`--log debug|info|warn|error`。

## 6. 配置速查

完整字段见 [README](../README.md#configuration)。最常用的：

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `repo` | 必填 | `owner/name` |
| `agentLogin` | 必填 | bot 登录名 |
| `allowedLogins` | 必填 | 允许下指令的人；`["*"]` 允许任何人 |
| `model` | 必填 | OpenCode 模型 id |
| `baseBranch` | 自动 | 从哪个分支开 worktree |
| `maxWorkers` | `1` | 并发 ticket 数 |
| `pollSeconds` | `60` | 轮询间隔 |
| `workspaceDir` | `.nightshift/workspaces` | base clone 和 worktree |
| `stateDir` | `.nightshift/state` | SQLite 数据库 |
| `delivery.mode` | `"pr"` | `"pr"` 或 `"local"` |
| `delivery.comment` | `true` | 是否回 issue 评论 |
| `opencode.command` | 自动 | 自定义 OpenCode 路径 |
| `opencode.agent` | 无 | 传给 `--agent` 的 OpenCode agent |
| `opencode.extraArgs` | `[]` | 额外参数，例如 `["--pure"]` |
| `opencode.timeoutMinutes` | `30` | 单 ticket 超时 |
| `prompt.extraInstructions` | `""` | 追加给模型的团队规则 |
| `cloneUrl` | 无 | 用自定义 git URL 代替 `gh repo clone` |

## 7. 常见问题

### `gh auth status` 显示 token 无效

```powershell
gh auth logout -h github.com -u 当前账号
gh auth login -h github.com
```

### 评论被忽略

按顺序检查：

1. 评论里是否真的 `@agentLogin`（大小写不敏感，但不能是 `@bot2`）
2. 评论人是否在 `allowedLogins`
3. 评论人是否就是 bot 自己（会被 `self` 拒绝）
4. 评论人是否是 `[bot]` 账号（会被 `bot` 拒绝）
5. issue 是否是 PR（PR 评论暂不支持）
6. `nightshift status --all` 看是否已经建过 ticket

### Windows 下找不到 opencode

Nightshift 会自动解析 `where opencode` 的 `.cmd` 并找到真实 `.exe`。如果仍失败，
在配置里写死：

```json
{
  "opencode": {
    "command": "C:/Users/你/AppData/Roaming/npm/node_modules/opencode-ai/bin/opencode.exe"
  }
}
```

### `node:sqlite` 的 ExperimentalWarning

正常现象。可以忽略，或：

```powershell
$env:NODE_OPTIONS = "--no-warnings"
```

### 模型不存在 / 认证失败

```powershell
opencode models
opencode auth login
```

把可用的模型 id 填到 `model`。

### ticket 一直是 running

重启 `nightshift run` 会自动回收；也可以：

```powershell
nightshift retry t_xxxxxxxxxx --run
```

### 没有生成 PR

- 检查 `delivery.mode` 是否为 `"pr"`
- 检查 `gh auth` 是否是 bot 账号
- 检查 bot 是否有写权限
- 检查分支保护是否阻止 push
- 如果 agent 没有改任何文件，ticket 会 `done`，但不会 commit/PR

### 超时

调大：

```json
{ "opencode": { "timeoutMinutes": 60 } }
```

## 8. 安全

- `gh` token 能 push 和开 PR，使用专用 bot 账号，尽量只授权一个仓库
- issue 内容是**不可信输入**，存在 prompt injection 风险
- `opencode run --auto` 会以你的用户权限执行命令，不要用管理员权限运行
- 不要把 Nightshift 跑在存有无关密钥的机器上；建议容器或专用 VM
- 每个 PR 都要人工 review 后再合并

## 9. 清理

```powershell
npm unlink -g nightshift
```

项目里的运行产物默认在 `.nightshift/`，可以直接删除。worktree 会保留在
`workspaceDir` 下，方便检查；不需要时删掉即可。

## 10. 下一步

- 想改行为：看 [design.md](design.md) 的 prompt、policy、delivery 部分
- 想加 source：目前只有 GitHub issue 评论和本地 `inject`
- 想接 CI：用 `nightshift once` 或 `nightshift run` 作为 job step
