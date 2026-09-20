# jevcore-cli

`jev` 命令行工具：在 shell、脚本或 CI 任务中使用 TypeSafe
[Jev](https://typesafe.ai) 做判断。

本包是同一个决策核心的第四个入口，与库、MCP 服务器和 DeepSeek Harness 插件
并列。这里不重新实现任何判断：

- `jev ask` 调用 `JevService.ask`，因此出口契约与脱敏路径与在会话中完全一致；
- `jev check` 调用 `resolveCheck`，与 MCP 工具使用同一个解析器；
- `jev gate` 调用 `createSafetyGate`，与 harness 注册的是同一个函数；
- `jev egress` 调用 `EgressContract.reportLines`，即契约自身的自述。

因此，在提示符下做出的判断与在智能体内做出的判断含义相同。

## 安装

```sh
npm install -g jevcore-cli
```

离线 mock provider 是默认值，不需要任何其他东西。实时通道需要
`@typesafe-ai/sdk`，它是核心包的可选依赖。

## 命令一览

| 命令 | 回答什么 |
|---|---|
| `jev ask` | 针对一个 state 的一批类型化问题——noul、choice、score |
| `jev check` | 针对证据对某个 claim 给出六种裁决之一，并附上概率 |
| `jev rank` | 按相关性排序的候选项，每项一个概率 |
| `jev gate` | 安全闸门会如何裁决一次工具调用，而不实际运行它 |
| `jev egress` | 本工具可以发送什么，以及每个字段的上限 |
| `jev models` | 每条通道会使用哪个模型和端点 |

每个命令都支持 `--json` 输出机器可读结果，默认输出人类可读结果。`data` 下的
字段名是稳定的，与退出码一样。

## 提一个问题

```sh
jev ask --state record.json --questions questions.json --feature tool:jev_ask
```

```json
{
  "usable": {
    "type": "noul",
    "instructions": "Is this record usable?",
    "boundary": { "true": "it can be used as it stands", "false": "it cannot" }
  }
}
```

`--feature` 选择这次调用所属的出口特性。它必须是已声明的特性之一，未声明的名字
会导致硬错误并列出全部可选值——因为决定什么可以离开本机的是契约，而不是命令行。

## 校验一个 claim

```sh
jev check --claim "the build is reproducible" --evidence build.log
```

```
claim: the build is reproducible
evidence: 4821 chars — "commit 3f9a1c2 ..."
verdict: supported  (supports=0.95 contradicts=0.05 sufficient=0.90)
```

裁决是六个词之一，而不是两个词加四个同义词：

| 裁决 | 含义 |
|---|---|
| `supported` | 证据支持该 claim，且被判定为充分 |
| `contradicted` | 证据与该 claim 相矛盾 |
| `conflicted` | 证据既支持又矛盾 |
| `insufficient` | 证据无法确立该 claim |
| `undecided` | 证据足以定论，但没有指向任何一方 |
| `unknown` | 完全没有返回任何测量结果 |

## 退出码

| 退出码 | 含义 |
|---|---|
| `0` | `check` 支持该 claim；`gate` 允许该调用；命令已输出 |
| `1` | `check` 与该 claim 相矛盾；`gate` 拒绝该调用；输入错误 |
| `2` | `gate` 会先询问人类再继续 |
| `3` | `check` 返回 `conflicted`、`insufficient`、`undecided` 或 `unknown` |
| `64` | 命令行本身写错了 |

退出码 `3` 之所以存在，是因为后四种裁决是关于*证据*的结论，而不是关于 claim 的
结论。把它们读作“不支持”的脚本，等于报告了一个没有人测量过的反驳；在 CI 中，
这正是“该 claim 是错的”与“本仓库无法判断”之间的区别。

## 闸门：空跑

```sh
jev gate --tool git --args-json '{"command":"push --force"}' --severity-block high
```

```
jev gate git
decision: ask  severity: high  (blocks at high)  exit: 1
  RAISED  external_side_effect
reason: jevcore safety gate: Jev flagged external_side_effect; the severity "high" is at or above the "high" block level.
nothing was executed: this is a dry run, and the arguments above are data.
```

这是最值得了解的命令。在会话中闸门默认关闭，而且它的职责是在出现危险之前保持
不可见，所以过去无法在不安排一次危险工具调用的情况下询问它会怎么做。这里工具名
和它的参数只是**数据**：不调用任何工具，不触碰任何文件，不启动任何进程。

裁决来自 `createSafetyGate`，因此与真实会话得到的裁决相同。它判断的风险在核心包
中声明，并由 `jev egress --feature gate:safety` 打印出来：不可逆破坏、权限提升、
凭据泄露、外部副作用、历史重写，外加一个严重程度评分。

## 什么可以离开本机

```sh
jev egress
```

```
provider: mock  endpoint: none  transmitting: no
[jevcore] provider=mock  endpoint=none  egress=OFF  (no network calls will be made; every answer is synthetic)
ARMED  gate:safety
         state <= 8000 chars - the tool name, its arguments, and the session working directory
         questions <= 2000 chars - the fixed hazard questions
```

`EgressContract` 是决定什么可以离开本机的唯一地方。每个特性都声明它会发送的字段
以及每个字段的上限，契约可以自述，而本命令会按你即将运行的那次调用打印这份自述。

两条通道都**默认关闭**。`--provider live` 和 `--provider openrouter` 会传输；其他
情况都走离线 mock，它用输入的哈希作答，不打开任何套接字，并在 stderr 与载荷中同
时把每个结果标记为合成数据。

脱敏会覆盖所有外发内容，而它的局限是写明的而非隐藏的：它会移除可识别字段名下的
值以及匹配已知密钥形态的字符串，但无法识别写在自由文本中的、形态未知的密钥。

## 配置

| 变量 | 作用 |
|---|---|
| `TYPESAFE_API_KEY` | `live` 通道的凭据 |
| `OPENROUTER_API_KEY` | `openrouter` 通道的凭据 |
| `JEV_PROVIDER` | `--provider` 的默认值 |
| `TYPESAFE_BASE_URL` | `live` 通道 `--endpoint` 的默认值 |
| `OPENROUTER_BASE_URL` | `openrouter` 通道 `--endpoint` 的默认值 |

凭据永远不会被打印、记录或回显。本工具只报告密钥来自哪个来源——环境变量，还是凭据
服务——仅此而已。

## 避免意外

| 标志 | 作用 |
|---|---|
| `--mock` | 强制使用离线 mock provider |
| `--json` | 在 stdout 输出机器可读结果；所有提示写到 stderr |
| `--model` | 要调用的模型 |
| `--endpoint` | 会传输的 provider 的 API 根地址 |

## 开发

```sh
pnpm install
pnpm --filter jevcore-cli run test
pnpm --filter jevcore-cli run typecheck
```

本包中没有任何测试需要凭据或套接字。实时通道通过一个由环境变量指定的桩 SDK 模块
来演练，因此开发者自己的真实密钥不会把测试变成网络调用。

## 许可证

[Apache License 2.0](LICENSE) © 2026 jevcore contributors。TypeSafe、Jev 和
System One 是 TypeSafe AI 的商标；本项目是独立集成，与其无隶属关系，也未获其认可。
