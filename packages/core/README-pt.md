# jevcore

Decisões TypeSafe [Jev](https://typesafe.ai), sem nenhum framework acoplado.

Este pacote não importa nada do DeepSeek Harness, do Cordis nem de qualquer runtime
de plugin. Ele pode ser usado a partir de um script Node comum, de um servidor MCP,
de uma CLI ou de um adaptador de harness de agente — e é por isso que os adaptadores
deste repositório são camadas finas sobre ele, e não o contrário.

O Jev não é um modelo de chat. Ele responde a perguntas tipadas — `noul` (sim/não), `choice`,
`score` — e devolve probabilidades calibradas. Ele não escreve prosa.

**Offline por padrão. Saída de dados declarada. Nada ativado por padrão.**

## Instalação

```sh
npm install jevcore
```

`@typesafe-ai/sdk` é uma dependência opcional. Sem ela o pacote continua funcionando
por completo com o mock offline; apenas `provider: live` precisa dela, e ela é
importada sob demanda.

## As duas ideias que vale a pena conhecer

### O contrato de saída

`EgressContract` é o único lugar que decide o que pode sair da máquina.

Todo recurso capaz de transmitir declara os campos que envia e o limite de cada um.
Nenhum recurso transmite a menos que esteja ligado. Nada chega a um provedor sem
passar por ele, e o contrato consegue se descrever:

```ts
import { EgressContract } from 'jevcore'

for (const line of contract.reportLines()) console.log(line)
// [jevcore] provider=mock  endpoint=none  egress=OFF  (no network calls will be made; ...)
```

O mascaramento roda antes da medição, então os tamanhos reportados são os tamanhos
que realmente saem. Seu limite é documentado em vez de escondido: ele remove valores
sob nomes de campo reconhecíveis e strings que casam com formatos conhecidos de
segredo, e **não vai** capturar um segredo não reconhecido em texto livre.

### Uma probabilidade não é uma permissão

`applyPolicy` transforma os números do Jev em `allow` / `ask` / `deny` segundo limites
que ficam na sua configuração, nunca na saída do modelo.

```ts
import { applyPolicy, DEFAULT_POLICY } from 'jevcore'

const verdict = applyPolicy(answer, ['low', 'medium', 'high'], {
  ...DEFAULT_POLICY,
  accept: { low: true, medium: false, high: false },
})
// decided | undecided | invalid
```

Uma resposta que nomeia um valor fora dos critérios que você declarou é `invalid`, não
confiável: a garantia de um modelo de decisão tipado é que ele não pode devolver um
valor não declarado, então uma violação significa que algo a montante está errado.

Um veredito `undecided` não é um `allow`. Um gate que, na dúvida, permite por padrão
não é um gate.

## O que há aqui

| Área | Exportações |
|---|---|
| Primitivas | `noul`, `choice`, `score`, `assertValidBatch`, `topCriterion` |
| Provedores | `MockProvider`, `LiveProvider`, `assertUsableEndpoint` |
| Saída | `EgressContract`, `EGRESS_FEATURES`, `EGRESS_FIELDS`, `EgressDeniedError` |
| Mascaramento | `redact`, `DEFAULT_KEY_RULES`, `DEFAULT_VALUE_RULES` |
| Política | `applyPolicy`, `verdictToAction`, `DEFAULT_POLICY` |
| Verificação | `resolveCheck`, `VERDICT_QUESTION`, `DEFAULT_CHECK_THRESHOLDS` |
| Serviço | `JevService` |
| Gates | `createSafetyGate`, `createContextGate` |
| Configuração | `resolveConfig`, `Config`, `DEFAULT_CONFIG` |
| Credenciais | `resolveApiKey`, `describeKeySource` |

Os gates são agnósticos de framework: recebem uma entrada simples — o nome de uma
ferramenta e seus argumentos, ou o conteúdo de um resultado — e devolvem uma decisão.
Ligá-los a um evento específico é trabalho do adaptador.

## O provedor mock

Determinístico e offline: toda resposta é derivada de um hash da pergunta e do
estado, então os testes podem afirmar valores exatos e nenhum socket é aberto. Resultados
sintéticos são rotulados em três lugares — `provider: "mock"`, um nome de
modelo `mock/jev-synthetic` e um campo `warning`. Um mock que pudesse ser confundido
com um julgamento real seria pior do que nenhum mock.

## Desenvolvimento

```sh
pnpm install
pnpm run check
```

Nenhum teste exige credencial nem conexão de rede.

## Licença

[Apache License 2.0](LICENSE) © 2026 jevcore contributors. TypeSafe, Jev e System One
são marcas comerciais da TypeSafe AI; esta é uma integração independente e não é
afiliada nem endossada por ela.
