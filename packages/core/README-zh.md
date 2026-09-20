# jevcore

TypeSafe [Jev](https://typesafe.ai) 决策，不附带任何框架。

本包不从 DeepSeek Harness、Cordis 或任何插件运行时导入任何东西。
它可以在普通 Node 脚本、MCP 服务器、CLI 或 agent-harness
适配器里使用 —— 这正是本仓库中的适配器是它之上的薄层，
而不是相反的原因。

Jev 不是聊天模型。它回答带类型的问题 —— `noul`（是/否）、`choice`、
`score` —— 并返回校准过的概率。它不写散文。

**默认离线。外发行为被披露。没有任何东西默认开启。**

## 安装

```sh
npm install jevcore
```

`@typesafe-ai/sdk` 是一个可选依赖。没有它，本包仍然完整可用，
只是针对离线 mock；只有 `provider: live` 需要它，
而且它是惰性导入的。

## 两个值得了解的想法

### 外发契约

`EgressContract` 是决定什么可以离开本机的唯一地方。

每一个能够外发的特性都声明它发送的字段以及每个字段的上限。
除非某个特性被打开，否则它不外发。没有任何东西能在不经过它的情况下
到达 provider，而契约可以描述自身：

```ts
import { EgressContract } from 'jevcore'

for (const line of contract.reportLines()) console.log(line)
// [jevcore] provider=mock  endpoint=none  egress=OFF  (no network calls will be made; ...)
```

脱敏在度量之前运行，因此报告出来的大小就是实际离开的大小。
它的局限是被记录下来的，而不是被隐藏的：它会移除可识别字段名下的值，
以及匹配已知密钥形状的字符串，
并且它**不会**捕获自由文本中无法识别的密钥。

### 概率不是许可证

`applyPolicy` 依据位于你的配置中、而绝不在模型输出中的阈值，
把 Jev 的数字变成 `allow` / `ask` / `deny`。

```ts
import { applyPolicy, DEFAULT_POLICY } from 'jevcore'

const verdict = applyPolicy(answer, ['low', 'medium', 'high'], {
  ...DEFAULT_POLICY,
  accept: { low: true, medium: false, high: false },
})
// decided | undecided | invalid
```

一个给出的值在你所声明判据之外的答案是 `invalid`，而不是被信任：
带类型决策模型的保证是它无法返回未声明的值，因此一次违反意味着上游
有什么东西不对。

`undecided` 裁决不是 `allow`。一个在不确定时默认放行的闸门
不是闸门。

## 这里包含什么

| 领域 | 导出 |
|---|---|
| 原语 | `noul`, `choice`, `score`, `assertValidBatch`, `topCriterion` |
| Provider | `MockProvider`, `LiveProvider`, `assertUsableEndpoint` |
| 外发 | `EgressContract`, `EGRESS_FEATURES`, `EGRESS_FIELDS`, `EgressDeniedError` |
| 脱敏 | `redact`, `DEFAULT_KEY_RULES`, `DEFAULT_VALUE_RULES` |
| 策略 | `applyPolicy`, `verdictToAction`, `DEFAULT_POLICY` |
| 校验 | `resolveCheck`, `VERDICT_QUESTION`, `DEFAULT_CHECK_THRESHOLDS` |
| 服务 | `JevService` |
| 闸门 | `createSafetyGate`, `createContextGate` |
| 配置 | `resolveConfig`, `Config`, `DEFAULT_CONFIG` |
| 凭据 | `resolveApiKey`, `describeKeySource` |

闸门与框架无关：它们接收一个普通输入 —— 一个工具名及其参数，
或者一个结果的内容 —— 并返回一个决策。
把它们接到哪一个具体事件上是适配器的工作。

## mock provider

确定性的、离线的：每个答案都从问题与状态的哈希推导而来，
因此测试可以断言精确的值，并且不会打开任何 socket。
合成结果在三处被标注 —— `provider: "mock"`、一个 `mock/jev-synthetic` 模型名，
以及结果上的一个 `warning` 字段。
一个可能被误认为真实判断的 mock，会比完全没有 mock 更糟。

它变化的东西比这句话听起来要窄，而且有一个输入它从不读取，那就是问题的
`instructions` 文本：哈希只覆盖问题的 id 和请求的 state。因此，同一个 id、同一个
state 下两个措辞不同的问题会得到同一个答案，mock 也就无法告诉你一个提示词的措辞
好不好。声明的判据同样不进入哈希，但它们仍然决定答案的形状 —— `choice` 答案把它的一份
概率摊在你声明的那些标签上，`score` 答案摊在你声明的层数上。两者报告的置信度都固定为
0.5。[docs/limits.md](docs/limits.md) 列出了离线路径没有建模的其他东西。

## 开发

```sh
pnpm install
pnpm run check
```

没有任何测试需要凭据或网络连接。

## 许可证

[Apache License 2.0](LICENSE) © 2026 jevcore contributors. TypeSafe、Jev 以及
System One 是 TypeSafe AI 的商标；这是一个独立集成，
与 TypeSafe AI 无隶属关系，也未获其背书。
