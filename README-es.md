# jevcore

TypeSafe [Jev](https://typesafe.ai) para [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
y cualquier otro host MCP.

Jev no es un modelo de chat. Responde preguntas tipadas — `noul` (sí/no), `choice`, `score` — y devuelve
probabilidades calibradas. No escribe prosa, y pedírselo es un error de categoría. Este proyecto
le da a un agente exactamente esa superficie, y nada más.

**Sin conexión por defecto. Salida divulgada. Nada activado por defecto.**

---

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

## Licencia

[Apache License 2.0](LICENSE) © 2026 jevcore contributors

TypeSafe, Jev y System One son marcas registradas de TypeSafe AI. Este proyecto es una integración
independiente y no está afiliado a TypeSafe AI ni cuenta con su respaldo.
