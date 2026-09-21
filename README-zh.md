# jevcore

[![DSH Market](https://raw.githubusercontent.com/2BingLing/dsh-market/master/assets/readme/badge-listed-zh.svg)](https://dsh.market/)

为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
以及任何其他 MCP 宿主打造的 TypeSafe [Jev](https://typesafe.ai)。

Jev 不是聊天模型。它回答带类型的问题 —— `noul`（是/否）、`choice`、`score` —— 并返回
校准过的概率。它不写散文，要求它写散文是一种范畴错误。本项目
给一个 agent 的恰好是这一层接口，不多一分。

**默认离线。外发行为被披露。没有任何东西默认开启。**

---

## 三个包，一个决策层

| 包 | 它是什么 | 何时使用它 |
|---|---|---|
| [`jevcore`](packages/core) | 决策本身。不从 DeepSeek Harness 或 Cordis 导入任何东西。 | 你想在普通脚本、服务或你自己的 harness 里使用 Jev |
| [`jevcore-dsh`](packages/dsh) | DSH 插件：一个服务、三个工具、两道需显式启用的闸门 | 你正在运行 DeepSeek Harness |
| [`jevcore-mcp`](packages/mcp) | 同样这三个工具，经由 MCP 提供，带一个 stdio 二进制 | 你的宿主能说 MCP，但不是 DSH |

适配器刻意做得很薄。`packages/dsh` 只有四个文件：它声明工具 schema，并
转换 hook 载荷。所有与决策有关的形状 —— 原语、provider、外发
契约、策略、闸门 —— 都住在 core 里，因此一个新的适配器无法偏离
其他适配器所给出的保证。
三者的运行时要求并不相同：`jevcore-dsh` 跟随 harness，需要
Node `^22.19.0 || >=24.0.0`，而 `jevcore` 与 `jevcore-mcp` 需要 `>=20`。

---

## 为什么会有这个项目

2026-09-17 到 09-20 之间，出现了十九个把 Jev 接入 DSH 的插件。审计它们的源码
发现了一个一致的模式：被标记为 *guard*、*gate* 或 *warden* 的那个模块，也是那个
把 prompt、工具参数和文件内容发送给第三方的模块，而 README 通常并不
说明这一点。其中好几个默认启用。有一道闸门可以被它正在守护的模型重新配置。

本项目是同一个想法，但把这些失效模式在设计上排除掉了：

| 属性 | 这里如何保证 |
|---|---|
| 除非你主动要求，否则不发起网络调用 | 默认 provider 是离线 mock；走 live 路径同时需要 `provider: live` 和一个已解析出的凭据 |
| 每一次外发都在发生之前被点名 | 每个特性一行启动日志：`off` 或 `SENDS <feature> { fields }` |
| 闸门被禁用时不注册任何东西 | 由测试保证，而不是由策略保证 —— 被禁用的闸门完全不添加事件监听器 |
| 模型无法放宽自己的约束 | 没有任何工具暴露闸门配置 |
| 无法作答的裁判绝不意味着 "allow" | 未决结果通过显式配置解析，默认为 `ask` |

---

## 外发契约

这是安装之前值得一读的部分。

是否外发按特性逐个决定，而每个特性都默认关闭。插件在加载时打印它自己的
契约：

```
[jevcore] provider=mock  endpoint=none  egress=OFF  (no network calls will be made; every answer is synthetic)
[jevcore] ready - provider=mock - gates: safety=off context=off
```

当 `provider: live` 且每个特性都启用时，同一份报告会明确说明什么会离开：

```
[jevcore] provider=live  endpoint=https://api.typesafe.ai  egress=ON
[jevcore]   SENDS  tool:jev_ask  { state<=16000c questions<=4000c }
[jevcore]   SENDS  tool:jev_rank  { state<=16000c questions<=4000c }
[jevcore]   SENDS  tool:jev_check  { state<=16000c questions<=4000c }
[jevcore]   SENDS  gate:safety  { state<=8000c questions<=2000c }
[jevcore]   SENDS  gate:context  { state<=6000c questions<=2000c }
[jevcore]   redaction is best-effort; it removes named fields and known secret shapes, and cannot
             recognise an unrecognised secret in free text
```

| 特性 | 默认关闭？ | 它发送什么 |
|---|---|---|
| `tool:jev_ask` | 模型调用它时运行 | 模型传入的参数，在脱敏之后 |
| `tool:jev_rank` | 模型调用它时运行 | 查询加上每一个候选 |
| `tool:jev_check` | 模型调用它时运行 | 断言及其证据 |
| `gate:safety` | **是 —— 需显式选择启用** | 工具名、它的参数、工作区根目录 |
| `gate:context` | **是 —— 需显式选择启用** | agent 刚刚收到的一个大型工具结果 |

这些工具只在模型选择调用它们时才外发，而这在对话记录中是可见的。闸门
会在每一次匹配的工具调用上运行，这一点不可见，所以它们需要显式启用。

### 脱敏，以及它诚实的界限

在任何内容被发送之前，`src/redact.ts` 会跑两轮处理：敏感字段名（
`password`、`token`、`apiKey`、`authorization`、……）下的值被整体替换，而幸存到
自由文本中的密钥形状字符串会被模式匹配（`Bearer …`、`sk-…`、`ts_live_…`、AWS/GitHub/Google
的 key 形状、JWT、私钥头、连接字符串中的凭据）。

这是一种缓解措施，不是一种许可。一个既处于未被识别的字段名之下、*又*
不匹配任何已知形状的密钥会通过。如果这种可能性对你的工作负载不可接受，
就不要启用 live provider。

---

## 安装

### 作为 DeepSeek Harness 插件

```sh
dsh plugin --profile <profile> add jevcore-dsh
```

或者从一份 checkout 安装：

```sh
dsh plugin --profile <profile> add /absolute/path/to/jevcore/packages/dsh
```

`packages/dsh` 按名字导入 `jevcore`，所以用 checkout 安装时还需要让 core
能从该 profile 解析到（`add /absolute/path/to/jevcore/packages/core`）。

然后确认该行已激活 —— 插件列表应显示 `jev` 为 `active`，
而不是 `failed` —— 并检查日志中的启动报告。

### 作为 MCP 服务器

对于能说 MCP 的宿主，同样这三个工具可通过 stdio 使用：

```sh
npx -y jevcore-mcp
```

要专门把它接入 DeepSeek Harness，请安装一个只含配置的 bundle，
它的 patch 会插入 harness 自带的 MCP 客户端：

```yml
- insert:
    - id: jev-mcp
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: jev
        transport: stdio
        command: npx
        args: ['-y', 'jevcore-mcp']
        env:
          TYPESAFE_API_KEY: '<the key>'
        failOnStartupError: true
```

env 映射不是可选项：DSH 交给被启动子进程的环境里，任何形如凭据的变量名都会被剥掉
（名字中含 KEY、PASSWORD、SECRET 或 TOKEN，且不区分大小写），之后才把这份映射合并回去。
你在 shell 中导出的 key 不会到达服务器，服务器会停留在离线 mock 上，并且不报告任何错误。

provider 从环境中选出：

| 变量 | 作用 |
|---|---|
| `TYPESAFE_API_KEY` | 存在时选择 TypeSafe 路由 |
| `OPENROUTER_API_KEY` | 存在且没有 TypeSafe key 时选择 OpenRouter 路由 |
| `JEV_PROVIDER` | `mock`、`live` 或 `openrouter` —— 覆盖上面的启发式规则 |
| `TYPESAFE_MODEL` / `OPENROUTER_MODEL` | 所选路由的模型 id |
| `TYPESAFE_BASE_URL` / `OPENROUTER_BASE_URL` | 所选路由的 API 根地址 |

两个 key 都没有时，它留在离线 mock 上。与插件不同，MCP 服务器
在启动时一次性解析它的凭据，因此缺少 key 却设置了
`JEV_PROVIDER=live` 是启动错误，而不是每次调用时的意外。

它的外发报告写到 **stderr**，从不写 stdout —— 在 stdio 传输上 stdout
是协议通道，那里多出一行会破坏数据流。

### 走 live 路线

通往 Jev 有两条路由。两者调用同样的模型，也都返回同样的
带类型答案；它们的不同在于谁持有你的凭据，以及谁的服务器会看到
你的状态。

**直接使用 TypeSafe** —— 如果你有来自
[console.typesafe.ai](https://console.typesafe.ai/settings/keys) 的 key，就用这条：

```yml
- insert:
    - id: jev
      name: 'jevcore-dsh'
      config:
        provider: live
        apiKeyRef: TYPESAFE_API_KEY   # a reference, never the key
        model: jev-latest
```

**通过 OpenRouter** —— 如果 TypeSafe key 不现实，而你
已经有一个 [OpenRouter](https://openrouter.ai) key，就用这条。OpenRouter 在与
TypeSafe 相同的 `POST /v1/systemone` 路径上提供 System One 模型，就在它自己
API 根的下一层，因此这是通往 Jev 的有文档记载的路由，而不是对它的
一种近似：

```yml
- insert:
    - id: jev
      name: 'jevcore-dsh'
      config:
        provider: openrouter
        openRouterApiKeyRef: OPENROUTER_API_KEY
        model: jev-latest              # a bare `jev-*` id, or `typesafe/jev-1.13`
```

这条路由的走法，是把官方的 `@typesafe-ai/sdk` 指向
`https://openrouter.ai/api` 并带上你的 OpenRouter key —— 这是 OpenRouter 自己
有文档记载的集成，因此不存在需要保持同步的第二个客户端。

关于 OpenRouter 路由，有两点需要知道：

- **你的状态会发往 OpenRouter，而不是 TypeSafe。** 那是另一个第三方，
  有不同的留存与日志策略。启动报告点名 endpoint 正是
  出于这个原因 —— 去读它，而不要从 provider 的名字推断
  目的地。
- **它会返回成本**，而 TypeSafe 自己的路由不会，所以 `usage.costUsd`
  在这条路由上有值，在那条上没有。

模型 id 必须是 System One 的 id。裸的 `jev-latest` 就是默认值，不需要任何
前缀；`typesafe/` 可用于带版本号的 id，例如 `typesafe/jev-1.13`，但不能用于
移动标签 —— `typesafe/jev-latest` 不被路由接受。任何其他 id 都会被路由到聊天
模型，它给出的散文式回答这个插件无法解读为决策，因此它会在调用之前被
拒绝，而不是在调用之后被误读。

无论哪条路由，凭据都会先通过 DSH 的凭据服务解析，
然后才是该名字的环境变量。它按调用读取，所以进程运行期间新增的
key 会被取到。它从不被写入日志，从不从工具返回，
也从不写入配置。每条路由都有自己的引用
（`apiKeyRef` 和 `openRouterApiKeyRef`），因此两者不会意外共用同一个 key。

`@typesafe-ai/sdk` 是唯一的可选依赖；插件在没有
其中任何一个的情况下也能离线加载和运行，并且只为你所
选择的那条路由需要对应的那一个。

---

## 配置

| 键 | 默认值 | 含义 |
|---|---|---|
| `provider` | `mock` | `mock`（离线、确定性、合成）、`live`（TypeSafe）或 `openrouter` |
| `apiKeyRef` | `TYPESAFE_API_KEY` | `live` 路由的凭据引用 |
| `openRouterApiKeyRef` | `OPENROUTER_API_KEY` | `openrouter` 路由的凭据引用 |
| `baseURL` | `https://api.typesafe.ai` | `live` 路由的 API 根地址。除 loopback 外，非 HTTPS 会被拒绝 |
| `openRouterBaseURL` | `https://openrouter.ai/api` | `openrouter` 路由的 API 根地址。同样的规则 |
| `model` | `jev-latest` | 随每个请求发送。在 OpenRouter 路由上使用裸的默认值即可；`typesafe/` 需要带版本号的 id，例如 `typesafe/jev-1.13`，而 `typesafe/jev-latest` 不被接受 |
| `logLevel` | `warn` | `silent` \| `warn` \| `info` \| `debug` |
| `minConfidence` | `0.7` | 低于此值，答案不会被采纳 |
| `minProbability` | `0.6` | 低于此值，决策不会被采纳 |
| `maxStateChars` | 按特性而定 | 替换每个特性的 `state` 上限。`0` 表示 "保留声明的上限" |
| `gates.safety` | `false` | 在派发之前裁判工具调用 |
| `gates.context` | `false` | 扣留大型、无信息量的工具结果 |

声明的 `state` 上限是：三个工具各 16,000 字符，safety 与 context 闸门
分别为 8,000 / 6,000。`maxStateChars` 会替换全部这些上限，而启动报告显示的是
实际生效的值而不是声明的值，因此它打印什么，就强制什么。

闸门接受一个裸布尔值（`safety: false`），或一个带 `onUndecided` 的对象：`ask`（默认）、
`allow` 或 `deny`。

`ask` 是一个提问，因此它需要有对象可问。一个没有组合任何审批服务的部署无法把问题
升级给人类，DeepSeek Harness 随后会拒绝这次调用而不是执行它：safety 闸门匹配到的
每一个工具都会被拒绝，运维者感受到的就是插件把所有 shell 命令都弄坏了。
[docs/approval.md](docs/approval.md) 记录了这套机制，插件 README 则讲了部署层面的
看法。

未知的值会在加载时被拒绝，并给出一条点名该键的消息，而不是被静默
忽略 —— 配置里的一个拼写错误不应该悄悄改变隐私姿态。

---

## 使用方式

### 从另一个插件调用，回路中没有模型

服务是主要的接口。这正是决策模型的要点所在：一次路由或闸门
决策不应该耗费一次模型往返。

```ts
const jev = ctx.get('jev')
const result = await jev.ask({
  feature: 'tool:jev_ask',
  state: { ticket: 'I was charged twice.' },
  questions: {
    urgent: { type: 'noul', instructions: 'Does this convey urgency?' },
    team: {
      type: 'choice',
      instructions: 'Which team should handle this?',
      criteria: { billing: 'Payments, invoices, refunds', technical: 'Bugs, outages' },
    },
  },
})
```

`result.answers` 携带概率和置信度。决定拿它们做什么，是你代码的
职责 —— 参见 `src/policy.ts` 中一个带显式置信度下限的完整示例，其中不确定的
答案会产生 `ask` 而不是 `allow`。

### 由模型调用

三个工具，刻意少而正交：

- **`jev_ask`** —— 针对一个状态的一批带类型问题。
- **`jev_rank`** —— 依据一个判据对候选打分并排序，每个候选一个问题，
  在一次往返中完成。这些概率是对每个候选的独立判断，不是一个分布。
- **`jev_check`** —— 这些证据支持这个断言吗？返回 `supported`、`contradicted`、
  `conflicted`、`insufficient`、`undecided` 或 `unknown`。矛盾优先于支持，因为既支持
  又反驳的证据是冲突，而不是一个弱弱的 "是"。

### 内置的 skill

插件注册了一个 skill，即 `typesafe-ai-dsh`，它教一个 agent 何时 Jev
判断是合适的工具、何时它是范畴错误。它是通过 skill 注册表注册的，
而不是作为一个供 provider 扫描的目录随包发布，因此它不依赖
profile 把 skill 放在哪里，并且在插件被移除时它会
干净地消失。

它的正文位于 `skills/typesafe-ai-dsh/SKILL.md`，是在加载时读取的，
而不是内嵌，因此人类编辑的那个文件就是随包发布的文件。有一个测试断言
两者不会偏离。

该注册表被声明为一个 **可选** 依赖：一个没有组合 skill
子系统的 profile 仍然能得到服务和三个工具，另外附带一条
skill 被跳过的警告。

### mock provider

使用 `provider: mock` 时，每个答案都从问题与状态的哈希推导而来，因此测试可以
断言精确的值，也不会打开任何 socket。合成结果在三处被如此标注：
`provider: "mock"`、一个 `mock/jev-synthetic` 模型名，以及结果上的一个 `warning` 字段。一个
可能被误认为真实判断的 mock，会比完全没有 mock 更糟。

---

## 现状

对已核实与未核实内容的诚实交代。

**已核实**
- 三个包共 410 个测试通过（core 314、DSH 66、MCP 30），没有网络访问，也没有
  `TYPESAFE_API_KEY`。CI 会清除该变量，并期望测试套件照样通过。
- **OpenRouter 路由已针对真实 API 核实。** `pnpm --filter jevcore run
  probe:live` 驱动 provider，`pnpm --filter jevcore-mcp run smoke:live` 驱动整个 MCP
  表面 —— 传输、工具 schema、服务和 provider —— 针对真实的 System One 模型
  （`typesafe/jev-1.13-20260917`）。一批三个原语返回了一个 0.91 的 `noul`、一个 0.97 的
  `choice`，以及在一个四级评分标准上 `1.05` 的 `score`，用量报告为
  `{ inputTokens: 469, outputTokens: 68, costUsd: 0.000019698 }`。`jev_rank` 把一份凭据
  runbook 排在计费指南之上；`jev_check` 返回 `contradicted`。两个脚本都需要
  `OPENROUTER_API_KEY`，且都被排除在 CI 之外。
- **载荷形状已对照厂商自己的类型定义检查。**
  `test/vendor-conformance.test.ts` 把本项目的问题和答案类型钉在两个 SDK 上，因此任一方向
  的漂移都会是编译错误，而不是在唯一一条既花钱又传输数据的路由上发出的一个
  畸形请求。正是这项检查发现了 `score.criteria` 在被作为键值映射发送，而 API
  要求的是有序数组 —— 这是一个桩化的单元测试自始至终都放过的缺陷。
  还有一个脚本曾把我们的载荷对照 OpenRouter 为 `alpha/decisions` 路由发布的 zod
  schema 进行解析；那个脚本和那条路由都已不存在，因为 OpenRouter provider 现在
  通过与 TypeSafe 相同的客户端走有文档的 `/v1/systemone` 路径，而一致性测试
  已经覆盖了它。
- **该插件能在运行中的 harness 里激活，其工具可用。** 插件行报告 `active`；
  `jev_ask` 针对 mock 在 1 ms 内返回 `urgent=true (0.8307)` 和 `team=billing (0.5027)`，而
  `jev_check` 返回 `verdict="insufficient"` 及其三个概率。每个结果都带有
  `provider: "mock"` 和零 token 用量，因此默认路径没有发起网络调用。
- **内置的 skill 会注册。** `typesafe-ai-dsh` 出现在会话的 skill 目录中。
- 默认路径不发起网络调用：通过在挂载插件并通过服务作答时监视 `globalThis.fetch` 来断言，
  在装配 MCP 运行时也再次断言。
- 被禁用的闸门不注册 **任何** 事件监听器，被拒绝的外发永远不会到达 provider。
- `Config` 满足 Cordis 在插件启动之前所要求的 Standard Schema 协议。
- 这里用到的每一个 DSH API（`ctx.provide`、`ctx.effect`、`tools.register`、`defineTool`、
  `tools/pre-execute`、`tools/post-execute`、`credentials.resolve`）在使用之前都对照已安装的
  运行时检查过，载荷类型来自已安装的声明文件。

**未核实，或已知损坏**
- **TypeSafe 路由已经实跑过，但只是轻量地跑。** `packages/core/scripts/probe-live.mjs`
  （`pnpm --filter jevcore run probe:typesafe`）向真实 API 问了三件事：十组
  判定结果事先已知的 claim/evidence 配对、同一个问题重复六次，以及一个
  带有 `criteria: {true, false}` 边界的 noul。两次独立的运行结果一致 —— 支持性证据得 0.95，
  反驳性证据得 0.10，对断言保持沉默的证据得 0.03，重复提问的波动不超过 0.01。
  该边界被接受。仍未测试的是请求之外的周边事项：
  真实账号上的配额、限流和权限行为。
- **在当前正在运行的那个构建上，`jev_ask` 的描述里有一个损坏的破折号。** 它
  读作 `branches on —?routing`，而那里本应是一个 em dash 加一个空格。原因：开发早期的一次
  UTF-8 往返把 em dash 的第三个字节替换成了 `?`。它在磁盘上已修复 —— 四处
  出现、零处残留，源码和构建产物中都已确认 —— 但正在运行的进程
  在修复之前就加载了它的模块，不重启就无法重新读取。破折号本身只是外观问题，
  但这种陈旧状态不是：同一个进程还缺少它启动之后的所有修复，
  包括让 0.51 不被读作已定论的 `band` 字段。
- MCP 服务器已被一个真实的 MCP 客户端通过 stdio 端到端驱动过
  （`pnpm --filter jevcore-mcp run smoke`）：握手、工具发现、三次成功的调用，以及
  一个针对无效批次的错误结果。它尚未被任何其他第三方宿主驱动过。
- 闸门在 live 流量下的行为。闸门是针对合成答案和真实 hook
  载荷形状测试的，但还没有任何真实的工具调用被端到端地闸门处理过。
- context 闸门无法追回已经花掉的上下文。它扣留一个结果，不让它到达
  agent；它不会追溯性地裁剪任何东西，任何声称不然的插件的 README
  都应该带着怀疑去读。
- 没有长时间运行或对抗性的测试。脱敏是基于模式的，会漏掉一个未被识别的
  密钥形状。

---

## 设计说明

三个容易做错、且做错代价高昂的决定：

**无法作答的裁判绝不能意味着 "allow"。** 如果 Jev 不可达，或回答低于
置信度下限，闸门会通过 `onUndecided` 解析，其默认为 `ask`。要得到
fail-open 行为的唯一办法是显式配置它。context 闸门是刻意的例外：它无条件
fail open，因为把一个真实的工具结果输给一个幽灵般的 "irrelevant" 判定，比
保留一个没有信息量的结果更糟。

**模型说的任何话都不能改变闸门。** 没有任何工具暴露闸门配置、阈值或
范围。一个被它守护的进程可以重新配置的守卫不是守卫。

**概率不是许可证。** Jev 返回数字；`src/policy.ts` 依据本地配置的阈值把它们
变成 `allow`/`ask`/`deny`。一个给出的值在所声明判据之外的答案
是 `invalid` 并拒绝 —— 带类型的决策模型给出的保证是它不能
返回未声明的值，因此一次违反意味着上游有什么东西不对。

## 开发

```sh
pnpm install
pnpm run check      # typecheck + tests + build
pnpm test           # tests only
```

没有任何测试需要凭据或网络连接，CI 通过在被清除了
`TYPESAFE_API_KEY` 的情况下运行来强制这一点。

## 许可证

[Apache License 2.0](LICENSE) © 2026 jevcore contributors

TypeSafe、Jev 和 System One 是 TypeSafe AI 的商标。本项目是一个独立的
集成，与 TypeSafe AI 无隶属关系，也未获其背书。
