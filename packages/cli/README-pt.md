# jevcore-cli

A linha de comando `jev`: decisões do TypeSafe [Jev](https://typesafe.ai) a partir
de um shell, de um script ou de um job de CI.

Este pacote é um quarto ponto de entrada sobre o mesmo núcleo de decisão que a
biblioteca, o servidor MCP e o plugin do DeepSeek Harness. Nada aqui reimplementa um
julgamento:

- `jev ask` chama `JevService.ask`, então o contrato de egresso e o caminho de
  redação se aplicam exatamente como em uma sessão;
- `jev check` chama `resolveCheck`, o mesmo resolvedor que a ferramenta MCP usa;
- `jev gate` chama `createSafetyGate`, a mesma função que o harness registra;
- `jev egress` chama `EgressContract.reportLines`, a autodescrição do contrato.

Por isso uma decisão tomada no prompt significa o mesmo que dentro de um agente.

## Instalação

```sh
npm install -g jevcore-cli
```

O provedor mock offline é o padrão e não precisa de mais nada. Uma rota ao vivo precisa
de `@typesafe-ai/sdk`, que é uma dependência opcional do núcleo.

## Os comandos

| Comando | O que responde |
|---|---|
| `jev ask` | Um lote de perguntas tipadas — noul, choice, score — sobre um estado |
| `jev check` | Um de seis veredictos para uma afirmação contra evidências, mais as probabilidades |
| `jev rank` | Candidatos ordenados por relevância, com uma probabilidade cada |
| `jev gate` | O que a barreira de segurança decidiria sobre uma chamada de ferramenta, sem executá-la |
| `jev egress` | O que esta ferramenta pode enviar, e o limite de cada campo |
| `jev models` | Qual modelo e qual endpoint cada rota usaria |

Todos os comandos aceitam `--json` para saída legível por máquina e, por padrão,
imprimem uma forma legível por pessoas. Os nomes de campo sob `data` são estáveis, da
mesma forma que os códigos de saída.

## Fazer uma pergunta

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

`--feature` seleciona a característica de egresso sob a qual a chamada viaja. Precisa
ser uma das características declaradas, e um nome não declarado é um erro duro que as
lista — porque é o contrato, e não a linha de comando, que decide o que pode sair da
máquina.

## Verificar uma afirmação

```sh
jev check --claim "the build is reproducible" --evidence build.log
```

```
claim: the build is reproducible
evidence: 4821 chars — "commit 3f9a1c2 ..."
verdict: supported  (supports=0.95 contradicts=0.05 sufficient=0.90)
```

O veredicto é uma de seis palavras, e não são duas palavras com quatro sinônimos:

| Veredicto | Significado |
|---|---|
| `supported` | A evidência sustenta a afirmação e foi julgada suficiente |
| `contradicted` | A evidência contradiz a afirmação |
| `conflicted` | A evidência sustenta a afirmação e a contradiz |
| `insufficient` | A evidência não estabelece a afirmação |
| `undecided` | A evidência resolve a questão mas não aponta para nenhum lado |
| `unknown` | Nenhuma medição voltou |

## Códigos de saída

| Código | Significado |
|---|---|
| `0` | `check` sustentou a afirmação; `gate` permitiu a chamada; o comando imprimiu |
| `1` | `check` contradisse a afirmação; `gate` negou a chamada; erro de entrada |
| `2` | `gate` perguntaria a um humano antes de prosseguir |
| `3` | `check` retornou `conflicted`, `insufficient`, `undecided` ou `unknown` |
| `64` | A própria linha de comando está errada |

O código de saída `3` existe porque os quatro últimos veredictos são conclusões sobre a
*evidência*, não sobre a afirmação. Um script que os lesse como "não sustentado" estaria
relatando uma refutação que ninguém mediu, e em CI essa é a diferença entre "esta
afirmação é falsa" e "este repositório não consegue dizer".

## A barreira, em simulação

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

Este é o comando que vale a pena conhecer. A barreira fica desligada por padrão em uma
sessão e seu trabalho é ser invisível até que algo seja perigoso, então não havia como
perguntar o que ela faria sem preparar uma chamada perigosa. Aqui o nome da ferramenta e
seus argumentos são **dados**: nenhuma ferramenta é invocada, nenhum arquivo é tocado,
nenhum processo é iniciado.

A decisão vem de `createSafetyGate`, então é a mesma decisão que uma sessão receberia. Os
perigos que ela julga estão declarados no núcleo e são impressos por
`jev egress --feature gate:safety`: destruição irreversível, escalada de privilégios,
exposição de credenciais, efeitos colaterais externos e reescrita de histórico, além de
uma pontuação de severidade.

## O que pode sair da máquina

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

`EgressContract` é o único lugar que decide o que pode sair da máquina. Cada
característica declara os campos que enviaria e o limite de cada um, o contrato se
descreve, e este comando imprime essa descrição conforme ela se aplica à invocação que
você está prestes a executar.

Ambas as rotas ficam **desligadas por padrão**. `--provider live` e
`--provider openrouter` transmitem; qualquer outra coisa usa o mock offline, que
responde a partir de um hash da entrada, não abre socket algum e rotula cada resultado
como sintético tanto em stderr quanto na carga útil.

A redação se aplica a tudo o que sai, e seu limite é declarado em vez de escondido: ela
remove valores sob nomes de campo reconhecidos e strings que correspondem a formas
conhecidas de segredos, e não consegue reconhecer um segredo desconhecido escrito em
texto livre.

## Configuração

| Variável | Efeito |
|---|---|
| `TYPESAFE_API_KEY` | Credencial para o provedor `live` |
| `OPENROUTER_API_KEY` | Credencial para o provedor `openrouter` |
| `JEV_PROVIDER` | Padrão para `--provider` |
| `TYPESAFE_BASE_URL` | Padrão para `--endpoint` na rota `live` |
| `OPENROUTER_BASE_URL` | Padrão para `--endpoint` na rota `openrouter` |

Uma credencial nunca é impressa, registrada ou ecoada. A ferramenta informa de qual
fonte uma chave veio — o ambiente, ou um serviço de credenciais — e nada mais.

## Evitar surpresas

| Opção | Efeito |
|---|---|
| `--mock` | Forçar o provedor mock offline |
| `--json` | Saída legível por máquina em stdout; toda nota vai para stderr |
| `--model` | Modelo a ser chamado |
| `--endpoint` | Raiz da API para um provedor que transmite |

## Desenvolvimento

```sh
pnpm install
pnpm --filter jevcore-cli run test
pnpm --filter jevcore-cli run typecheck
```

Nenhum teste deste pacote precisa de credencial ou socket. A rota ao vivo é exercitada
por meio de um módulo SDK substituto indicado por uma variável de ambiente, então a
chave real de quem desenvolve não consegue transformar um teste em chamada de rede.

## Licença

[Apache License 2.0](LICENSE) © 2026 jevcore contributors. TypeSafe, Jev e System One
são marcas registradas da TypeSafe AI; esta é uma integração independente e não é
afiliada a eles nem endossada por eles.
