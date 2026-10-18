# jevcore

[![dshfind](https://dshfind.com/api/badge/PerryLink/jevcore?metric=downloads)](https://dshfind.com/plugins/PerryLink/jevcore?ref=badge)
[![DSH Market](https://raw.githubusercontent.com/2BingLing/dsh-market/master/assets/readme/badge-listed-en.svg)](https://dsh.market/)
[![OpenSSF Scorecard](https://api.securityscorecards.dev/projects/github.com/PerryLink/jevcore/badge)](https://api.securityscorecards.dev/projects/github.com/PerryLink/jevcore)
[![jevcore MCP server](https://glama.ai/mcp/servers/PerryLink/jevcore/badges/score.svg)](https://glama.ai/mcp/servers/PerryLink/jevcore)

TypeSafe [Jev](https://typesafe.ai) para [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
y cualquier otro host MCP.

Jev no es un modelo de chat. Responde preguntas tipadas — `noul` (sí/no), `choice`, `score` — y devuelve
probabilidades calibradas. No escribe prosa, y pedírselo es un error de categoría. Este proyecto
le da a un agente exactamente esa superficie, y nada más.

**Sin conexión por defecto. Salida divulgada. Nada activado por defecto.**

---

**📖 Base de conocimiento del ecosistema** — datos medidos, no marketing: [guía de desarrollo · datos de selección · criterios de mantenimiento](https://perrylink.github.io/dsh-plugin-guide/).

<!-- star-cta -->
## ⭐ Si te ha servido

Este plugin forma parte de una [familia de más de 40 plugins](https://github.com/PerryLink) para DeepSeek Harness, todos Apache-2.0. Si lo usas, **una estrella** no desbloquea nada, pero ayuda a que la siguiente persona lo encuentre.

*English:* part of a 40+ plugin family for DeepSeek Harness. If it is useful, **a star helps the next person find it** — nothing is gated behind it.

## Tres paquetes, una capa de decisión

| Paquete | Qué es | Úsalo cuando |
|---|---|---|
| [`jevcore`](packages/core) | Las decisiones. No importa nada de DeepSeek Harness ni de Cordis. | Quieres Jev en un script simple, en un servicio o en tu propio harness |
| [`jevcore-dsh`](packages/dsh) | El plugin de DSH: un servicio, tres herramientas, dos barreras opt-in | Estás ejecutando DeepSeek Harness |
| [`jevcore-mcp`](packages/mcp) | Las mismas tres herramientas sobre MCP, con un binario stdio | Tu host habla MCP pero no es DSH |

Los adaptadores son delgados a propósito. `packages/dsh` son cuatro archivos: declara esquemas de
herramientas y traduce cargas útiles de hooks. Todo lo que tiene forma de decisión — las primitivas, los
proveedores, el contrato de salida, la política, las barreras — vive en el núcleo, así que un nuevo
adaptador no puede desviarse de las garantías que ofrecen los demás.
Un requisito de ejecución difiere entre los tres: `jevcore-dsh` sigue al harness y
necesita Node `^22.19.0 || >=24.0.0`, mientras que `jevcore` y `jevcore-mcp` necesitan `>=20`.

---

## Por qué existe esto

Entre el 2026-09-17 y el 09-20 aparecieron diecinueve plugins que conectan Jev con DSH. Auditar su
código fuente reveló un patrón consistente: el módulo etiquetado como *guard*, *gate* o *warden* era
también el módulo que enviaba prompts, argumentos de herramientas y contenidos de archivos a un
tercero, y por lo general el README no lo decía. Varios estaban habilitados por defecto. Una barrera
podía ser reconfigurada por el modelo al que estaba vigilando.

Este proyecto es la misma idea con esos modos de fallo diseñados fuera:

| Propiedad | Cómo se garantiza aquí |
|---|---|
| Ninguna llamada de red a menos que la pidas | El proveedor por defecto es un mock sin conexión; la ruta en vivo necesita tanto `provider: live` como una credencial resuelta |
| Toda transmisión se nombra antes de ocurrir | Una línea de registro de arranque por característica: `off` o `SENDS <feature> { fields }` |
| Las barreras no registran nada cuando están deshabilitadas | Verificado por pruebas, no por política — una barrera deshabilitada no añade ningún escucha de eventos en absoluto |
| El modelo no puede ampliar sus propias restricciones | Ninguna herramienta expone la configuración de las barreras |
| Un juez que no puede responder nunca significa "permitir" | Lo indeciso se resuelve mediante configuración explícita, que por defecto es `ask` |

---

## El contrato de salida

Esta es la parte que vale la pena leer antes de instalar.

La transmisión se decide por característica, y toda característica está desactivada por defecto. El
plugin imprime su propio contrato al cargarse:

```
[jevcore] provider=mock  endpoint=none  egress=OFF  (no network calls will be made; every answer is synthetic)
[jevcore] ready - provider=mock - gates: safety=off context=off
```

Con `provider: live` y todas las características habilitadas, el mismo informe se vuelve explícito
sobre qué sale:

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

| Característica | ¿Desactivada por defecto? | Qué envía |
|---|---|---|
| `tool:jev_ask` | se ejecuta cuando el modelo la llama | los argumentos que pasó el modelo, después de la redacción |
| `tool:jev_rank` | se ejecuta cuando el modelo la llama | la consulta más cada candidato |
| `tool:jev_check` | se ejecuta cuando el modelo la llama | la afirmación y su evidencia |
| `gate:safety` | **sí — opt-in explícito** | el nombre de la herramienta, sus argumentos, la raíz del espacio de trabajo |
| `gate:context` | **sí — opt-in explícito** | un resultado de herramienta grande que el agente acaba de recibir |

Las herramientas transmiten solo cuando el modelo elige llamarlas, lo cual es visible en la
transcripción. Las barreras se ejecutarían en cada llamada de herramienta coincidente, lo cual no es
visible, así que son opt-in.

### La redacción, y su límite honesto

Antes de que se envíe nada, `src/redact.ts` ejecuta dos pasadas: los valores bajo nombres de campo
sensibles (`password`, `token`, `apiKey`, `authorization`, …) se reemplazan por completo, y las cadenas
con forma de secreto que sobreviven hasta el texto libre se comparan con patrones (`Bearer …`, `sk-…`,
`ts_live_…`, formas de claves de AWS/GitHub/Google, JWT, cabeceras de clave privada, credenciales en
cadenas de conexión).

Esto es una mitigación, no un permiso. Un secreto que está bajo un nombre de clave no reconocido *y*
que no coincide con una forma conocida pasará. Si esa posibilidad es inaceptable para tu carga de
trabajo, no habilites el proveedor en vivo.

---

## Instalación

### Como plugin de DeepSeek Harness

```sh
dsh plugin --profile <profile> add jevcore-dsh
```

O desde un checkout:

```sh
dsh plugin --profile <profile> add /absolute/path/to/jevcore/packages/dsh
```

`packages/dsh` importa `jevcore` por nombre, así que un checkout también necesita el núcleo
resoluble desde el perfil (`add /absolute/path/to/jevcore/packages/core`).

Luego confirma que la fila se activó — la lista de plugins debería mostrar `jev` como `active`, no
como `failed` — y revisa el informe de arranque en el registro.

### Como servidor MCP

Para un host que habla MCP, las mismas tres herramientas están disponibles sobre stdio:

```sh
npx -y jevcore-mcp
```

Para conectarlo específicamente a DeepSeek Harness, instala un bundle de solo configuración cuyo
parche inserte el propio cliente MCP del harness:

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

El mapa env no es opcional: DSH elimina todo nombre con forma de credencial
(cualquiera que contenga KEY, PASSWORD, SECRET o TOKEN, sin distinguir mayúsculas)
del entorno que entrega a un servidor lanzado, y solo después fusiona este mapa.
Una clave exportada en tu shell nunca llega, y el servidor se queda en el mock
offline sin informar de ningún error.

El proveedor se elige desde el entorno:

| Variable | Efecto |
|---|---|
| `TYPESAFE_API_KEY` | Selecciona la ruta TypeSafe cuando está presente |
| `OPENROUTER_API_KEY` | Selecciona la ruta OpenRouter cuando está presente y no lo está ninguna clave de TypeSafe |
| `JEV_PROVIDER` | `mock`, `live` u `openrouter` — anula la heurística anterior |
| `TYPESAFE_MODEL` / `OPENROUTER_MODEL` | Id de modelo para la ruta seleccionada |
| `TYPESAFE_BASE_URL` / `OPENROUTER_BASE_URL` | Raíz de la API para la ruta seleccionada |

Sin ninguna de las dos claves se queda en el mock sin conexión. A diferencia del plugin, el servidor
MCP resuelve su credencial una sola vez al arrancar, así que una clave ausente con
`JEV_PROVIDER=live` es un error de arranque y no una sorpresa en cada llamada.

Su informe de salida va a **stderr**, nunca a stdout — en un transporte stdio stdout es el canal del
protocolo, y una línea extraviada ahí corrompería el flujo.

### Pasar a modo en vivo

Hay dos rutas hacia Jev. Ambas llaman a los mismos modelos y ambas devuelven las mismas respuestas
tipadas; difieren en quién posee tu credencial y en cuyos servidores ven tu estado.

**TypeSafe directamente** — usa esto si tienes una clave de
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

**A través de OpenRouter** — usa esto si una clave de TypeSafe no es práctica y ya tienes una clave
de [OpenRouter](https://openrouter.ai). OpenRouter sirve los modelos System One en la misma ruta
`POST /v1/systemone` que usa TypeSafe, un nivel por debajo de su propia raíz de API, así que esta es
la ruta documentada hacia Jev y no una aproximación a ella:

```yml
- insert:
    - id: jev
      name: 'jevcore-dsh'
      config:
        provider: openrouter
        openRouterApiKeyRef: OPENROUTER_API_KEY
        model: jev-latest              # a bare `jev-*` id, or `typesafe/jev-1.13`
```

Se llega a la ruta apuntando el SDK oficial `@typesafe-ai/sdk` a
`https://openrouter.ai/api` con tu clave de OpenRouter — la propia integración documentada de
OpenRouter, así que no hay un segundo cliente que mantener sincronizado.

Dos cosas que conviene saber sobre la ruta de OpenRouter:

- **Tu estado va a OpenRouter, no a TypeSafe.** Un tercero distinto
  con retención y registro distintos. El informe de arranque nombra el endpoint por
  exactamente esta razón — léelo en lugar de inferir el destino a partir del
  nombre del proveedor.
- **Devuelve un costo**, cosa que la propia ruta de TypeSafe no hace, así que `usage.costUsd`
  se completa aquí y está ausente allí.

El id de modelo debe ser uno de System One. El `jev-latest` sin prefijo es el valor
por defecto; `typesafe/` se acepta en un id con versión como `typesafe/jev-1.13`,
pero no en la etiqueta móvil — la ruta no acepta `typesafe/jev-latest`. Cualquier
otro id se enrutaría a un modelo de chat, que responde con prosa que este plugin no puede interpretar
como una decisión, así que se rechaza antes de la llamada en lugar de malinterpretarse después de
ella.

En cualquier caso, la credencial se resuelve primero a través del servicio de credenciales de DSH y
después mediante la variable de entorno de ese nombre. Se lee en cada llamada, así que una clave
añadida mientras el proceso está en ejecución se recoge. Nunca se registra en el log, nunca se
devuelve desde una herramienta y nunca se escribe en la configuración. Cada ruta tiene su propia
referencia (`apiKeyRef` y `openRouterApiKeyRef`) para que las dos no puedan compartir una clave por
accidente.

`@typesafe-ai/sdk` es la única dependencia opcional; el plugin
se carga y funciona sin conexión sin ninguna de las dos, y solo necesita la que corresponde a la ruta
que elijas.

---

## Configuración

| Clave | Por defecto | Significado |
|---|---|---|
| `provider` | `mock` | `mock` (sin conexión, determinista, sintético), `live` (TypeSafe) u `openrouter` |
| `apiKeyRef` | `TYPESAFE_API_KEY` | Referencia de credencial para la ruta `live` |
| `openRouterApiKeyRef` | `OPENROUTER_API_KEY` | Referencia de credencial para la ruta `openrouter` |
| `baseURL` | `https://api.typesafe.ai` | Raíz de la API para la ruta `live`. Se rechaza lo que no sea HTTPS excepto en loopback |
| `openRouterBaseURL` | `https://openrouter.ai/api` | Raíz de la API para la ruta `openrouter`. La misma regla |
| `model` | `jev-latest` | Se envía con cada solicitud. En la ruta OpenRouter basta el valor por defecto sin prefijo; `typesafe/` requiere un id con versión como `typesafe/jev-1.13`, y `typesafe/jev-latest` no se acepta |
| `logLevel` | `warn` | `silent` \| `warn` \| `info` \| `debug` |
| `minConfidence` | `0.7` | Por debajo de esto, no se actúa sobre una respuesta |
| `minProbability` | `0.6` | Por debajo de esto, no se actúa sobre una decisión |
| `maxStateChars` | por característica | Reemplaza el límite de `state` para cada característica. `0` significa "mantener el límite declarado" |
| `gates.safety` | `false` | Juzga las llamadas de herramientas antes de despacharlas |
| `gates.context` | `false` | Retiene resultados de herramientas grandes y poco informativos |

Los límites declarados de `state` son 16,000 caracteres para las tres herramientas y 8,000 / 6,000
para las barreras de seguridad y de contexto. `maxStateChars` los reemplaza todos, y el informe de
arranque muestra el valor efectivo en lugar del declarado, así que lo que imprime es lo que se aplica.

Las barreras aceptan un booleano simple (`safety: false`) o un objeto con `onUndecided`: `ask` (por
defecto), `allow` o `deny`.

`ask` es una pregunta, así que necesita algo a lo que preguntar. Un despliegue que no compone ningún
servicio de aprobación no puede escalar a una persona, y DeepSeek Harness entonces rechaza la llamada
en lugar de ejecutarla: se rechaza toda herramienta con la que la barrera de seguridad coincide, lo
que un operador vive como que el plugin le ha roto todos los comandos de shell.
[docs/approval.md](docs/approval.md) tiene el mecanismo, y el README del plugin cubre la vista de
despliegue.

Un valor desconocido se rechaza al cargar con un mensaje que nombra la clave, en lugar de ignorarse en
silencio — una errata de configuración no debería cambiar discretamente la postura de privacidad.

---

## Uso

### Desde otro plugin, sin ningún modelo en el circuito

El servicio es la superficie principal. Este es el punto de un modelo de decisión: una decisión de
enrutamiento o de barrera no debería costar una ida y vuelta a un modelo.

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

`result.answers` lleva probabilidades y confianza. Decidir qué hacer con ellas es tarea de tu código —
consulta `src/policy.ts` para ver un ejemplo trabajado con un umbral mínimo de confianza explícito,
donde una respuesta poco segura produce `ask` en lugar de `allow`.

### Desde el modelo

Tres herramientas, deliberadamente pocas y ortogonales:

- **`jev_ask`** — un lote de preguntas tipadas sobre un solo estado.
- **`jev_rank`** — puntúa y ordena candidatos según un criterio, con una pregunta por candidato en
  una sola ida y vuelta. Las probabilidades son juicios independientes por candidato, no una distribución.
- **`jev_check`** — ¿esta evidencia respalda esta afirmación? Devuelve `supported`, `contradicted`,
  `conflicted`, `insufficient`, `undecided` o `unknown`. La contradicción pesa más que el respaldo, porque una
  evidencia que a la vez respalda y refuta es un conflicto, no un sí débil.

### Una skill incluida

El plugin registra una skill, `typesafe-ai-dsh`, que enseña a un agente cuándo un juicio de Jev es la
herramienta adecuada y cuándo es un error de categoría. Se registra a través del registro de skills en
lugar de distribuirse como un directorio para que un proveedor lo escanee, así que no necesita
depender de dónde guarda un perfil sus skills y desaparece limpiamente cuando se elimina el plugin.

El cuerpo vive en `skills/typesafe-ai-dsh/SKILL.md` y se lee al cargar en lugar de estar incrustado,
así que el archivo que edita una persona es el archivo que se distribuye. Una prueba afirma que los
dos no pueden desviarse.

El registro se declara como una dependencia **opcional**: un perfil que no compone el subsistema de
skills sigue obteniendo el servicio y las tres herramientas, con una advertencia de que la skill se
omitió.

### El proveedor mock

Con `provider: mock`, cada respuesta se deriva de un hash de la pregunta y el estado, así que las
pruebas pueden afirmar valores exactos y no se abre ningún socket. Los resultados sintéticos se
etiquetan como tales en tres lugares: `provider: "mock"`, un nombre de modelo `mock/jev-synthetic` y
un campo `warning` en el resultado. Un mock que pudiera confundirse con un juicio real sería peor que
no tener ningún mock.

---

## Estado

Recuento honesto de lo que se ha verificado y lo que no.

**Verificado**
- 410 pruebas pasan en los tres paquetes (314 del núcleo, 66 de DSH, 30 de MCP), sin acceso a la red
  y sin `TYPESAFE_API_KEY`. La CI borra la variable y espera que la suite pase de todos modos.
- **La ruta de OpenRouter está verificada contra la API real.** `pnpm --filter jevcore run
  probe:live` impulsa el proveedor y `pnpm --filter jevcore-mcp run smoke:live` impulsa toda la
  superficie MCP — transporte, esquemas de herramientas, servicio y proveedor — contra modelos
  System One reales (`typesafe/jev-1.13-20260917`). Un lote de tres primitivas devolvió un `noul` a
  0.91, un `choice` a 0.97 y un `score` de `1.05` en una rúbrica de cuatro niveles, con el uso
  informado como `{ inputTokens: 469, outputTokens: 68, costUsd: 0.000019698 }`. `jev_rank` ordenó
  un runbook de credenciales por encima de una guía de facturación; `jev_check` devolvió
  `contradicted`. Ambos scripts necesitan `OPENROUTER_API_KEY` y quedan excluidos de la CI.
- **Las formas de las cargas útiles se comprueban contra las propias definiciones de tipos de los
  proveedores.** `test/vendor-conformance.test.ts` fija los tipos de pregunta y respuesta de este
  proyecto a ambos SDK, así que una desviación en cualquier dirección es un error de compilación y no
  una solicitud malformada en la única ruta que cuesta dinero y transmite datos. Esa comprobación es
  la que encontró que `score.criteria` se enviara como un mapa con claves cuando la API requiere un
  arreglo ordenado — un defecto que las pruebas unitarias con stubs habían pasado por alto durante
  todo el tiempo. También hay un script que analizaba nuestras cargas útiles contra los esquemas zod
  publicados por OpenRouter para la ruta `alpha/decisions`; tanto el script como esa ruta ya no
  existen, porque el proveedor de OpenRouter ahora usa la ruta documentada `/v1/systemone` a través
  del mismo cliente que usa TypeSafe, que la prueba de conformidad ya cubre.
- **El plugin se activa en un harness en ejecución y sus herramientas funcionan.** La fila del plugin
  informa `active`; `jev_ask` devolvió `urgent=true (0.8307)` y `team=billing (0.5027)` contra el mock
  en 1 ms, y `jev_check` devolvió `verdict="insufficient"` con sus tres probabilidades. Cada resultado
  llevaba `provider: "mock"` y cero uso de tokens, así que la ruta por defecto no hizo ninguna llamada
  de red.
- **La skill incluida se registra.** `typesafe-ai-dsh` aparece en el catálogo de skills de la sesión.
- La ruta por defecto no hace ninguna llamada de red: se afirma espiando `globalThis.fetch` mientras
  se monta el plugin y se responde a través del servicio, y de nuevo mientras se ensambla el runtime
  de MCP.
- Una barrera deshabilitada no registra **ningún** escucha de eventos, y una salida denegada nunca
  llega al proveedor.
- `Config` satisface el protocolo Standard Schema que Cordis requiere antes de que arranque un plugin.
- Cada API de DSH usada aquí (`ctx.provide`, `ctx.effect`, `tools.register`, `defineTool`,
  `tools/pre-execute`, `tools/post-execute`, `credentials.resolve`) se comprobó contra el runtime
  instalado antes de usarla, y los tipos de las cargas útiles provienen de los archivos de declaración
  instalados.

**No verificado, o se sabe que está roto**
- **La ruta de TypeSafe está ejercitada, pero solo de forma ligera.** `packages/core/scripts/probe-live.mjs`
  (`pnpm --filter jevcore run probe:typesafe`) pregunta a la API real tres cosas: diez pares
  claim/evidence cuyo veredicto se conoce de antemano, una pregunta repetida seis veces y un noul con
  un límite `criteria: {true, false}`. Dos ejecuciones separadas coincidieron — la evidencia que
  respalda obtuvo 0.95, la que contradice 0.10, la que guarda silencio sobre la afirmación 0.03, y la
  pregunta repetida varió 0.01 o menos. El límite fue aceptado. Lo que sigue sin probarse es todo lo
  que rodea a la petición en lugar de la petición misma: el comportamiento de cuota, límite de tasa y
  derechos en una cuenta real.
- **La descripción de `jev_ask` arrastra un guion corrupto en la compilación que se está ejecutando
  ahora mismo.** Dice `branches on —?routing` donde corresponde un guion em seguido de un espacio.
  Causa: una ida y vuelta UTF-8 al principio del desarrollo reemplazó el tercer byte del guion em por
  `?`. Está corregido en disco — cuatro ocurrencias, cero restantes, confirmado tanto en el código
  fuente como en la salida de compilación — pero el proceso en ejecución cargó su módulo antes de la
  corrección y no puede volver a leerlo sin reiniciar. El guion en sí es cosmético, pero la
  desactualización no lo es: el mismo proceso carece también de todas las correcciones hechas desde
  que arrancó, incluido el campo `band` que evita que un 0.51 se lea como un sí resuelto.
- El servidor MCP se ha ejecutado de extremo a extremo con un cliente MCP real sobre stdio
  (`pnpm --filter jevcore-mcp run smoke`): handshake, descubrimiento de herramientas, tres llamadas
  exitosas y un resultado de error para un lote inválido. Ningún otro host de terceros lo ha
  ejecutado.
- El comportamiento de las barreras con tráfico en vivo. Las barreras se prueban contra respuestas
  sintéticas y formas reales de cargas útiles de hooks, pero ninguna llamada de herramienta real ha
  pasado por una barrera de extremo a extremo.
- La barrera de contexto no puede recuperar el contexto ya gastado. Impide que un resultado llegue al
  agente; no poda nada de forma retroactiva, y el README de cualquier plugin que afirme lo contrario
  debería leerse con escepticismo.
- No hay pruebas de larga duración ni adversarias. La redacción se basa en patrones y pasará por alto
  una forma de secreto no reconocida.

---

## Notas de diseño

Tres decisiones fáciles de equivocar y caras de equivocar:

**Un juez que no puede responder no debe significar "permitir".** Si no se puede alcanzar Jev, o si
responde por debajo del umbral de confianza, las barreras se resuelven a través de `onUndecided`, que
por defecto es `ask`. La única forma de obtener un comportamiento de fallo abierto es configurarlo. La
barrera de contexto es la excepción deliberada: falla abierta incondicionalmente, porque perder un
resultado de herramienta real por un veredicto fantasma de "irrelevante" es peor que conservar uno
poco informativo.

**Nada de lo que el modelo pueda decir cambia la barrera.** Ninguna herramienta expone la
configuración, los umbrales ni el alcance de las barreras. Un guardián que el proceso vigilado puede
reconfigurar no es un guardián.

**Una probabilidad no es un permiso.** Jev devuelve números; `src/policy.ts` los convierte en
`allow`/`ask`/`deny` frente a umbrales configurados localmente. Una respuesta que nombra un valor
fuera de los criterios declarados es `invalid` y deniega — la garantía de un modelo de decisión tipado
es que no puede devolver un valor no declarado, así que una violación significa que algo aguas arriba
está mal.

## Desarrollo

```sh
pnpm install
pnpm run check      # typecheck + tests + build
pnpm test           # tests only
```

Ninguna prueba requiere una credencial ni una conexión de red, y la CI lo impone ejecutándose con
`TYPESAFE_API_KEY` borrada.

## PerryLink DSH Plugin Family

Este proyecto es uno de los **87 plugins activamente mantenidos** de DeepSeek Harness de [PerryLink](https://github.com/PerryLink). El registro familiar tiene **95** plugins — **5 congelados**, **3 retirados** — y permanece plegado abajo para que cada README conserve una primera pantalla corta. Expándelo para ver cada fila, con el motivo en la columna Estado.

<details>
<summary>Expandir los 95 plugins</summary>

| Plugin | Una línea | Estado |
|---|---|---|
| **[dsh-aqua-input-check](https://github.com/PerryLink/dsh-aqua-input-check)** | 水产养殖投入品记录核对（按投入品用量、休药期与起捕间隔核对记录自洽，仅提示差异，不作出定性结论） |  |
| **[dsh-archive-check](https://github.com/PerryLink/dsh-archive-check)** | 档案归档完整性与保管期限核对（依据《档案法》及配套规定，仅提示差异，不作出定性结论） |  |
| **[dsh-auto-review](https://github.com/PerryLink/dsh-auto-review)** | Second-model auto-review on the approval chain, fail-closed by default |  |
| **[dsh-autotier](https://github.com/PerryLink/dsh-autotier)** | Automatic strong/cheap model-tier routing with deterministic risk guards and a `/tier` command |  |
| **[dsh-background-agents](https://github.com/PerryLink/dsh-background-agents)** | Durable background child agents with a Web UI sidebar, messaging and interrupt | 🚫 RETIRADO — ver el README del repositorio |
| **[dsh-bid-ca-precheck](https://github.com/PerryLink/dsh-bid-ca-precheck)** | 投标文件符合性预检（按招标文件逐条核对响应情况，仅提示差异，不作出定性结论） |  |
| **[dsh-bid-qual-check](https://github.com/PerryLink/dsh-bid-qual-check)** | 投标人资格条件核对（按资格条件与证明材料核对逐条响应，仅提示差异，不作出定性结论） |  |
| **[dsh-budget](https://github.com/PerryLink/dsh-budget)** | Cost governance for DeepSeek Harness: budgets, carbon, and latency in one panel. | 🧊 CONGELADO — ver el README del repositorio |
| **[dsh-cert-mcp](https://github.com/PerryLink/dsh-cert-mcp)** | Read-only MCP server exposing the certification registry: grades, snapshots and five-dimension evidence |  |
| **[dsh-checkpoint-rewind](https://github.com/PerryLink/dsh-checkpoint-rewind)** | Claude Code /rewind-equivalent: snapshots, session forks, one-shot restore |  |
| **[dsh-claude-move](https://github.com/PerryLink/dsh-claude-move)** | Migrate Claude Code sessions, memory, skills and CLAUDE.md into DSH | 🧊 CONGELADO — ver el README del repositorio |
| **[dsh-click](https://github.com/PerryLink/dsh-click)** | Cross-platform native desktop control for DeepSeek Harness — Windows first. |  |
| **[dsh-composer-history](https://github.com/PerryLink/dsh-composer-history)** | Terminal-style input history for the web composer: arrows, Ctrl+R search |  |
| **[dsh-contract-stance](https://github.com/PerryLink/dsh-contract-stance)** | 合同条款立场台账核对（按立场、风险等级与退让底线核对台账自洽，仅提示差异，不作出定性结论） |  |
| **[dsh-customs-doc-check](https://github.com/PerryLink/dsh-customs-doc-check)** | 报关单证一致性核对（按公开的报关单填制规范核对单证间字段一致性，仅提示差异，不作出定性结论） |  |
| **[dsh-data-quality](https://github.com/PerryLink/dsh-data-quality)** | Dataset quality checks and citation cross-checks (the optional numeric bridge consumed here) |  |
| **[dsh-defend](https://github.com/PerryLink/dsh-defend)** | Prompt-injection, jailbreak, and secret-leak defense for DeepSeek Harness. | 🧊 CONGELADO — ver el README del repositorio |
| **[dsh-demurrage-ledger](https://github.com/PerryLink/dsh-demurrage-ledger)** | 滞箱费台账核对（按免箱期与费率核对超期天数与金额的自洽性，仅提示差异，不作出定性结论） |  |
| **[dsh-doublecheck](https://github.com/PerryLink/dsh-doublecheck)** | Engineering-discipline guard: requirements grill, test gates, adversary review |  |
| **[dsh-draw](https://github.com/PerryLink/dsh-draw)** | Unified static-image generation routing for DeepSeek Harness. | 🧊 CONGELADO — ver el README del repositorio |
| **[dsh-drill-script-check](https://github.com/PerryLink/dsh-drill-script-check)** | 应急演练脚本核对（按阶段、响应分级、指挥与资源要素核对脚本齐备，仅提示差异，不作出定性结论） |  |
| **[dsh-eia-guide-check](https://github.com/PerryLink/dsh-eia-guide-check)** | 环评导则适用性核对（按要素、导则名称与执行标准核对台账自洽，仅提示差异，不作出定性结论） |  |
| **[dsh-emergency-plan](https://github.com/PerryLink/dsh-emergency-plan)** | 应急预案要素齐备性与条款级页码定位（依据 GB/T 29639-2020 等公开文件，仅提示差异，不作出定性结论） |  |
| **[dsh-essay-rubric-check](https://github.com/PerryLink/dsh-essay-rubric-check)** | 作文量表评分核对（按评分项、原文定位与分值算术核对评分自洽，仅提示差异，不作出定性结论） |  |
| **[dsh-evidence-check](https://github.com/PerryLink/dsh-evidence-check)** | 证据清单齐备性核对（按待证事实与证据要素核对清单自洽，仅提示差异，不作出定性结论） |  |
| **[dsh-export-ctl-check](https://github.com/PerryLink/dsh-export-ctl-check)** | 出口管制物项核对（按管制清单、最终用途与许可证核对台账齐备，仅提示差异，不作出定性结论） |  |
| **[dsh-fast](https://github.com/PerryLink/dsh-fast)** | Read-only performance diagnostics for DeepSeek Harness. |  |
| **[dsh-fmea-table-check](https://github.com/PerryLink/dsh-fmea-table-check)** | FMEA 分析表要素齐备性与风险顺序数一致性核对（按公开的 FMEA 方法标准核对表内自洽，仅提示差异，不作出定性结论） |  |
| **[dsh-forecast-penalty](https://github.com/PerryLink/dsh-forecast-penalty)** | 预测准确率考核核对（按准确率、门槛与考核单价核对考核费用的算术自洽，仅提示差异，不作出定性结论） |  |
| **[dsh-fund-research](https://github.com/PerryLink/dsh-fund-research)** | Deterministic research reports for Chinese public mutual funds |  |
| **[dsh-github](https://github.com/PerryLink/dsh-github)** | GitHub PR/issues integration for DSH, every write gated by approval |  |
| **[dsh-gongwen-flow-check](https://github.com/PerryLink/dsh-gongwen-flow-check)** | 公文流转与办理时限核对（按公开的公文处理规范核对环节完整性与时限，仅提示差异，不作出定性结论） |  |
| **[dsh-gongwen-word-check](https://github.com/PerryLink/dsh-gongwen-word-check)** | 公文格式要素核对（按公开的党政机关公文格式标准核对版头与主体要素，仅提示差异，不作出定性结论） |  |
| **[dsh-guard-plan-qc](https://github.com/PerryLink/dsh-guard-plan-qc)** | 劳动保护与安全防护用品配置表核对（按公开的配备标准核对品名规格与配置数量，仅提示差异，不作出定性结论） |  |
| **[dsh-hazchem-check](https://github.com/PerryLink/dsh-hazchem-check)** | 危险化学品临界量与重大危险源辨识核对（按储存量与临界量核对台账自洽，仅提示差异，不作出定性结论） |  |
| **[dsh-hazplan-check](https://github.com/PerryLink/dsh-hazplan-check)** | HAZOP 分析表要素齐备性与偏差推导一致性核对（依据公开的危险与可操作性分析标准，仅提示差异，不作出定性结论） |  |
| **[dsh-hidden-risk-map](https://github.com/PerryLink/dsh-hidden-risk-map)** | 安全隐患台账→《工贸企业重大事故隐患判定标准》（应急管理部令第10号）条款映射提示（仅提示差异，不作出定性结论） |  |
| **[dsh-hs-classify](https://github.com/PerryLink/dsh-hs-classify)** | 商品归类层级一致性核对（按章、品目、子目与商品编号的层级关系核对自洽，仅提示差异，不作出定性结论） |  |
| **[dsh-icd-rule-check](https://github.com/PerryLink/dsh-icd-rule-check)** | ICD 合并编码与星剑号配对提示（依据 GB/T 14396-2016 与公开的 ICD 使用说明，仅提示差异，不作出定性结论） |  |
| **[dsh-industry-research](https://github.com/PerryLink/dsh-industry-research)** | Industry research orchestration that seals its deliverables through this plugin's `ctx.researchReport.assemble` |  |
| **[dsh-lawcite-adapter](https://github.com/PerryLink/dsh-lawcite-adapter)** | 法条引用与文书要素核对（按名称、条号、原文与效力状态核对引用可核验性，仅提示差异，不作出定性结论） |  |
| **[dsh-laya](https://github.com/PerryLink/dsh-laya)** | Laya typed decisions (`noul`/`choice`/`score`) as a first-class Cordis service and model-visible tools |  |
| **[dsh-lc-doc-check](https://github.com/PerryLink/dsh-lc-doc-check)** | 信用证单据条款核对（按单据种类、份数、期限与不符点核对交单自洽，仅提示差异，不作出定性结论） |  |
| **[dsh-learning-gap-check](https://github.com/PerryLink/dsh-learning-gap-check)** | 能力差距与培养计划核对（按能力等级差、培养措施与完成期限核对台账闭环，仅提示差异，不作出定性结论） |  |
| **[dsh-library](https://github.com/PerryLink/dsh-library)** | Local document knowledge base for DeepSeek Harness. |  |
| **[dsh-local-ai](https://github.com/PerryLink/dsh-local-ai)** | Local-model (Ollama) integration for DeepSeek Harness. |  |
| **[dsh-lsp-actions](https://github.com/PerryLink/dsh-lsp-actions)** | LSP diagnostics, formatting, completion, code actions and rename over language servers |  |
| **[dsh-mask](https://github.com/PerryLink/dsh-mask)** | PII masking middleware: anonymize at the model boundary, restore at the display layer |  |
| **[dsh-mcp-panel](https://github.com/PerryLink/dsh-mcp-panel)** | Read-only MCP runtime panel: /mcp command + Settings tab with status, tools and errors |  |
| **[dsh-medrec-qc](https://github.com/PerryLink/dsh-medrec-qc)** | 病案首页形式质控与逻辑矛盾提示（依据国卫办医发〔2016〕24号等公开文件，仅提示差异，不作出定性结论） |  |
| **[dsh-memento](https://github.com/PerryLink/dsh-memento)** | Approval-gated cross-session memory: ctx.memory seam + SQLite + memory tool |  |
| **[dsh-nsfc-form-check](https://github.com/PerryLink/dsh-nsfc-form-check)** | 国家自然科学基金申请书形式审查与匿名化提示（依据《国家自然科学基金条例》与申请人导入的当年指南，仅提示差异，不作出定性结论） |  |
| **[dsh-nurse-record-check](https://github.com/PerryLink/dsh-nurse-record-check)** | 护理记录时限、签名与评估表完整性校验（依据《病历书写基本规范》等公开文件，仅提示差异，不作出定性结论） |  |
| **[dsh-observe](https://github.com/PerryLink/dsh-observe)** | OpenTelemetry and Langfuse observability exporter for DeepSeek Harness. |  |
| **[dsh-origin-rvc-check](https://github.com/PerryLink/dsh-origin-rvc-check)** | 原产地区域价值成分核对（按 RVC 定义式与门槛核对原产地判定自洽，仅提示差异，不作出定性结论） |  |
| **[dsh-ota-review-check](https://github.com/PerryLink/dsh-ota-review-check)** | 在线点评回复台账核对（按回复时限、问题分类与整改状态核对台账闭环，仅提示差异，不作出定性结论） |  |
| **[dsh-output-styles](https://github.com/PerryLink/dsh-output-styles)** | Claude Code outputStyles-equivalent runtime style switching |  |
| **[dsh-paper-doc-adapter](https://github.com/PerryLink/dsh-paper-doc-adapter)** | 试卷解析结构核对（按题型、答案、分值与 yotta 标识核对试卷结构自洽，仅提示差异，不作出定性结论） |  |
| **[dsh-permission-rules](https://github.com/PerryLink/dsh-permission-rules)** | Claude Code-style declarative allow/deny/ask permission rules with audit |  |
| **[dsh-permit-report-check](https://github.com/PerryLink/dsh-permit-report-check)** | 行政许可办理核对（按申请材料、法定时限与决定记录核对台账闭环，仅提示差异，不作出定性结论） |  |
| **[dsh-pipeline-check](https://github.com/PerryLink/dsh-pipeline-check)** | 项目全流程文件链条核对（按环节先后与金额口径核对链条自洽，仅提示差异，不作出定性结论） |  |
| **[dsh-pleading-draft](https://github.com/PerryLink/dsh-pleading-draft)** | 起诉状要素齐备性核对（按诉请、事实、证据、法条四要素核对文书齐备，仅提示差异，不作出定性结论） |  |
| **[dsh-plugin-doctor](https://github.com/PerryLink/dsh-plugin-doctor)** | Zero-dependency static + sandbox smoke detector for DSH plugins |  |
| **[dsh-plugin-guide](https://github.com/PerryLink/dsh-plugin-guide)** | Plugin-development knowledge base as an on-demand agent skill |  |
| **[dsh-plugin-kit](https://github.com/PerryLink/dsh-plugin-kit)** | Shared zero-runtime-dependency toolkit for the PerryLink DSH plugins |  |
| **[dsh-plugin-upgrade](https://github.com/PerryLink/dsh-plugin-upgrade)** | One-package, one-corridor-index plugin upgrade skill: routes a repository to the matching closed corridor card |  |
| **[dsh-policy-brief-draft](https://github.com/PerryLink/dsh-policy-brief-draft)** | 政策专报要素核对（按观点、依据、出处与建议核对专报齐备，仅提示差异，不作出定性结论） |  |
| **[dsh-power-loss-split](https://github.com/PerryLink/dsh-power-loss-split)** | 线损电量拆分与考核表核对（依据公开的线损计算口径，仅提示差异，不作出定性结论） |  |
| **[dsh-power-ticket-check](https://github.com/PerryLink/dsh-power-ticket-check)** | 电力工作票要素齐备性与签发许可顺序核对（依据现行电力安全工作规程，仅提示差异，不作出定性结论） |  |
| **[dsh-ppap-check](https://github.com/PerryLink/dsh-ppap-check)** | PPAP 提交要素齐备性核对（按公开的 PPAP 手册与提交等级核对要素齐备与版本填写，仅提示差异，不作出定性结论） |  |
| **[dsh-protest-deadline](https://github.com/PerryLink/dsh-protest-deadline)** | 质疑与投诉期限核对（按公开的政府采购质疑投诉规定核对期限与台账自洽，仅提示差异，不作出定性结论） |  |
| **[dsh-railway-window](https://github.com/PerryLink/dsh-railway-window)** | 铁路施工天窗台账核对（按时间窗、时长算术与命令号核对台账自洽，仅提示差异，不作出定性结论） |  |
| **[dsh-reach](https://github.com/PerryLink/dsh-reach)** | Multi-channel approval/question bridge: WeChat/Telegram/Feishu, session console | 🧊 CONGELADO — ver el README del repositorio |
| **[dsh-repair-order-qc](https://github.com/PerryLink/dsh-repair-order-qc)** | 维修工单结算核对（按项目金额、配件工时合计与结算总额核对算术自洽，仅提示差异，不作出定性结论） |  |
| **[dsh-research-report](https://github.com/PerryLink/dsh-research-report)** | Verifiable research-report engine: content-addressed evidence ledger and sealed versions |  |
| **[dsh-review-reply-check](https://github.com/PerryLink/dsh-review-reply-check)** | 审稿意见逐条回应覆盖核对（按意见与回应一一对应核对覆盖完整性，仅提示差异，不作出定性结论） |  |
| **[dsh-rulefile-check](https://github.com/PerryLink/dsh-rulefile-check)** | 规则库文件自检核对（按条款引用纪律与效力上限核对规则库自身合规，仅提示差异，不作出定性结论） |  |
| **[dsh-safety-brief-check](https://github.com/PerryLink/dsh-safety-brief-check)** | 安全技术交底记录要素齐备性与签字闭环核对（依据公开的安全生产法规与检查标准，仅提示差异，不作出定性结论） |  |
| **[dsh-score](https://github.com/PerryLink/dsh-score)** | Multi-dimensional quality scoring for DeepSeek Harness plugins. |  |
| **[dsh-session-pin](https://github.com/PerryLink/dsh-session-pin)** | Pin sessions in the Web sidebar with durable ordering | 🚫 RETIRADO — ver el README del repositorio |
| **[dsh-session-sync](https://github.com/PerryLink/dsh-session-sync)** | Cross-device session sync for DeepSeek Harness — a dedicated git mirror of your session store. |  |
| **[dsh-site-log-check](https://github.com/PerryLink/dsh-site-log-check)** | 监理日志跨日连续性与旁站覆盖提示（依据 GB/T 50319-2013 等公开文件，仅提示差异，不作出定性结论） |  |
| **[dsh-skill-pack-security](https://github.com/PerryLink/dsh-skill-pack-security)** | Security-audit skill pack: secret scan, dependency and supply-chain review |  |
| **[dsh-soe-decision-check](https://github.com/PerryLink/dsh-soe-decision-check)** | 三重一大决策台账核对（按前置研究、会议审议与决议记录核对程序留痕，仅提示差异，不作出定性结论） |  |
| **[dsh-soilwater-check](https://github.com/PerryLink/dsh-soilwater-check)** | 土壤与地下水监测台账核对（按点位、监测项目、限值与超标判定核对台账自洽，仅提示差异，不作出定性结论） |  |
| **[dsh-sop-sync-check](https://github.com/PerryLink/dsh-sop-sync-check)** | 作业规程与 FMEA／控制计划一致性核对（按编号与版本核对三份文件是否同步，仅提示差异，不作出定性结论） |  |
| **[dsh-spc-gbt-adapter](https://github.com/PerryLink/dsh-spc-gbt-adapter)** | 控制图常数与过程能力指数核对（按 GB/T 4091 的常规控制图常数表核对控制限与 Cp/Cpk 的自洽性，仅提示差异，不作出定性结论） |  |
| **[dsh-talk](https://github.com/PerryLink/dsh-talk)** | Voice-first session loop for DeepSeek Harness: talk to it, hear it answer. |  |
| **[dsh-team-rooms](https://github.com/PerryLink/dsh-team-rooms)** | Cross-session team rooms: shared message bus, task board and timeline | 🚫 RETIRADO — ver el README del repositorio |
| **[dsh-tender-extract](https://github.com/PerryLink/dsh-tender-extract)** | 招标文件条款摘录核对（按出处与原文逐字核对摘录完整性，仅提示差异，不作出定性结论） |  |
| **[dsh-tender-matrix](https://github.com/PerryLink/dsh-tender-matrix)** | 评标因素评分矩阵核对（按分值上限与合计核对矩阵自洽，仅提示差异，不作出定性结论） |  |
| **[dsh-test-drive](https://github.com/PerryLink/dsh-test-drive)** | Isolated install-and-smoke test drives for DeepSeek Harness plugins. |  |
| **[dsh-ticktick](https://github.com/PerryLink/dsh-ticktick)** | TickTick/Dida365 task bridge: session-header panel + 11 tools |  |
| **[dsh-translate](https://github.com/PerryLink/dsh-translate)** | Vendor parameter translation and deterministic JSON repair for DeepSeek Harness. |  |
| **[dsh-warranty-calc](https://github.com/PerryLink/dsh-warranty-calc)** | 质保期与索赔金额核对（按质保期月数与里程、索赔金额算式核对自洽，仅提示差异，不作出定性结论） |  |

</details>

</details>

## Licencia

[Apache License 2.0](LICENSE) © 2026 jevcore contributors

TypeSafe, Jev y System One son marcas registradas de TypeSafe AI. Este proyecto es una integración
independiente y no está afiliado a TypeSafe AI ni cuenta con su respaldo.
