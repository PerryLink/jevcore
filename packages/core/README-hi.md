# jevcore

TypeSafe [Jev](https://typesafe.ai) निर्णय, बिना कोई framework साथ जोड़े।

यह package DeepSeek Harness, Cordis या किसी भी plugin runtime से कुछ भी import नहीं करता।
यह एक सादे Node script, एक MCP server, एक CLI, या किसी agent-harness
adapter से इस्तेमाल किया जा सकता है — इसीलिए इस repository में adapters इसके ऊपर पतली
परतें हैं, न कि इसके उलट।

Jev कोई chat model नहीं है। यह typed सवालों के जवाब देता है — `noul` (हाँ/नहीं), `choice`,
`score` — और calibrated probabilities लौटाता है। यह prose नहीं लिखता।

**डिफ़ॉल्ट रूप से ऑफ़लाइन। Egress का खुलासा। कुछ भी डिफ़ॉल्ट रूप से चालू नहीं।**

## Install

```sh
npm install jevcore
```

`@typesafe-ai/sdk` एक optional dependency है। इसके बिना भी package ऑफ़लाइन mock के
सामने पूरी तरह काम करता है; केवल `provider: live` को इसकी ज़रूरत होती है, और यह
lazily import होता है।

## जानने लायक दो विचार

### Egress अनुबंध

`EgressContract` वह एकमात्र जगह है जो तय करती है कि machine से बाहर क्या जा सकता है।

हर वह सुविधा जो transmit कर सकती है, घोषित करती है कि वह कौन-से fields भेजती है और हर एक की
सीमा क्या है। कोई भी सुविधा तब तक transmit नहीं करती जब तक वह चालू न हो। कुछ भी provider तक
इससे गुज़रे बिना नहीं पहुँचता, और यह अनुबंध अपना वर्णन स्वयं कर सकता है:

```ts
import { EgressContract } from 'jevcore'

for (const line of contract.reportLines()) console.log(line)
// [jevcore] provider=mock  endpoint=none  egress=OFF  (no network calls will be made; ...)
```

Redaction मापन से पहले चलती है, इसलिए जो sizes बताई जाती हैं वही sizes वास्तव में बाहर जाती हैं।
इसकी सीमा छिपाई नहीं गई बल्कि दर्ज है: यह पहचाने जाने योग्य field names के नीचे की values और ज्ञात
secret shapes से मेल खाती strings हटाती है, और मुक्त पाठ में किसी अपरिचित secret को
**नहीं** पकड़ेगी।

### Probability अनुमति नहीं है

`applyPolicy` Jev की संख्याओं को उन thresholds के सामने `allow` / `ask` / `deny` में बदल देता है
जो आपकी configuration में रहती हैं, कभी model output में नहीं।

```ts
import { applyPolicy, DEFAULT_POLICY } from 'jevcore'

const verdict = applyPolicy(answer, ['low', 'medium', 'high'], {
  ...DEFAULT_POLICY,
  accept: { low: true, medium: false, high: false },
})
// decided | undecided | invalid
```

आपके घोषित criteria से बाहर की कोई value बताने वाला उत्तर `invalid` है, विश्वसनीय नहीं:
typed decision model की गारंटी यही है कि वह कोई अपघोषित value नहीं लौटा सकता, इसलिए उसका
उल्लंघन होने का अर्थ है कि upstream में कुछ गड़बड़ है।

`undecided` verdict, `allow` नहीं है। जो gate अनिश्चित होने पर अनुमति देने को डिफ़ॉल्ट बनाता है,
वह gate नहीं है।

## इसमें क्या है

| Area | Exports |
|---|---|
| Primitives | `noul`, `choice`, `score`, `assertValidBatch`, `topCriterion` |
| Providers | `MockProvider`, `LiveProvider`, `assertUsableEndpoint` |
| Egress | `EgressContract`, `EGRESS_FEATURES`, `EGRESS_FIELDS`, `EgressDeniedError` |
| Redaction | `redact`, `DEFAULT_KEY_RULES`, `DEFAULT_VALUE_RULES` |
| Policy | `applyPolicy`, `verdictToAction`, `DEFAULT_POLICY` |
| Verification | `resolveCheck`, `VERDICT_QUESTION`, `DEFAULT_CHECK_THRESHOLDS` |
| Service | `JevService` |
| Gates | `createSafetyGate`, `createContextGate` |
| Config | `resolveConfig`, `Config`, `DEFAULT_CONFIG` |
| Credentials | `resolveApiKey`, `describeKeySource` |

Gates framework-agnostic हैं: वे एक सादा input लेते हैं — किसी tool का नाम और उसके
arguments, या किसी result की content — और एक निर्णय लौटाते हैं। उन्हें किसी विशेष
event से जोड़ना adapter का काम है।

## Mock provider

Deterministic और ऑफ़लाइन: हर उत्तर प्रश्न और state के hash से निकाला जाता है, इसलिए
tests ठीक-ठीक values assert कर सकते हैं और कोई socket नहीं खुलता। Synthetic
नतीजे तीन जगह लेबल होते हैं — `provider: "mock"`, एक `mock/jev-synthetic`
model नाम, और एक `warning` field। ऐसा mock जिसे असली निर्णय समझ लिया जा सके, बिना mock
के होने से भी बुरा होगा।

## Development

```sh
pnpm install
pnpm run check
```

किसी test को किसी credential या network connection की ज़रूरत नहीं होती।

## License

[Apache License 2.0](LICENSE) © 2026 jevcore contributors. TypeSafe, Jev, और
System One, TypeSafe AI के trademarks हैं; यह एक स्वतंत्र integration है और
इनसे संबद्ध नहीं है और न ही इनके द्वारा अनुमोदित है।
