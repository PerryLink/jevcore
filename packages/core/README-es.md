# jevcore

Decisiones de TypeSafe [Jev](https://typesafe.ai), sin ningún framework adjunto.

Este paquete no importa nada de DeepSeek Harness, Cordis ni de ningún runtime de
plugins. Se puede usar desde un script Node corriente, un servidor MCP, una CLI o un
adaptador de harness de agentes — y por eso los adaptadores de este repositorio son
capas finas sobre él, y no al revés.

Jev no es un modelo de chat. Responde preguntas tipadas — `noul` (sí/no), `choice`,
`score` — y devuelve probabilidades calibradas. No escribe prosa.

**Offline por defecto. Egreso declarado. Nada activado por defecto.**

## Instalación

```sh
npm install jevcore
```

`@typesafe-ai/sdk` es una dependencia opcional. Sin ella el paquete sigue
funcionando por completo contra el mock offline; solo `provider: live` la necesita,
y se importa de forma perezosa.

## Las dos ideas que conviene conocer

### El contrato de egreso

`EgressContract` es el único lugar que decide qué puede salir de la máquina.

Cada característica que puede transmitir declara los campos que envía y el límite de
cada uno. Ninguna característica transmite a menos que esté activada. Nada llega a un
proveedor sin pasar por él, y el contrato puede describirse a sí mismo:

```ts
import { EgressContract } from 'jevcore'

for (const line of contract.reportLines()) console.log(line)
// [jevcore] provider=mock  endpoint=none  egress=OFF  (no network calls will be made; ...)
```

La ocultación se ejecuta antes de la medición, así que los tamaños notificados son
los tamaños que realmente salen. Su límite está documentado en lugar de esconderse:
elimina valores bajo nombres de campo reconocibles y cadenas que coinciden con formas
de secreto conocidas, y **no** detectará un secreto no reconocido en texto libre.

### Una probabilidad no es un permiso

`applyPolicy` convierte los números de Jev en `allow` / `ask` / `deny` según umbrales
que viven en tu configuración, nunca en la salida del modelo.

```ts
import { applyPolicy, DEFAULT_POLICY } from 'jevcore'

const verdict = applyPolicy(answer, ['low', 'medium', 'high'], {
  ...DEFAULT_POLICY,
  accept: { low: true, medium: false, high: false },
})
// decided | undecided | invalid
```

Una respuesta que nombra un valor fuera de los criterios que declaraste es `invalid`,
no es de fiar: la garantía de un modelo de decisión tipado es que no puede devolver
un valor no declarado, así que una violación significa que algo aguas arriba está mal.

Un veredicto `undecided` no es un `allow`. Un gate que por defecto permite cuando no
está seguro no es un gate.

## Qué hay aquí

| Área | Exportaciones |
|---|---|
| Primitivas | `noul`, `choice`, `score`, `assertValidBatch`, `topCriterion` |
| Proveedores | `MockProvider`, `LiveProvider`, `assertUsableEndpoint` |
| Egreso | `EgressContract`, `EGRESS_FEATURES`, `EGRESS_FIELDS`, `EgressDeniedError` |
| Ocultación | `redact`, `DEFAULT_KEY_RULES`, `DEFAULT_VALUE_RULES` |
| Política | `applyPolicy`, `verdictToAction`, `DEFAULT_POLICY` |
| Verificación | `resolveCheck`, `VERDICT_QUESTION`, `DEFAULT_CHECK_THRESHOLDS` |
| Servicio | `JevService` |
| Gates | `createSafetyGate`, `createContextGate` |
| Configuración | `resolveConfig`, `Config`, `DEFAULT_CONFIG` |
| Credenciales | `resolveApiKey`, `describeKeySource` |

Los gates son agnósticos al framework: reciben una entrada simple — el nombre de una
herramienta y sus argumentos, o el contenido de un resultado — y devuelven una
decisión. Conectarlos a un evento concreto es tarea del adaptador.

## El proveedor mock

Determinista y offline: cada respuesta se deriva de un hash de la pregunta y del
estado, así que las pruebas pueden afirmar valores exactos y no se abre ningún socket.
Los resultados sintéticos se etiquetan en tres lugares — `provider: "mock"`, un nombre
de modelo `mock/jev-synthetic` y un campo `warning`. Un mock que pudiera confundirse
con un juicio real sería peor que ningún mock.

Lo que varía es más estrecho de lo que eso sugiere, y hay una entrada que nunca lee: el texto
`instructions` de la pregunta. El hash cubre únicamente el id de la pregunta y el estado de la
petición. Dos preguntas redactadas de forma distinta con el mismo id sobre el mismo estado reciben por
tanto la misma respuesta, así que el mock no puede decirte si un prompt está bien redactado. Los
criterios declarados tampoco entran en el hash, pero siguen dando forma a la respuesta: una respuesta
`choice` reparte sus pesos entre las etiquetas que declaraste, y una `score` entre el número de
niveles. Ambas informan de una confianza fija de 0.5. [docs/limits.md](docs/limits.md) enumera el
resto de lo que la ruta offline no modela.

## Desarrollo

```sh
pnpm install
pnpm run check
```

Ninguna prueba requiere una credencial ni una conexión de red.

## Licencia

[Apache License 2.0](LICENSE) © 2026 jevcore contributors. TypeSafe, Jev, and
System One are trademarks of TypeSafe AI; this is an independent integration and
is not affiliated with or endorsed by them.
