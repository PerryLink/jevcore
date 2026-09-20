# jevcore-mcp

TypeSafe [Jev](https://typesafe.ai) sobre el Model Context Protocol.

Jev no es un modelo de chat. Responde preguntas tipadas — `noul` (sí/no), `choice`,
`score` — y devuelve probabilidades calibradas. No escribe prosa, y pedírselo es un
error de categoría. Este servidor expone exactamente esa superficie.

**Offline por defecto. Egreso declarado. Nada activado por defecto.**

## Instalación

```sh
npx -y jevcore-mcp
```

Regístralo como servidor MCP stdio en tu host. Para DeepSeek Harness, eso es un
bundle solo de configuración cuyo patch inserta el cliente MCP del harness:

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

## Configuración

| Variable | Efecto |
|---|---|
| `TYPESAFE_API_KEY` | Selecciona la ruta TypeSafe cuando está presente |
| `OPENROUTER_API_KEY` | Selecciona la ruta OpenRouter cuando está presente y no hay ninguna clave TypeSafe |
| `JEV_PROVIDER` | `mock`, `live` u `openrouter` — anula la heurística anterior |
| `TYPESAFE_MODEL` / `OPENROUTER_MODEL` | Id de modelo para la ruta seleccionada |
| `TYPESAFE_BASE_URL` / `OPENROUTER_BASE_URL` | Raíz de la API para la ruta seleccionada |

Dos rutas llegan a los mismos modelos. TypeSafe los sirve directamente; OpenRouter sirve
los modelos System One en la misma ruta `POST /v1/systemone` que TypeSafe, un nivel por
debajo de su propia raíz de API, que es la forma de entrar cuando una clave de
TypeSafe no es práctica. Difieren en qué servidores ven tu estado, así que el informe
de arranque nombra el endpoint en lugar de dejarlo implícito en el nombre del proveedor.
En la ruta de OpenRouter el id de modelo debe ser uno de System One: el `jev-latest`
sin prefijo es el valor por defecto, `typesafe/` se acepta en un id con versión como
`typesafe/jev-1.13`, y `typesafe/jev-latest` no se acepta. Cualquier otra cosa responde
con prosa que este servidor no puede interpretar como una decisión.

A diferencia de un adaptador por llamada, este servidor resuelve su credencial **una
sola vez al arrancar** — es un proceso de larga vida y su credencial no cambia a
mitad de sesión. Por tanto, `JEV_PROVIDER=live` sin clave es un error de arranque con
un mensaje legible, no un fallo en la primera llamada a herramienta.

## Las herramientas

| Herramienta | Propósito |
|---|---|
| `jev_ask` | Una o más preguntas tipadas sobre un estado; agrúpalas en una sola llamada |
| `jev_rank` | Puntúa y ordena candidatos según un único criterio, con una pregunta por candidato |
| `jev_check` | ¿Esta evidencia respalda esta afirmación? `supported`, `contradicted`, `conflicted`, `insufficient`, `undecided` o `unknown` |

Tres herramientas, deliberadamente pocas y ortogonales. Ya existen dos servidores MCP
de Jev que distribuyen diez herramientas cada uno; este existe para el caso en que un
host quiere las tres primitivas y nada más, construido sobre el mismo core que el
plugin de DeepSeek Harness para que los dos no puedan divergir.

`jev_rank` acepta una lista acotada, no lo mejor de una lista cualquiera. Cada candidato añade una pregunta a
un presupuesto fijo de 4,000 caracteres sobre el mapa de preguntas, y una lista que no cabe se rechaza
con un error, no se trunca a los primeros N que sí caben: con el criterio por defecto caben 20
candidatos, con un criterio de 100 caracteres 17, y con uno de 500 caracteres 6. Mantén cortas las
listas de candidatos, conciso el criterio, y divide una lista larga en lotes.

Cada resultado lleva probabilidades, no decisiones. Aplica tu propio umbral de
confianza antes de actuar, y trata una respuesta de baja confianza como desconocida en
lugar de elegir por ella.

## El informe de egreso

El servidor imprime su contrato en **stderr** al arrancar:

```
[jevcore] provider=mock  endpoint=none  egress=OFF  (no network calls will be made; every answer is synthetic)
[jevcore]   armed  tool:jev_ask  (runs against the offline mock; would transmit if the provider became "live" or "openrouter")
```

Stderr, nunca stdout: en un transporte stdio stdout es el canal del protocolo y una
línea suelta ahí corrompería el flujo.

La ocultación se ejecuta antes de enviar nada. Es una mitigación, no una garantía — un
secreto no reconocido en texto libre pasará. Si esa posibilidad es inaceptable, no
configures ninguna clave.

## Estado

Las herramientas, la selección de proveedor y la aplicación del egreso están cubiertas por pruebas,
y el transporte ha sido puesto a prueba de extremo a extremo por un cliente MCP real sobre stdio:

```sh
pnpm --filter jevcore-mcp run smoke        # offline, mock provider, no credential
pnpm --filter jevcore-mcp run smoke:live   # real answers, needs OPENROUTER_API_KEY
```

La ejecución offline ejercita el handshake, el descubrimiento de herramientas, tres
llamadas exitosas y la ruta de error para un lote inválido.

La ejecución live lleva la misma superficie contra modelos System One reales a través
de OpenRouter: las tres herramientas respondieron, un lote de tres primitivas devolvió
un `score` de `1.08` en una rúbrica de tres niveles con su leyenda intacta, `jev_rank`
ordenó un runbook de credenciales por encima de una guía de facturación, `jev_check`
devolvió `contradicted`, y el informe de egreso de arranque nombró el endpoint de
OpenRouter en stderr sin perturbar el canal del protocolo.

**La ruta de TypeSafe está ejercitada, pero solo de forma ligera.** `packages/core/scripts/probe-live.mjs`
(`pnpm --filter jevcore run probe:typesafe`) pregunta a la API real tres cosas: diez pares
claim/evidence cuyo veredicto se conoce de antemano, una pregunta repetida seis veces y un noul con
un límite `criteria: {true, false}`. Dos ejecuciones separadas coincidieron — la evidencia que
respalda obtuvo 0.95, la que contradice 0.10, la que guarda silencio sobre la afirmación 0.03, y la
pregunta repetida varió 0.01 o menos. El límite fue aceptado. Lo que sigue sin probarse es todo lo
que rodea a la petición en lugar de la petición misma: el comportamiento de cuota, límite de tasa y
derechos en una cuenta real.

## Licencia

[Apache License 2.0](LICENSE) © 2026 jevcore contributors. TypeSafe, Jev, and
System One are trademarks of TypeSafe AI; this is an independent integration and
is not affiliated with or endorsed by them.
