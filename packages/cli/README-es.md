# jevcore-cli

La línea de comandos `jev`: decisiones de TypeSafe [Jev](https://typesafe.ai)
desde un shell, un script o un trabajo de CI.

Este paquete es un cuarto punto de entrada sobre el mismo núcleo de decisión que la
biblioteca, el servidor MCP y el plugin de DeepSeek Harness. Aquí no se vuelve a
implementar ningún juicio:

- `jev ask` llama a `JevService.ask`, así que el contrato de egreso y la ruta de
  redacción se aplican igual que en una sesión;
- `jev check` llama a `resolveCheck`, el mismo resolutor que usa la herramienta MCP;
- `jev gate` llama a `createSafetyGate`, la misma función que registra el harness;
- `jev egress` llama a `EgressContract.reportLines`, la autodescripción del contrato.

Por eso una decisión tomada en el prompt significa lo mismo que dentro de un agente.

## Instalación

```sh
npm install -g jevcore-cli
```

El proveedor mock sin conexión es el predeterminado y no necesita nada más. Una ruta
en vivo necesita `@typesafe-ai/sdk`, que es una dependencia opcional del núcleo.

## Los comandos

| Comando | Qué responde |
|---|---|
| `jev ask` | Un lote de preguntas tipadas — noul, choice, score — sobre un estado |
| `jev check` | Uno de seis veredictos para una afirmación frente a evidencia, más las probabilidades |
| `jev rank` | Candidatos ordenados por relevancia, con una probabilidad cada uno |
| `jev gate` | Qué decidiría la barrera de seguridad sobre una llamada a herramienta, sin ejecutarla |
| `jev egress` | Qué puede enviar esta herramienta, y el límite de cada campo |
| `jev models` | Qué modelo y qué endpoint usaría cada ruta |

Todos los comandos admiten `--json` para salida legible por máquina y, por defecto,
imprimen una forma legible por personas. Los nombres de campo bajo `data` son
estables, igual que los códigos de salida.

## Hacer una pregunta

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

`--feature` selecciona la característica de egreso bajo la que viaja la llamada.
Debe ser una de las características declaradas, y un nombre no declarado es un error
duro que las enumera — porque es el contrato, y no la línea de comandos, lo que
decide qué puede salir de la máquina.

## Verificar una afirmación

```sh
jev check --claim "the build is reproducible" --evidence build.log
```

```
claim: the build is reproducible
evidence: 4821 chars — "commit 3f9a1c2 ..."
verdict: supported  (supports=0.95 contradicts=0.05 sufficient=0.90)
```

El veredicto es una de seis palabras, y no son dos palabras con cuatro sinónimos:

| Veredicto | Significado |
|---|---|
| `supported` | La evidencia respalda la afirmación y se juzgó suficiente |
| `contradicted` | La evidencia contradice la afirmación |
| `conflicted` | La evidencia respalda la afirmación y la contradice |
| `insufficient` | La evidencia no establece la afirmación |
| `undecided` | La evidencia zanja la cuestión pero no apunta a ningún lado |
| `unknown` | No volvió ninguna medición |

## Códigos de salida

| Código | Significado |
|---|---|
| `0` | `check` respaldó la afirmación; `gate` permitió la llamada; el comando imprimió |
| `1` | `check` contradijo la afirmación; `gate` denegó la llamada; error de entrada |
| `2` | `gate` preguntaría a una persona antes de continuar |
| `3` | `check` devolvió `conflicted`, `insufficient`, `undecided` o `unknown` |
| `64` | La propia línea de comandos está mal |

El código de salida `3` existe porque los últimos cuatro veredictos son hallazgos
sobre la *evidencia*, no sobre la afirmación. Un script que los leyera como "no
respaldado" estaría informando de una refutación que nadie midió, y en CI esa es la
diferencia entre "esta afirmación es falsa" y "este repositorio no puede saberlo".

## La barrera, en seco

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

Este es el comando que vale la pena conocer. La barrera está desactivada por defecto
en una sesión y su trabajo es ser invisible hasta que algo es peligroso, así que no
había forma de preguntar qué haría sin preparar una llamada peligrosa. Aquí el nombre
de la herramienta y sus argumentos son **datos**: no se invoca ninguna herramienta, no
se toca ningún archivo, no se inicia ningún proceso.

La decisión viene de `createSafetyGate`, así que es la misma decisión que obtendría
una sesión. Los peligros que juzga están declarados en el núcleo y los imprime
`jev egress --feature gate:safety`: destrucción irreversible, escalada de privilegios,
exposición de credenciales, efectos secundarios externos y reescritura de historial,
más una puntuación de severidad.

## Qué puede salir de la máquina

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

`EgressContract` es el único lugar que decide qué puede salir de la máquina. Cada
característica declara los campos que enviaría y el límite de cada uno, el contrato se
describe a sí mismo, y este comando imprime esa descripción tal como se aplica a la
invocación que estás a punto de ejecutar.

Ambas rutas están **desactivadas por defecto**. `--provider live` y
`--provider openrouter` transmiten; cualquier otra cosa usa el mock sin conexión, que
responde a partir de un hash de la entrada, no abre ningún socket y etiqueta cada
resultado como sintético tanto en stderr como en la carga útil.

La redacción se aplica a todo lo que sale, y su límite se declara en lugar de
ocultarse: elimina valores bajo nombres de campo reconocidos y cadenas que coinciden
con formas conocidas de secretos, y no puede reconocer un secreto desconocido escrito
en texto libre.

## Configuración

| Variable | Efecto |
|---|---|
| `TYPESAFE_API_KEY` | Credencial para el proveedor `live` |
| `OPENROUTER_API_KEY` | Credencial para el proveedor `openrouter` |
| `JEV_PROVIDER` | Valor predeterminado de `--provider` |
| `TYPESAFE_BASE_URL` | Valor predeterminado de `--endpoint` en la ruta `live` |
| `OPENROUTER_BASE_URL` | Valor predeterminado de `--endpoint` en la ruta `openrouter` |

Una credencial nunca se imprime, se registra ni se repite. La herramienta informa de
qué fuente provino una clave — el entorno, o un servicio de credenciales — y nada más.

## Evitar sorpresas

| Opción | Efecto |
|---|---|
| `--mock` | Forzar el proveedor mock sin conexión |
| `--json` | Salida legible por máquina en stdout; todas las notas van a stderr |
| `--model` | Modelo que se va a llamar |
| `--endpoint` | Raíz de la API para un proveedor que transmite |

## Desarrollo

```sh
pnpm install
pnpm --filter jevcore-cli run test
pnpm --filter jevcore-cli run typecheck
```

Ninguna prueba de este paquete necesita una credencial ni un socket. La ruta en vivo se
ejercita mediante un módulo SDK de reemplazo indicado por una variable de entorno, así
que la clave real de quien desarrolla no puede convertir una prueba en una llamada de red.

## Licencia

[Apache License 2.0](LICENSE) © 2026 jevcore contributors. TypeSafe, Jev y System One
son marcas registradas de TypeSafe AI; esta es una integración independiente y no está
afiliada a ellos ni cuenta con su respaldo.
