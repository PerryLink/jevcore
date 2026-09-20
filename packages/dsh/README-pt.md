# jevcore

TypeSafe [Jev](https://typesafe.ai) para o [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
e para qualquer outro host MCP.

O Jev não é um modelo de chat. Ele responde a perguntas tipadas — `noul` (sim/não), `choice`, `score` — e
devolve probabilidades calibradas. Ele não escreve prosa, e pedir isso a ele é um erro de categoria. Este
projeto dá a um agente exatamente essa superfície, e nada mais.

**Offline por padrão. Saída de dados declarada. Nada ativado por padrão.**

---

## Três pacotes, uma camada de decisão

| Pacote | O que é | Use quando |
|---|---|---|
| [`jevcore`](packages/core) | As decisões. Não importa nada do DeepSeek Harness nem do Cordis. | Você quer o Jev num script comum, num serviço ou no seu próprio harness |
| [`jevcore-dsh`](packages/dsh) | O plugin de DSH: um serviço, três ferramentas, dois gates opt-in | Você está rodando o DeepSeek Harness |
| [`jevcore-mcp`](packages/mcp) | As mesmas três ferramentas via MCP, com um binário stdio | Seu host fala MCP, mas não é DSH |

Os adaptadores são finos de propósito. `packages/dsh` é composto de quatro arquivos: ele declara esquemas de
ferramentas e traduz payloads de hook. Tudo que tem forma de decisão — as primitivas, os provedores, o
contrato de saída, a política, os gates — vive no core, então um novo adaptador não consegue se afastar
das garantias que os outros oferecem.
Um requisito de runtime difere entre os três: `jevcore-dsh` acompanha o harness e
precisa de Node `^22.19.0 || >=24.0.0`, enquanto `jevcore` e `jevcore-mcp` precisam de `>=20`.

---

## Por que isto existe

Entre 2026-09-17 e 09-20, dezenove plugins apareceram para ligar o Jev ao DSH. Auditar o código deles
revelou um padrão consistente: o módulo rotulado *guarda*, *gate* ou *vigia* era também o módulo que
enviava prompts, argumentos de ferramentas e conteúdo de arquivos a terceiros, e o README em geral não
dizia isso. Vários vinham ativados por padrão. Um gate podia ser reconfigurado pelo modelo que ele vigiava.

Este projeto é a mesma ideia com esses modos de falha eliminados por projeto:

| Propriedade | Como isso é garantido aqui |
|---|---|
| Nenhuma chamada de rede a menos que você peça | O provedor padrão é um mock offline; o caminho live exige tanto `provider: live` quanto uma credencial resolvida |
| Toda transmissão nomeada antes de acontecer | Uma linha de log na inicialização por recurso: `off` ou `SENDS <feature> { fields }` |
| Gates desativados não registram nada | Verificado por teste, não por política — um gate desativado não adiciona nenhum listener de evento |
| O modelo não pode ampliar suas próprias restrições | Nenhuma ferramenta expõe a configuração dos gates |
| Um juiz que não consegue responder nunca significa "allow" | Um resultado indefinido resolve por configuração explícita, com padrão `ask` |

---

## O contrato de saída

Esta é a parte que vale a pena ler antes de instalar.

A transmissão é decidida por recurso, e todo recurso vem desativado por padrão. O plugin imprime seu
próprio contrato ao carregar:

```
[jevcore] provider=mock  endpoint=none  egress=OFF  (no network calls will be made; every answer is synthetic)
[jevcore] ready - provider=mock - gates: safety=off context=off
```

Com `provider: live` e todos os recursos ativados, o mesmo relatório fica explícito sobre o que sai:

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

| Recurso | Desativado por padrão? | O que envia |
|---|---|---|
| `tool:jev_ask` | roda quando o modelo o chama | os argumentos que o modelo passou, após o mascaramento |
| `tool:jev_rank` | roda quando o modelo o chama | a consulta mais todos os candidatos |
| `tool:jev_check` | roda quando o modelo o chama | a afirmação e suas evidências |
| `gate:safety` | **sim — opt-in explícito** | o nome da ferramenta, seus argumentos, a raiz do workspace |
| `gate:context` | **sim — opt-in explícito** | um resultado de ferramenta grande que o agente acabou de receber |

As ferramentas só transmitem quando o modelo escolhe chamá-las, o que é visível no transcript. Os
gates rodariam a cada chamada de ferramenta correspondente, o que não é visível, por isso são opt-in.

### O mascaramento e o seu limite honesto

Antes de qualquer envio, `src/redact.ts` roda duas passagens: valores sob nomes de campo sensíveis
(`password`, `token`, `apiKey`, `authorization`, …) são substituídos por inteiro, e strings com formato
de segredo que sobrevivem em texto livre são casadas por padrão (`Bearer …`, `sk-…`, `ts_live_…`, formatos
de chave AWS/GitHub/Google, JWTs, cabeçalhos de chave privada, credenciais em strings de conexão).

Isto é uma mitigação, não uma permissão. Um segredo que esteja sob um nome de chave não reconhecido *e*
não case com um formato conhecido vai passar. Se essa possibilidade é inaceitável para sua carga de
trabalho, não ative o provedor live.

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

`packages/dsh` importa `jevcore` por nome, então um checkout também precisa que o core seja
resolvível a partir do perfil (`add /absolute/path/to/jevcore/packages/core`).

Depois confirme que a linha foi ativada — a lista de plugins deve mostrar `jev` como `active`,
não `failed` — e verifique o relatório de inicialização no log.

### Como servidor MCP

Para um host que fala MCP, as mesmas três ferramentas estão disponíveis via stdio:

```sh
npx -y jevcore-mcp
```

Para ligá-lo especificamente ao DeepSeek Harness, instale um bundle apenas de configuração
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
        failOnStartupError: true
```

O provedor é escolhido a partir do ambiente:

| Variável | Efeito |
|---|---|
| `TYPESAFE_API_KEY` | Seleciona a rota TypeSafe quando presente |
| `OPENROUTER_API_KEY` | Seleciona a rota OpenRouter quando presente e não há chave TypeSafe |
| `JEV_PROVIDER` | `mock`, `live` ou `openrouter` — sobrepõe a heurística acima |
| `TYPESAFE_MODEL` / `OPENROUTER_MODEL` | Id do modelo para a rota selecionada |
| `TYPESAFE_BASE_URL` / `OPENROUTER_BASE_URL` | Raiz da API para a rota selecionada |

Sem nenhuma das duas chaves, ele fica no mock offline. Diferente do plugin, o servidor MCP
resolve sua credencial uma única vez na inicialização, então a falta de chave com
`JEV_PROVIDER=live` é um erro de inicialização, e não uma surpresa a cada chamada.

O relatório de saída dele vai para **stderr**, nunca para stdout — num transporte stdio, o stdout
é o canal do protocolo, e uma linha perdida ali corromperia o fluxo.

### Passando para live

Há duas rotas para o Jev. Ambas chamam os mesmos modelos e ambas devolvem as mesmas
respostas tipadas; elas diferem em quem guarda sua credencial e em quais servidores
veem o seu estado.

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

**Via OpenRouter** — use esta se uma chave TypeSafe for inviável e você
já tiver uma chave [OpenRouter](https://openrouter.ai). A OpenRouter hospeda os
modelos System One no mesmo caminho `POST /v1/systemone` que a TypeSafe usa, um nível abaixo
da sua própria raiz de API, então esta é a rota documentada para o Jev, e não uma aproximação:

```yml
- insert:
    - id: jev
      name: 'jevcore-dsh'
      config:
        provider: openrouter
        openRouterApiKeyRef: OPENROUTER_API_KEY
        model: jev-latest              # a bare `jev-*` id, or `typesafe/jev-1.13`
```

Duas coisas a saber sobre a rota OpenRouter:

- **Seu estado vai para a OpenRouter, não para a TypeSafe.** Um terceiro diferente,
  com retenção e logging diferentes. O relatório de inicialização nomeia o endpoint
  exatamente por isso — leia-o em vez de inferir o destino a partir do nome do
  provedor.
- **Ela devolve um custo**, o que a própria rota da TypeSafe não faz, então `usage.costUsd` é
  preenchido aqui e ausente lá.

O id do modelo precisa ser um id de System One. O `jev-latest` puro é o padrão e não
precisa de prefixo; `typesafe/` é aceito em um id versionado como `typesafe/jev-1.13`,
mas não na tag móvel — a rota não aceita `typesafe/jev-latest`. Qualquer outro id seria roteado para um modelo
de chat, que responde com prosa que este plugin não consegue interpretar como decisão, então ele
é recusado antes da chamada, e não mal interpretado depois dela.

De qualquer forma, a credencial é resolvida primeiro pelo serviço de credenciais do DSH,
depois pela variável de ambiente com aquele nome. Ela é lida a cada chamada, então uma chave adicionada
com o processo em execução é captada. Ela nunca é registrada em log, nunca é devolvida
por uma ferramenta e nunca é escrita na configuração. Cada rota tem sua própria referência
(`apiKeyRef` e `openRouterApiKeyRef`), então as duas não podem compartilhar uma chave por acidente.

`@typesafe-ai/sdk` é a única dependência opcional; o plugin
carrega e roda offline sem nenhuma delas, e só precisa daquela correspondente à rota que você
escolher.

---

## Configuração

| Chave | Padrão | Significado |
|---|---|---|
| `provider` | `mock` | `mock` (offline, determinístico, sintético), `live` (TypeSafe) ou `openrouter` |
| `apiKeyRef` | `TYPESAFE_API_KEY` | Referência de credencial para a rota `live` |
| `openRouterApiKeyRef` | `OPENROUTER_API_KEY` | Referência de credencial para a rota `openrouter` |
| `baseURL` | `https://api.typesafe.ai` | Raiz da API para a rota `live`. Não-HTTPS é recusado, exceto em loopback |
| `openRouterBaseURL` | `https://openrouter.ai/api` | Raiz da API para a rota `openrouter`. A mesma regra |
| `model` | `jev-latest` | Enviado em toda requisição. Na rota OpenRouter, o padrão puro basta; `typesafe/` exige um id versionado como `typesafe/jev-1.13`, e `typesafe/jev-latest` não é aceito |
| `logLevel` | `warn` | `silent` \| `warn` \| `info` \| `debug` |
| `minConfidence` | `0.7` | Abaixo disto, não se age com base numa resposta |
| `minProbability` | `0.6` | Abaixo disto, não se age com base numa decisão |
| `maxStateChars` | por recurso | Substitui o teto de `state` para todo recurso. `0` significa "manter o teto declarado" |
| `gates.safety` | `false` | Julga chamadas de ferramentas antes do despacho |
| `gates.context` | `false` | Retém resultados de ferramenta grandes e pouco informativos |

Os tetos declarados de `state` são 16.000 caracteres para as três ferramentas e 8.000 / 6.000 para os gates
de segurança e de contexto. `maxStateChars` substitui todos eles, e o relatório de inicialização mostra o valor
efetivo em vez do declarado, então o que ele imprime é o que é aplicado.

Os gates aceitam um booleano puro (`safety: false`) ou um objeto com `onUndecided`: `ask` (padrão),
`allow` ou `deny`.

Um valor desconhecido é recusado no carregamento com uma mensagem que nomeia a chave, em vez de ser
silenciosamente ignorado — um erro de digitação na configuração não deveria mudar a postura de privacidade em silêncio.

---

## Como usar

### De outro plugin, sem modelo no circuito

O serviço é a superfície principal. É esse o ponto de um modelo de decisão: uma decisão de roteamento ou
de gate não deveria custar uma ida e volta ao modelo.

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
código — veja `src/policy.ts` para um exemplo completo com um piso de confiança explícito, em que uma resposta
incerta produz `ask` em vez de `allow`.

### A partir do modelo

Três ferramentas, deliberadamente poucas e ortogonais:

- **`jev_ask`** — um lote de perguntas tipadas sobre um único estado.
- **`jev_rank`** — pontua e ordena candidatos segundo um critério, uma pergunta por candidato em uma
  única ida e volta. As probabilidades são julgamentos independentes por candidato, não uma distribuição.
- **`jev_check`** — esta evidência sustenta esta afirmação? Devolve `supported`, `contradicted`,
  `conflicted`, `insufficient` ou `unknown`. A contradição tem precedência sobre o suporte, porque evidência que
  sustenta e refuta ao mesmo tempo é um conflito, não um sim fraco.

### Uma skill incluída

O plugin registra uma skill, `typesafe-ai-dsh`, que ensina a um agente quando um julgamento
do Jev é a ferramenta certa e quando é um erro de categoria. Ela é registrada
pelo registro de skills, em vez de ser entregue como um diretório para um provedor
escanear, então não depende de onde um perfil guarda suas skills e
desaparece de forma limpa quando o plugin é removido.

O corpo vive em `skills/typesafe-ai-dsh/SKILL.md` e é lido no carregamento, em vez
de embutido, então o arquivo que uma pessoa edita é o arquivo que é publicado. Um teste garante
que os dois não podem divergir.

O registro é declarado como uma dependência **opcional**: um perfil que não
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
- **A rota OpenRouter está verificada contra a API real.** `pnpm --filter jevcore run
  probe:live` e `pnpm --filter jevcore-mcp run smoke:live` responderam ambas contra modelos
  System One reais. Veja a seção de status do README raiz para os resultados registrados.
- **O plugin ativa num harness em execução e suas ferramentas funcionam.** A linha do plugin reporta `active`;
  `jev_ask` devolveu `urgent=true (0.8307)` e `team=billing (0.5027)` contra o mock em 1 ms, e
  `jev_check` devolveu `verdict="insufficient"` com suas três probabilidades. Todo resultado carregava
  `provider: "mock"` e uso zero de tokens, então o caminho padrão não fez nenhuma chamada de rede.
- **A skill incluída é registrada.** `typesafe-ai-dsh` aparece no catálogo de skills da sessão.
- O caminho padrão não faz nenhuma chamada de rede: afirmado espionando `globalThis.fetch` ao montar o
  plugin e responder pelo serviço, e de novo ao montar o runtime do MCP.
- Um gate desativado não registra **nenhum** listener de evento, e uma saída negada nunca chega ao provedor.
- `Config` satisfaz o protocolo Standard Schema que o Cordis exige antes de um plugin iniciar.
- Toda API do DSH usada aqui (`ctx.provide`, `ctx.effect`, `tools.register`, `defineTool`,
  `tools/pre-execute`, `tools/post-execute`, `credentials.resolve`) foi conferida contra o runtime
  instalado antes do uso, e os tipos de payload vêm dos arquivos de declaração instalados.

**Não verificado, ou sabidamente quebrado**
- **A rota TypeSafe nunca foi exercitada contra a API real.** Nenhuma credencial TypeSafe estava
  disponível, então `LiveProvider` é coberto contra um stub injetado e contra as definições de tipo
  do fornecedor — mais fraco que uma chamada real. Ambas as rotas usam as mesmas primitivas, então
  *espera-se* que uma chave TypeSafe funcione sem alterações; isso é uma expectativa, não uma observação.
- **A descrição de `jev_ask` carrega um travessão corrompido na build que está rodando agora.** Ela
  lê `branches on —?routing` onde caberia um travessão seguido de um espaço. Causa: uma ida e volta UTF-8
  no início do desenvolvimento substituiu o terceiro byte do travessão por `?`. Está corrigido no disco — quatro
  ocorrências, zero restantes, confirmado tanto no código-fonte quanto na saída da build — mas o processo em execução
  carregou seu módulo antes da correção e não pode relê-lo sem reiniciar. Apenas cosmético; não muda
  nenhum comportamento.
- O servidor MCP foi conduzido de ponta a ponta por um cliente MCP real via stdio
  (`pnpm --filter jevcore-mcp run smoke`): handshake, descoberta de ferramentas, três chamadas bem-sucedidas e um
  resultado de erro para um lote inválido. Ele não foi conduzido por nenhum outro host de terceiros.
- Comportamento dos gates em tráfego live. Os gates são testados contra respostas sintéticas e formatos
  reais de payload de hook, mas nenhuma chamada de ferramenta real passou por um gate de ponta a ponta.
- O gate de contexto não consegue recuperar contexto já gasto. Ele retém um resultado para que não chegue
  ao agente; não poda nada retroativamente, e o README de qualquer plugin que afirme o contrário
  deve ser lido com ceticismo.
- Nenhum teste de longa duração ou adversarial. O mascaramento é baseado em padrões e vai deixar passar um
  formato de segredo não reconhecido.

---

## Notas de projeto

Três decisões que são fáceis de errar e caras de errar:

**Um juiz que não consegue responder não pode significar "allow".** Se o Jev está inacessível, ou responde abaixo do
piso de confiança, os gates resolvem por `onUndecided`, cujo padrão é `ask`. A única forma de
obter comportamento fail-open é configurá-lo. O gate de contexto é a exceção deliberada: ele falha
aberto incondicionalmente, porque perder um resultado real de ferramenta para um veredito fantasma de "irrelevante" é pior
do que manter um resultado pouco informativo.

**Nada que o modelo possa dizer muda o gate.** Nenhuma ferramenta expõe configuração de gate, limites ou
escopo. Um guarda que o processo guardado pode reconfigurar não é um guarda.

**Uma probabilidade não é uma permissão.** O Jev devolve números; `src/policy.ts` os transforma em
`allow`/`ask`/`deny` segundo limites configurados localmente. Uma resposta que nomeia um valor fora dos
critérios declarados é `invalid` e nega — a garantia de um modelo de decisão tipado é que ele não pode
devolver um valor não declarado, então uma violação significa que algo a montante está errado.

## Desenvolvimento

```sh
pnpm install
pnpm run check      # typecheck + tests + build
pnpm test           # tests only
```

Nenhum teste exige credencial nem conexão de rede, e a CI impõe isso rodando com
`TYPESAFE_API_KEY` limpa.

## Licença

[Apache License 2.0](LICENSE) © 2026 jevcore contributors

TypeSafe, Jev e System One são marcas comerciais da TypeSafe AI. Este projeto é uma
integração independente e não é afiliado à TypeSafe AI nem endossado por ela.
