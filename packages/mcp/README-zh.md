# jevcore-mcp

经 Model Context Protocol 提供的 TypeSafe [Jev](https://typesafe.ai)。

Jev 不是聊天模型。它回答带类型的问题 —— `noul`（是/否）、`choice`、
`score` —— 并返回校准过的概率。它不写散文，要求它写散文是一种范畴错误。
本服务器暴露的恰好是这一层接口。

**默认离线。外发行为被披露。没有任何东西默认开启。**

## 安装

```sh
npx -y jevcore-mcp
```

把它作为一个 stdio MCP 服务器注册到你的宿主。对 DeepSeek Harness 而言，那就是一个
只含配置的 bundle，它的 patch 会插入 harness 的 MCP 客户端：

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

## 配置

| 变量 | 作用 |
|---|---|
| `TYPESAFE_API_KEY` | 存在时选择 TypeSafe 路由 |
| `OPENROUTER_API_KEY` | 存在且没有 TypeSafe key 时选择 OpenRouter 路由 |
| `JEV_PROVIDER` | `mock`、`live` 或 `openrouter` —— 覆盖上面的启发式规则 |
| `TYPESAFE_MODEL` / `OPENROUTER_MODEL` | 所选路由的模型 id |
| `TYPESAFE_BASE_URL` / `OPENROUTER_BASE_URL` | 所选路由的 API 根地址 |

两条路由到达同样的模型。TypeSafe 直接提供它们；OpenRouter 在与 TypeSafe 相同的
`POST /v1/systemone` 路径上提供 System One 模型，就在它自己的 API 根地址下一层；
当 TypeSafe key 不现实时，这就是进入的方式。
它们的不同在于谁的服务器会看到你的状态，因此启动报告点名
endpoint，而不是让它由 provider 的名字来暗示。在 OpenRouter 路由上，
模型 id 必须是 System One 的 id：裸的 `jev-latest` 不需要前缀，
`typesafe/` 可用于带版本号的 id，例如 `typesafe/jev-1.13`，而
`typesafe/jev-latest` 不被接受。任何其他 id 都会用散文作答，
而本服务器无法把它解读为决策。

与一个每次调用都解析的适配器不同，本服务器 **在启动时一次性** 解析它的凭据
—— 它是一个长期存活的进程，其凭据不会在会话中途改变。因此，没有 key 却设置了
`JEV_PROVIDER=live` 是一个带可读消息的启动错误，而不是第一次工具调用时的
失败。

## 工具

| 工具 | 用途 |
|---|---|
| `jev_ask` | 针对一个状态的一个或多个带类型问题；把它们批量放进一次调用 |
| `jev_rank` | 依据一个判据对候选打分并排序，每个候选一个问题 |
| `jev_check` | 这些证据支持这个断言吗？`supported`、`contradicted`、`conflicted`、`insufficient`、`undecided` 或 `unknown` |

三个工具，刻意少而正交。已经有两个现存的 Jev MCP 服务器各自发布十个工具；
这一个存在的意义，是应对某个宿主只想要这三个原语、别的什么都不要的情况，
它构建在与 DeepSeek Harness 插件相同的 core 之上，
因此两者无法偏离。

每个结果携带的是概率，不是决策。在行动之前应用你自己的置信度阈值，
并把低置信度的答案当作未知，
而不是替它做选择。

## 外发报告

服务器在启动时把它的契约打印到 **stderr**：

```
[jevcore] provider=mock  endpoint=none  egress=OFF  (no network calls will be made; every answer is synthetic)
[jevcore]   armed  tool:jev_ask  (runs against the offline mock; would transmit if the provider became "live" or "openrouter")
```

是 stderr，而不是 stdout：在 stdio 传输上 stdout 是协议通道，
那里多出一行会破坏数据流。

脱敏在任何内容被发送之前运行。它是一种缓解措施，不是一个保证 ——
自由文本中一个未被识别的密钥会通过。如果这种可能性不可接受，
就不要设置 key。

## 现状

工具、provider 选择以及外发的强制执行都由测试覆盖，并且
传输已被一个真实的 MCP 客户端通过 stdio 端到端驱动过：

```sh
pnpm --filter jevcore-mcp run smoke        # offline, mock provider, no credential
pnpm --filter jevcore-mcp run smoke:live   # real answers, needs OPENROUTER_API_KEY
```

离线的那次运行演练了握手、工具发现、三次成功的调用，
以及无效批次的错误路径。

live 的那次运行通过 OpenRouter 针对真实的 System One 模型驱动了同一层
表面：三个工具都作了答，一批三个原语在带完整图例的三级评分标准上返回了
`score`，值为 `1.08`，`jev_rank` 把一份凭据 runbook 排在计费指南之上，
`jev_check` 返回 `contradicted`，
并且启动时的外发报告在 stderr 上点名了 OpenRouter endpoint，
同时没有扰乱协议通道。

**TypeSafe 路由已经实跑过，但只是轻量地跑。** `packages/core/scripts/probe-live.mjs`
（`pnpm --filter jevcore run probe:typesafe`）向真实 API 问了三件事：十组
判定结果事先已知的 claim/evidence 配对、同一个问题重复六次，以及一个
带有 `criteria: {true, false}` 边界的 noul。两次独立的运行结果一致 —— 支持性证据得 0.95，
反驳性证据得 0.10，对断言保持沉默的证据得 0.03，重复提问的波动不超过 0.01。
该边界被接受。仍未测试的是请求之外的周边事项：
真实账号上的配额、限流和权限行为。

## 许可证

[Apache License 2.0](LICENSE) © 2026 jevcore contributors. TypeSafe、Jev 以及
System One 是 TypeSafe AI 的商标；这是一个独立集成，
与 TypeSafe AI 无隶属关系，也未获其背书。
