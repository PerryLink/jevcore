# jevcore-mcp

TypeSafe [Jev](https://typesafe.ai) sobre o Model Context Protocol.

O Jev não é um modelo de chat. Ele responde a perguntas tipadas — `noul` (sim/não), `choice`,
`score` — e devolve probabilidades calibradas. Ele não escreve prosa, e
pedir isso a ele é um erro de categoria. Este servidor expõe exatamente essa superfície.

**Offline por padrão. Saída de dados declarada. Nada ativado por padrão.**

## Instalação

```sh
npx -y jevcore-mcp
```

Registre-o como um servidor MCP stdio no seu host. Para o DeepSeek Harness, isso é um
bundle apenas de configuração cujo patch insere o cliente MCP do harness:

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

## Configuração

| Variável | Efeito |
|---|---|
| `TYPESAFE_API_KEY` | Seleciona a rota TypeSafe quando presente |
| `OPENROUTER_API_KEY` | Seleciona a rota OpenRouter quando presente e não há chave TypeSafe |
| `JEV_PROVIDER` | `mock`, `live` ou `openrouter` — sobrepõe a heurística acima |
| `TYPESAFE_MODEL` / `OPENROUTER_MODEL` | Id do modelo para a rota selecionada |
| `TYPESAFE_BASE_URL` / `OPENROUTER_BASE_URL` | Raiz da API para a rota selecionada |

Duas rotas alcançam os mesmos modelos. A TypeSafe os serve diretamente; a OpenRouter serve
os modelos System One no mesmo caminho `POST /v1/systemone` que a TypeSafe, um nível
abaixo da sua própria raiz de API, que é a forma de entrar quando uma chave TypeSafe é
inviável. Elas diferem em quais servidores veem o seu estado, então o relatório de inicialização
nomeia o endpoint em vez de deixá-lo implícito no nome do provedor. Na
rota OpenRouter, o id do modelo precisa ser um de System One: o `jev-latest` puro é o padrão,
`typesafe/` é aceito em um id versionado como `typesafe/jev-1.13`, e `typesafe/jev-latest`
não é aceito. Qualquer outra coisa responde
com prosa que este servidor não consegue interpretar como decisão.

Diferente de um adaptador por chamada, este servidor resolve sua credencial **uma única vez na
inicialização** — é um processo de longa duração e sua credencial não muda
no meio da sessão. Portanto, `JEV_PROVIDER=live` sem chave é um erro de inicialização com uma
mensagem legível, e não uma falha na primeira chamada de ferramenta.

## As ferramentas

| Ferramenta | Propósito |
|---|---|
| `jev_ask` | Uma ou mais perguntas tipadas sobre um estado; agrupe-as em uma única chamada |
| `jev_rank` | Pontua e ordena candidatos segundo um critério, uma pergunta por candidato |
| `jev_check` | Esta evidência sustenta esta afirmação? `supported`, `contradicted`, `conflicted`, `insufficient`, `undecided` ou `unknown` |

Três ferramentas, deliberadamente poucas e ortogonais. Dois servidores MCP de Jev já existentes
entregam dez ferramentas cada um; este existe para o caso em que um host quer as três
primitivas e nada mais, construído sobre o mesmo core do plugin do DeepSeek Harness
para que os dois não possam divergir.

`jev_rank` aceita uma lista limitada, não o melhor de qualquer lista. Cada candidato acrescenta uma
pergunta a um orçamento fixo de 4.000 caracteres sobre o mapa de perguntas, e uma lista que não cabe é
recusada com erro, não truncada nos primeiros N que cabem: com o critério padrão cabem 20 candidatos,
com um critério de 100 caracteres 17, e com um de 500 caracteres 6. Mantenha as listas de candidatos
curtas, o critério conciso, e divida uma lista longa em lotes.

Todo resultado carrega probabilidades, não decisões. Aplique seu próprio limite
de confiança antes de agir, e trate uma resposta de baixa confiança como desconhecida em vez de
escolher por ela.

## O relatório de saída

O servidor imprime seu contrato em **stderr** na inicialização:

```
[jevcore] provider=mock  endpoint=none  egress=OFF  (no network calls will be made; every answer is synthetic)
[jevcore]   armed  tool:jev_ask  (runs against the offline mock; would transmit if the provider became "live" or "openrouter")
```

Stderr, nunca stdout: num transporte stdio, o stdout é o canal do protocolo e uma
linha perdida ali corromperia o fluxo.

O mascaramento roda antes de qualquer envio. É uma mitigação, não uma garantia — um
segredo não reconhecido em texto livre vai passar. Se essa possibilidade é
inaceitável, não defina uma chave.

## Status

Ferramentas, seleção de provedor e imposição da saída de dados são cobertos por testes, e o
transporte foi conduzido de ponta a ponta por um cliente MCP real via stdio:

```sh
pnpm --filter jevcore-mcp run smoke        # offline, mock provider, no credential
pnpm --filter jevcore-mcp run smoke:live   # real answers, needs OPENROUTER_API_KEY
```

A execução offline exercita o handshake, a descoberta de ferramentas, três chamadas bem-sucedidas
e o caminho de erro para um lote inválido.

A execução live conduz a mesma superfície contra modelos System One reais através da
OpenRouter: as três ferramentas responderam, um lote de três primitivas devolveu um `score`
de `1.08` numa rubrica de três níveis com sua legenda intacta, `jev_rank` ordenou um
runbook de credenciais acima de um guia de cobrança, `jev_check` devolveu `contradicted`, e
o relatório de saída da inicialização nomeou o endpoint da OpenRouter no stderr sem
perturbar o canal do protocolo.

**A rota TypeSafe está exercitada, mas apenas de forma leve.** `packages/core/scripts/probe-live.mjs`
(`pnpm --filter jevcore run probe:typesafe`) pergunta à API real três coisas: dez pares
claim/evidence cujo veredicto é conhecido de antemão, uma pergunta repetida seis vezes e um noul com
um limite `criteria: {true, false}`. Duas execuções separadas concordaram — a evidência que sustenta
obteve 0.95, a que contradiz 0.10, a que se cala sobre a afirmação 0.03, e a pergunta repetida
variou 0.01 ou menos. O limite foi aceito. O que continua sem teste é tudo o que envolve a
requisição em vez da requisição em si: o comportamento de cota, limite de requisições e
entitlement em uma conta real.

## Licença

[Apache License 2.0](LICENSE) © 2026 jevcore contributors. TypeSafe, Jev e System One
são marcas comerciais da TypeSafe AI; esta é uma integração independente e
não é afiliada nem endossada por ela.
