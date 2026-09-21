# jevcore

[![DSH Market](https://raw.githubusercontent.com/2BingLing/dsh-market/master/assets/readme/badge-listed-en.svg)](https://dsh.market/)

TypeSafe [Jev](https://typesafe.ai) para o [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
e qualquer outro host MCP.

Jev não é um modelo de chat. Ele responde a perguntas tipadas — `noul` (sim/não), `choice`, `score` — e
devolve probabilidades calibradas. Ele não escreve texto livre, e pedir isso a ele é um erro de
categoria. Este projeto dá a um agente exatamente essa superfície, e nada mais.

**Offline por padrão. Saída de dados divulgada. Nada ativado por padrão.**

---

## Três pacotes, uma camada de decisão

| Pacote | O que é | Use quando |
|---|---|---|
| [`jevcore`](packages/core) | As decisões. Não importa nada do DeepSeek Harness nem do Cordis. | Você quer o Jev em um script comum, em um serviço ou no seu próprio harness |
| [`jevcore-dsh`](packages/dsh) | O plugin do DSH: um serviço, três ferramentas, dois portões opcionais | Você está executando o DeepSeek Harness |
| [`jevcore-mcp`](packages/mcp) | As mesmas três ferramentas via MCP, com um binário stdio | Seu host fala MCP, mas não é DSH |

Os adaptadores são finos de propósito. `packages/dsh` são quatro arquivos: ele declara os esquemas das
ferramentas e traduz as cargas úteis dos hooks. Tudo que tem formato de decisão — as primitivas, os
provedores, o contrato de saída, a política, os portões — vive no core, de modo que um novo adaptador não
possa divergir das garantias que os outros oferecem.
Um requisito de runtime difere entre os três: `jevcore-dsh` acompanha o harness e
precisa de Node `^22.19.0 || >=24.0.0`, enquanto `jevcore` e `jevcore-mcp` precisam de `>=20`.

---

## Por que isto existe

Entre 2026-09-17 e 09-20, surgiram dezenove plugins que integram o Jev ao DSH. A auditoria do código-fonte
deles encontrou um padrão consistente: o módulo rotulado como *guard*, *gate* ou *warden* era também o
módulo que enviava prompts, argumentos de ferramentas e conteúdos de arquivos a terceiros, e o README em
geral não dizia isso. Vários vinham ativados por padrão. Um dos portões podia ser reconfigurado pelo
próprio modelo que ele deveria vigiar.

Este projeto é a mesma ideia com esses modos de falha projetados para fora:

| Propriedade | Como ela é garantida aqui |
|---|---|
| Nenhuma chamada de rede a menos que você peça uma | O provedor padrão é um mock offline; o caminho live exige tanto `provider: live` quanto uma credencial resolvida |
| Toda transmissão nomeada antes de acontecer | Uma linha de log na inicialização por recurso: `off` ou `SENDS <feature> { fields }` |
| Portões desativados não registram nada | Verificado por teste, não por política — um portão desativado não adiciona nenhum event listener |
| O modelo não pode ampliar suas próprias restrições | Nenhuma ferramenta expõe a configuração dos portões |
| Um juiz que não consegue responder nunca significa "permitir" | O indecidido é resolvido por configuração explícita, com padrão `ask` |

---

## O contrato de saída

Esta é a parte que vale a pena ler antes de instalar.

A transmissão é decidida por recurso, e todo recurso tem padrão desativado. O plugin imprime o próprio
contrato ao carregar:

```
[jevcore] provider=mock  endpoint=none  egress=OFF  (no network calls will be made; every answer is synthetic)
[jevcore] ready - provider=mock - gates: safety=off context=off
```

Com `provider: live` e todos os recursos ativados, o mesmo relatório passa a ser explícito sobre o que
sai da máquina:

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

| Recurso | Desativado por padrão? | O que ele envia |
|---|---|---|
| `tool:jev_ask` | executa quando o modelo o chama | os argumentos que o modelo passou, após a redação |
| `tool:jev_rank` | executa quando o modelo o chama | a consulta mais cada candidato |
| `tool:jev_check` | executa quando o modelo o chama | a afirmação e sua evidência |
| `gate:safety` | **sim — adesão explícita** | o nome da ferramenta, seus argumentos, a raiz do workspace |
| `gate:context` | **sim — adesão explícita** | um resultado grande de ferramenta que o agente acabou de receber |

As ferramentas só transmitem quando o modelo escolhe chamá-las, o que é visível no transcript. Os portões
seriam executados a cada chamada de ferramenta correspondente, o que não é visível, por isso eles são
opt-in.

### Redação, e seu limite honesto

Antes de qualquer envio, `src/redact.ts` executa duas passagens: valores sob nomes de campos sensíveis
(`password`, `token`, `apiKey`, `authorization`, …) são substituídos por completo, e strings com formato
de segredo que sobrevivem no texto livre passam por correspondência de padrões (`Bearer …`, `sk-…`,
`ts_live_…`, formatos de chave da AWS/GitHub/Google, JWTs, cabeçalhos de chave privada, credenciais em
connection strings).

Isto é uma mitigação, não uma permissão. Um segredo que esteja sob um nome de chave não reconhecido *e*
não corresponda a um formato conhecido vai passar. Se essa possibilidade for inaceitável para a sua
carga de trabalho, não ative o provedor live.

---

## Instalação

### Como plugin do DeepSeek Harness

```sh
dsh plugin --profile <profile> add jevcore-dsh
```

Ou a partir de um checkout:

```sh
dsh plugin --profile <profile> add /absolute/path/to/jevcore/packages/dsh
```

`packages/dsh` importa `jevcore` pelo nome, então um checkout também precisa do core
resolvível a partir do profile (`add /absolute/path/to/jevcore/packages/core`).

Depois confirme que a linha foi ativada — a lista de plugins deve mostrar `jev` como `active`,
e não `failed` — e verifique o relatório de inicialização no log.

### Como servidor MCP

Para um host que fala MCP, as mesmas três ferramentas ficam disponíveis via stdio:

```sh
npx -y jevcore-mcp
```

Para conectá-lo especificamente ao DeepSeek Harness, instale um bundle somente de configuração
cujo patch insere o próprio cliente MCP do harness:

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

O mapa env não é opcional: o DSH remove todo nome com forma de credencial
(qualquer um que contenha KEY, PASSWORD, SECRET ou TOKEN, sem diferenciar
maiúsculas) do ambiente que entrega a um servidor iniciado, e só depois mescla este
mapa. Uma chave exportada no seu shell nunca chega, e o servidor permanece no mock
offline sem relatar erro.

O provedor é escolhido a partir do ambiente:

| Variável | Efeito |
|---|---|
| `TYPESAFE_API_KEY` | Seleciona a rota TypeSafe quando presente |
| `OPENROUTER_API_KEY` | Seleciona a rota OpenRouter quando presente e não há chave TypeSafe |
| `JEV_PROVIDER` | `mock`, `live` ou `openrouter` — sobrepõe a heurística acima |
| `TYPESAFE_MODEL` / `OPENROUTER_MODEL` | Id do modelo para a rota selecionada |
| `TYPESAFE_BASE_URL` / `OPENROUTER_BASE_URL` | Raiz da API para a rota selecionada |

Sem nenhuma das duas chaves, ele permanece no mock offline. Diferentemente do plugin, o servidor MCP
resolve sua credencial uma única vez na inicialização, então uma chave ausente com
`JEV_PROVIDER=live` é um erro de inicialização, e não uma surpresa a cada chamada.

O relatório de saída dele vai para **stderr**, nunca para stdout — em um transporte stdio o stdout
é o canal do protocolo, e uma linha perdida ali corromperia o fluxo.

### Passando para live

Há duas rotas para o Jev. Ambas chamam os mesmos modelos e ambas retornam as mesmas
respostas tipadas; elas diferem em quem detém a sua credencial e quais servidores veem
o seu estado.

**TypeSafe diretamente** — use esta se você tem uma chave de
[console.typesafe.ai](https://console.typesafe.ai/settings/keys):

```yml
- insert:
    - id: jev
      name: 'jevcore-dsh'
      config:
        provider: live
        apiKeyRef: TYPESAFE_API_KEY   # a reference, never the key
        model: jev-latest
```

**Através do OpenRouter** — use esta se uma chave TypeSafe for inviável e você
já tiver uma chave do [OpenRouter](https://openrouter.ai). O OpenRouter serve os
modelos System One no mesmo caminho `POST /v1/systemone` que a TypeSafe usa, um nível
abaixo da sua própria raiz de API, então esta é a rota documentada para o Jev, e não uma
aproximação dela:

```yml
- insert:
    - id: jev
      name: 'jevcore-dsh'
      config:
        provider: openrouter
        openRouterApiKeyRef: OPENROUTER_API_KEY
        model: jev-latest              # a bare `jev-*` id, or `typesafe/jev-1.13`
```

A rota é alcançada apontando o `@typesafe-ai/sdk` oficial para
`https://openrouter.ai/api` com a sua chave do OpenRouter — a integração documentada
pelo próprio OpenRouter, então não há um segundo cliente para manter em sincronia.

Duas coisas a saber sobre a rota OpenRouter:

- **Seu estado vai para o OpenRouter, não para a TypeSafe.** Um terceiro diferente,
  com retenção e logging diferentes. O relatório de inicialização nomeia o endpoint
  exatamente por esse motivo — leia-o em vez de inferir o destino a partir do
  nome do provedor.
- **Ela retorna um custo**, o que a rota da própria TypeSafe não faz, então `usage.costUsd`
  é preenchido aqui e ausente lá.

O id do modelo precisa ser de um System One. O `jev-latest` puro é o padrão e não
precisa de prefixo; `typesafe/` é aceito em um id versionado como `typesafe/jev-1.13`,
mas não na tag móvel — a rota não aceita `typesafe/jev-latest`. Qualquer outro id seria
encaminhado a um modelo de chat, que responde com texto livre que este
plugin não consegue interpretar como uma decisão, então ele é recusado antes da chamada em vez de
mal interpretado depois dela.

De qualquer forma, a credencial é resolvida primeiro pelo serviço de credenciais do DSH,
depois pela variável de ambiente com esse nome. Ela é lida a cada chamada, então uma chave adicionada
enquanto o processo está em execução é reconhecida. Ela nunca é registrada em log, nunca é retornada
por uma ferramenta e nunca é escrita na configuração. Cada rota tem sua própria referência
(`apiKeyRef` e `openRouterApiKeyRef`) para que as duas não possam compartilhar uma chave por acidente.

`@typesafe-ai/sdk` é a única dependência opcional; o plugin
carrega e funciona offline sem nenhuma delas, e só precisa daquela referente à rota que você
escolher.

---

## Configuração

| Chave | Padrão | Significado |
|---|---|---|
| `provider` | `mock` | `mock` (offline, determinístico, sintético), `live` (TypeSafe) ou `openrouter` |
| `apiKeyRef` | `TYPESAFE_API_KEY` | Referência de credencial para a rota `live` |
| `openRouterApiKeyRef` | `OPENROUTER_API_KEY` | Referência de credencial para a rota `openrouter` |
| `baseURL` | `https://api.typesafe.ai` | Raiz da API para a rota `live`. Não-HTTPS é recusado, exceto em loopback |
| `openRouterBaseURL` | `https://openrouter.ai/api` | Raiz da API para a rota `openrouter`. Mesma regra |
| `model` | `jev-latest` | Enviado com toda requisição. Na rota OpenRouter o padrão puro basta; `typesafe/` exige um id versionado como `typesafe/jev-1.13`, e `typesafe/jev-latest` não é aceito |
| `logLevel` | `warn` | `silent` \| `warn` \| `info` \| `debug` |
| `minConfidence` | `0.7` | Abaixo disto, uma resposta não é acionada |
| `minProbability` | `0.6` | Abaixo disto, uma decisão não é acionada |
| `maxStateChars` | por recurso | Substitui o limite de `state` para todos os recursos. `0` significa "manter o limite declarado" |
| `gates.safety` | `false` | Julga chamadas de ferramenta antes do despacho |
| `gates.context` | `false` | Retém resultados de ferramenta grandes e pouco informativos |

Os limites declarados de `state` são 16.000 caracteres para as três ferramentas e 8.000 / 6.000 para os
portões de safety e de context. `maxStateChars` substitui todos eles, e o relatório de inicialização mostra
o valor efetivo em vez do declarado, de modo que o que ele imprime é o que é aplicado.

Os portões aceitam um booleano puro (`safety: false`) ou um objeto com `onUndecided`: `ask` (padrão),
`allow` ou `deny`.

`ask` é uma pergunta, portanto precisa de algo a quem perguntar. Uma implantação que não compõe nenhum
serviço de aprovação não consegue escalar para um humano, e o DeepSeek Harness então recusa a chamada
em vez de executá-la: toda ferramenta com que o portão de safety casa é recusada, o que um operador
vive como o plugin ter quebrado todos os comandos de shell. [docs/approval.md](docs/approval.md) tem o
mecanismo, e o README do plugin cobre a visão de implantação.

Um valor desconhecido é recusado no carregamento com uma mensagem que nomeia a chave, em vez de ser
silenciosamente ignorado — um erro de digitação na configuração não deve mudar discretamente a postura de
privacidade.

---

## Usando

### De outro plugin, sem modelo no circuito

O serviço é a superfície principal. É este o ponto de um modelo de decisão: uma decisão de roteamento ou
de liberação não deveria custar uma ida e volta ao modelo.

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

`result.answers` carrega probabilidades e confiança. Decidir o que fazer com elas é trabalho do seu
código — veja `src/policy.ts` para um exemplo completo com um piso de confiança explícito, em que uma
resposta incerta produz `ask` em vez de `allow`.

### A partir do modelo

Três ferramentas, deliberadamente poucas e ortogonais:

- **`jev_ask`** — um lote de perguntas tipadas sobre um estado.
- **`jev_rank`** — pontua e ordena candidatos segundo um critério, uma pergunta por candidato em uma
  única ida e volta. As probabilidades são julgamentos independentes por candidato, não uma distribuição.
- **`jev_check`** — esta evidência sustenta esta afirmação? Retorna `supported`, `contradicted`,
  `conflicted`, `insufficient`, `undecided` ou `unknown`. A contradição tem precedência sobre o suporte, porque uma
  evidência que ao mesmo tempo sustenta e refuta é um conflito, não um "sim" fraco.

### Uma skill empacotada

O plugin registra uma skill, `typesafe-ai-dsh`, que ensina a um agente quando um julgamento
do Jev é a ferramenta certa e quando é um erro de categoria. Ela é registrada
pelo registro de skills em vez de ser entregue como um diretório para um provedor
varrer, então não depende de onde um profile guarda suas skills e
desaparece de forma limpa quando o plugin é removido.

O corpo fica em `skills/typesafe-ai-dsh/SKILL.md` e é lido no carregamento em vez de
incorporado, de modo que o arquivo que uma pessoa edita é o arquivo que é entregue. Um teste garante
que os dois não possam divergir.

O registro é declarado como uma dependência **opcional**: um profile que não
compõe o subsistema de skills ainda recebe o serviço e as três ferramentas, com um
aviso de que a skill foi ignorada.

### O provedor mock

Com `provider: mock`, toda resposta é derivada de um hash da pergunta e do estado, então os testes podem
afirmar valores exatos e nenhum socket é aberto. Resultados sintéticos são rotulados como tais em três lugares:
`provider: "mock"`, um nome de modelo `mock/jev-synthetic` e um campo `warning` no resultado. Um mock
que pudesse ser confundido com um julgamento real seria pior do que nenhum mock.

---

## Status

Prestação de contas honesta do que foi e do que não foi verificado.

**Verificado**
- 410 testes passam nos três pacotes (314 core, 66 DSH, 30 MCP), sem acesso à rede e sem
  `TYPESAFE_API_KEY`. A CI limpa a variável e espera que a suíte passe mesmo assim.
- **A rota OpenRouter é verificada contra a API real.** `pnpm --filter jevcore run
  probe:live` aciona o provedor e `pnpm --filter jevcore-mcp run smoke:live` aciona toda a superfície
  MCP — transporte, esquemas de ferramentas, serviço e provedor — contra modelos System One reais
  (`typesafe/jev-1.13-20260917`). Um lote de três primitivas retornou um `noul` em 0,91, um `choice` em
  0,97 e um `score` de `1.05` em uma rubrica de quatro níveis, com uso relatado como
  `{ inputTokens: 469, outputTokens: 68, costUsd: 0.000019698 }`. O `jev_rank` ordenou um runbook de
  credenciais acima de um guia de faturamento; o `jev_check` retornou `contradicted`. Ambos os scripts precisam de
  `OPENROUTER_API_KEY` e são excluídos da CI.
- **Os formatos de payload são conferidos contra as próprias definições de tipo dos fornecedores.**
  `test/vendor-conformance.test.ts` fixa os tipos de pergunta e resposta deste projeto em ambos os SDKs, de modo que uma
  divergência em qualquer direção é um erro de compilação, e não uma requisição malformada na única rota que
  custa dinheiro e transmite dados. Foi essa conferência que encontrou `score.criteria` sendo enviado como um mapa com chaves
  quando a API exige um array ordenado — um defeito que os testes unitários com stub haviam deixado passar
  o tempo todo. Há também um script que analisava nossos payloads contra os esquemas zod publicados do OpenRouter
  para a rota `alpha/decisions`; tanto o script quanto essa rota não existem mais, porque o
  provedor OpenRouter agora usa o caminho documentado `/v1/systemone` através do mesmo cliente que a TypeSafe
  usa, o que o teste de conformidade já cobre.
- **O plugin é ativado em um harness em execução e suas ferramentas funcionam.** A linha do plugin reporta `active`;
  `jev_ask` retornou `urgent=true (0.8307)` e `team=billing (0.5027)` contra o mock em 1 ms, e
  `jev_check` retornou `verdict="insufficient"` com suas três probabilidades. Todo resultado carregava
  `provider: "mock"` e uso zero de tokens, então o caminho padrão não fez nenhuma chamada de rede.
- **A skill empacotada se registra.** `typesafe-ai-dsh` aparece no catálogo de skills da sessão.
- O caminho padrão não faz nenhuma chamada de rede: comprovado espionando `globalThis.fetch` ao montar o
  plugin e responder através do serviço, e de novo ao montar o runtime do MCP.
- Um portão desativado não registra **nenhum** event listener, e uma saída negada nunca chega ao provedor.
- `Config` satisfaz o protocolo Standard Schema que o Cordis exige antes de um plugin iniciar.
- Toda API do DSH usada aqui (`ctx.provide`, `ctx.effect`, `tools.register`, `defineTool`,
  `tools/pre-execute`, `tools/post-execute`, `credentials.resolve`) foi conferida contra o runtime
  instalado antes do uso, e os tipos de payload vêm dos arquivos de declaração instalados.

**Não verificado, ou sabidamente quebrado**
- **A rota TypeSafe está exercitada, mas apenas de forma leve.** `packages/core/scripts/probe-live.mjs`
  (`pnpm --filter jevcore run probe:typesafe`) pergunta à API real três coisas: dez pares
  claim/evidence cujo veredicto é conhecido de antemão, uma pergunta repetida seis vezes e um noul com
  um limite `criteria: {true, false}`. Duas execuções separadas concordaram — a evidência que sustenta
  obteve 0.95, a que contradiz 0.10, a que se cala sobre a afirmação 0.03, e a pergunta repetida
  variou 0.01 ou menos. O limite foi aceito. O que continua sem teste é tudo o que envolve a
  requisição em vez da requisição em si: o comportamento de cota, limite de requisições e
  entitlement em uma conta real.
- **A descrição de `jev_ask` carrega um travessão corrompido na build que está em execução no momento.** Ela
  exibe `branches on —?routing` onde deveria haver um travessão em dash seguido de um espaço. Causa: uma ida e volta
  UTF-8 no início do desenvolvimento substituiu o terceiro byte do travessão em dash por `?`. Está corrigido em disco — quatro
  ocorrências, zero restantes, confirmado tanto no código-fonte quanto na saída da build — mas o processo em execução
  carregou seu módulo antes da correção e não consegue relê-lo sem reiniciar. O travessão em si é
  cosmético, mas a desatualização não é: o mesmo processo também não tem nenhuma correção feita desde
  que iniciou, incluindo o campo `band` que impede que um 0.51 seja lido como um sim resolvido.
- O servidor MCP foi acionado de ponta a ponta por um cliente MCP real via stdio
  (`pnpm --filter jevcore-mcp run smoke`): handshake, descoberta de ferramentas, três chamadas bem-sucedidas e um
  resultado de erro para um lote inválido. Ele não foi acionado por nenhum outro host de terceiros.
- Comportamento dos portões em tráfego live. Os portões são testados contra respostas sintéticas e formatos reais de payload
  de hook, mas nenhuma chamada de ferramenta real foi filtrada de ponta a ponta.
- O portão de context não consegue recuperar contexto já gasto. Ele impede que um resultado chegue ao
  agente; ele não poda nada retroativamente, e o README de qualquer plugin que afirme o contrário
  deve ser lido com ceticismo.
- Nenhum teste de longa duração ou adversarial. A redação é baseada em padrões e vai deixar passar um formato de
  segredo não reconhecido.

---

## Notas de design

Três decisões que são fáceis de errar e caras de errar:

**Um juiz que não consegue responder não pode significar "permitir".** Se o Jev está inacessível, ou responde abaixo do
piso de confiança, os portões se resolvem por `onUndecided`, que tem padrão `ask`. A única forma de
obter comportamento fail-open é configurá-lo. O portão de context é a exceção deliberada: ele falha
aberto incondicionalmente, porque perder um resultado real de ferramenta para um veredito fantasma de "irrelevante" é pior
do que manter um resultado pouco informativo.

**Nada que o modelo possa dizer altera o portão.** Nenhuma ferramenta expõe a configuração dos portões, os limites ou o
escopo. Um guarda que o processo vigiado pode reconfigurar não é um guarda.

**Uma probabilidade não é uma permissão.** O Jev retorna números; `src/policy.ts` os transforma em
`allow`/`ask`/`deny` segundo limites configurados localmente. Uma resposta que nomeia um valor fora dos
critérios declarados é `invalid` e nega — a garantia de um modelo de decisão tipado é que ele não pode
retornar um valor não declarado, então uma violação significa que algo a montante está errado.

## Desenvolvimento

```sh
pnpm install
pnpm run check      # typecheck + tests + build
pnpm test           # tests only
```

Nenhum teste exige uma credencial ou uma conexão de rede, e a CI reforça isso executando com
`TYPESAFE_API_KEY` limpa.

## Licença

[Apache License 2.0](LICENSE) © 2026 jevcore contributors

TypeSafe, Jev e System One são marcas registradas da TypeSafe AI. Este projeto é uma integração
independente e não é afiliado à TypeSafe AI nem endossado por ela.
