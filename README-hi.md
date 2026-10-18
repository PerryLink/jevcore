# jevcore

[![dshfind](https://dshfind.com/api/badge/PerryLink/jevcore?metric=downloads)](https://dshfind.com/plugins/PerryLink/jevcore?ref=badge)
[![DSH Market](https://raw.githubusercontent.com/2BingLing/dsh-market/master/assets/readme/badge-listed-en.svg)](https://dsh.market/)
[![OpenSSF Scorecard](https://api.securityscorecards.dev/projects/github.com/PerryLink/jevcore/badge)](https://api.securityscorecards.dev/projects/github.com/PerryLink/jevcore)
[![jevcore MCP server](https://glama.ai/mcp/servers/PerryLink/jevcore/badges/score.svg)](https://glama.ai/mcp/servers/PerryLink/jevcore)

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) और किसी भी अन्य MCP host के लिए
TypeSafe [Jev](https://typesafe.ai)।

Jev कोई chat model नहीं है। यह typed questions — `noul` (हाँ/नहीं), `choice`, `score` — का उत्तर देता है और
calibrated probabilities लौटाता है। यह prose नहीं लिखता, और उससे prose माँगना एक category error है। यह project
एक agent को ठीक वही surface देता है, और उससे अधिक कुछ नहीं।

**डिफ़ॉल्ट रूप से offline। egress का खुलासा। कुछ भी डिफ़ॉल्ट रूप से चालू नहीं।**

---

**📖 इकोसिस्टम नॉलेज बेस** — मापे गए आँकड़े, मार्केटिंग नहीं: [डेवलपमेंट गाइड · चयन डेटा · रखरखाव मानदंड](https://perrylink.github.io/dsh-plugin-guide/)।

<!-- star-cta -->
## ⭐ अगर इससे मदद मिली

यह plugin DeepSeek Harness के लिए [95 plugins के परिवार](https://github.com/PerryLink) का हिस्सा है, सभी Apache-2.0। अगर आप इसे इस्तेमाल करते हैं, तो **एक star** कुछ भी unlock नहीं करता, पर अगले व्यक्ति को इसे खोजने में मदद करता है।

*English:* part of a 95 plugin family for DeepSeek Harness. If it is useful, **a star helps the next person find it** — nothing is gated behind it.

## तीन packages, एक decision layer

| Package | यह क्या है | इसे कब इस्तेमाल करें |
|---|---|---|
| [`jevcore`](packages/core) | निर्णय। DeepSeek Harness या Cordis से कुछ भी import नहीं करता। | आप Jev को किसी सादे script, किसी service, या अपने ही harness में चाहते हैं |
| [`jevcore-dsh`](packages/dsh) | DSH plugin: एक service, तीन tools, दो opt-in gates | आप DeepSeek Harness चला रहे हैं |
| [`jevcore-mcp`](packages/mcp) | MCP पर वही तीन tools, एक stdio binary के साथ | आपका host MCP बोलता है पर DSH नहीं है |

Adapters जान-बूझकर पतले हैं। `packages/dsh` में चार files हैं: यह tool schemas declare करता है और
hook payloads का अनुवाद करता है। निर्णय जैसा कुछ भी — primitives, providers, egress contract,
policy, gates — core में रहता है, ताकि कोई नया adapter उन guarantees से हट न सके जो बाकी देते हैं।
इन तीनों में एक runtime आवश्यकता अलग है: `jevcore-dsh` harness का अनुसरण करता है और उसे
Node `^22.19.0 || >=24.0.0` चाहिए, जबकि `jevcore` और `jevcore-mcp` को `>=20` चाहिए।

---

## यह क्यों मौजूद है

2026-09-17 और 09-20 के बीच, उन्नीस plugins आए जो Jev को DSH से जोड़ते हैं। उनके source का audit करने पर
एक लगातार pattern मिला: जिस module पर *guard*, *gate*, या *warden* का label था, वही module
prompts, tool arguments, और file contents किसी third party को भेज रहा था, और README में आम तौर पर यह
नहीं लिखा था। कई डिफ़ॉल्ट रूप से enabled थे। एक gate को उसी model द्वारा reconfigure किया जा सकता था
जिसकी वह guard कर रहा था।

यह project वही विचार है, पर उन failure modes को डिज़ाइन से बाहर किया हुआ:

| गुण | यहाँ इसकी गारंटी कैसे है |
|---|---|
| कोई network call नहीं, जब तक आप एक न माँगें | डिफ़ॉल्ट provider एक offline mock है; live path के लिए `provider: live` और हल की गई credential दोनों चाहिए |
| हर transmission का नाम उससे पहले | प्रति feature एक startup log line: `off` या `SENDS <feature> { fields }` |
| Disabled gates कुछ register नहीं करते | Policy से नहीं, test से verified — एक disabled gate कोई event listener जोड़ता ही नहीं |
| Model अपनी ही बाधाएँ नहीं बढ़ा सकता | कोई tool gate configuration उजागर नहीं करता |
| जो judge उत्तर नहीं दे सकता, उसका मतलब कभी "allow" नहीं | Undecided स्पष्ट config से तय होता है, जिसका default `ask` है |

---

## egress contract

यही वह हिस्सा है जिसे install करने से पहले पढ़ना बनता है।

Transmission हर feature के लिए अलग तय होता है, और हर feature का default off है। Plugin load होते समय
अपना contract छापता है:

```
[jevcore] provider=mock  endpoint=none  egress=OFF  (no network calls will be made; every answer is synthetic)
[jevcore] ready - provider=mock - gates: safety=off context=off
```

`provider: live` और हर feature enabled होने पर वही report स्पष्ट बताती है कि बाहर क्या जाता है:

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

| Feature | डिफ़ॉल्ट रूप से off? | यह क्या भेजता है |
|---|---|---|
| `tool:jev_ask` | तब चलता है जब model इसे call करता है | redaction के बाद वे arguments जो model ने pass किए |
| `tool:jev_rank` | तब चलता है जब model इसे call करता है | query और हर candidate |
| `tool:jev_check` | तब चलता है जब model इसे call करता है | claim और उसका evidence |
| `gate:safety` | **हाँ — स्पष्ट opt-in** | tool का नाम, उसके arguments, workspace root |
| `gate:context` | **हाँ — स्पष्ट opt-in** | कोई बड़ा tool result जो agent को अभी मिला है |

Tools तभी transmit करते हैं जब model उन्हें call करना चुनता है, जो transcript में दिखता है। Gates हर
matching tool call पर चलते, जो नहीं दिखता, इसलिए वे opt-in हैं।

### Redaction, और उसकी ईमानदार सीमा

कुछ भी भेजे जाने से पहले, `src/redact.ts` दो passes चलाता है: संवेदनशील field names
(`password`, `token`, `apiKey`, `authorization`, …) के नीचे की values पूरी तरह बदल दी जाती हैं, और free text
में बच निकलने वाली secret-shaped strings pattern-match की जाती हैं (`Bearer …`, `sk-…`, `ts_live_…`,
AWS/GitHub/Google key shapes, JWTs, private-key headers, connection strings में credentials)।

यह एक mitigation है, अनुमति नहीं। कोई secret जो किसी अनजानी key name के नीचे बैठा हो *और* किसी ज्ञात
shape से न मिलता हो, वह पार निकल जाएगा। अगर आपके workload के लिए यह संभावना अस्वीकार्य है, तो
live provider enable न करें।

---

## Install

### एक DeepSeek Harness plugin के रूप में

```sh
dsh plugin --profile <profile> add jevcore-dsh
```

या किसी checkout से:

```sh
dsh plugin --profile <profile> add /absolute/path/to/jevcore/packages/dsh
```

`packages/dsh` `jevcore` को नाम से import करता है, इसलिए एक checkout के लिए core का profile से
resolvable होना भी चाहिए (`add /absolute/path/to/jevcore/packages/core`)।

फिर पुष्टि करें कि row activate हुआ — plugin list में `jev` को `active` दिखना चाहिए,
`failed` नहीं — और log में startup report देखें।

### एक MCP server के रूप में

ऐसे host के लिए जो MCP बोलता है, वही तीन tools stdio पर उपलब्ध हैं:

```sh
npx -y jevcore-mcp
```

इसे विशेष रूप से DeepSeek Harness में जोड़ने के लिए, एक configuration-only bundle install करें
जिसका patch harness का अपना MCP client insert करता है:

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

env map वैकल्पिक नहीं है: DSH किसी spawned server को दिए जाने वाले environment से
credential जैसे हर नाम को हटा देता है (यानी KEY, PASSWORD, SECRET या TOKEN वाला कोई भी
नाम, case की परवाह किए बिना), और उसके बाद यह map मिलाता है। shell में export की गई key
कभी नहीं पहुँचती, और server बिना कोई error बताए offline mock पर ही रहता है।

Provider environment से चुना जाता है:

| Variable | असर |
|---|---|
| `TYPESAFE_API_KEY` | मौजूद होने पर TypeSafe route चुनता है |
| `OPENROUTER_API_KEY` | मौजूद होने पर और कोई TypeSafe key न होने पर OpenRouter route चुनता है |
| `JEV_PROVIDER` | `mock`, `live`, या `openrouter` — ऊपर की heuristic को override करता है |
| `TYPESAFE_MODEL` / `OPENROUTER_MODEL` | चुने गए route के लिए model id |
| `TYPESAFE_BASE_URL` / `OPENROUTER_BASE_URL` | चुने गए route के लिए API root |

दोनों में से कोई key न होने पर यह offline mock पर ही रहता है। Plugin के विपरीत, MCP server
अपनी credential startup पर एक बार resolve करता है, इसलिए `JEV_PROVIDER=live` के साथ key का गायब होना
हर call का आश्चर्य नहीं, बल्कि एक startup error है।

इसकी egress report **stderr** पर जाती है, कभी stdout पर नहीं — stdio transport पर stdout
ही protocol channel है, और वहाँ एक छिटकी हुई line stream को भ्रष्ट कर देगी।

### Live पर जाना

Jev तक दो routes हैं। दोनों वही models call करते हैं और दोनों वही
typed answers लौटाते हैं; अंतर यह है कि आपकी credential किसके पास है और आपका state किसके servers देखते हैं।

**सीधे TypeSafe** — यह तब इस्तेमाल करें जब आपके पास
[console.typesafe.ai](https://console.typesafe.ai/settings/keys) से key हो:

```yml
- insert:
    - id: jev
      name: 'jevcore-dsh'
      config:
        provider: live
        apiKeyRef: TYPESAFE_API_KEY   # a reference, never the key
        model: jev-latest
```

**OpenRouter के ज़रिए** — यह तब इस्तेमाल करें जब TypeSafe key व्यावहारिक न हो और आपके पास
पहले से [OpenRouter](https://openrouter.ai) key हो। OpenRouter System One models को उसी `POST /v1/systemone`
path पर serve करता है जिस पर TypeSafe करता है, अपने API root से एक स्तर नीचे, इसलिए यह Jev तक का
documented route है, उसका कोई approximation नहीं:

```yml
- insert:
    - id: jev
      name: 'jevcore-dsh'
      config:
        provider: openrouter
        openRouterApiKeyRef: OPENROUTER_API_KEY
        model: jev-latest              # a bare `jev-*` id, or `typesafe/jev-1.13`
```

इस route तक official `@typesafe-ai/sdk` को अपनी OpenRouter key के साथ
`https://openrouter.ai/api` पर point करके पहुँचा जाता है — OpenRouter का अपना documented
integration, इसलिए sync में रखने के लिए कोई दूसरा client नहीं है।

OpenRouter route के बारे में दो बातें जानने योग्य हैं:

- **आपका state OpenRouter को जाता है, TypeSafe को नहीं।** एक अलग third party, अलग
  retention और logging के साथ। startup report ठीक इसी कारण endpoint का नाम बताती है — provider के
  नाम से destination का अनुमान लगाने के बजाय उसे पढ़ें।
- **यह एक cost लौटाता है**, जो TypeSafe का अपना route नहीं करता, इसलिए `usage.costUsd`
  यहाँ भरा होता है और वहाँ अनुपस्थित रहता है।

Model id System One का होना चाहिए। बिना prefix वाला `jev-latest` ही default है;
`typesafe/` किसी versioned id जैसे `typesafe/jev-1.13` पर स्वीकार किया जाता है, पर moving tag
पर नहीं — route `typesafe/jev-latest` स्वीकार नहीं करता। कोई भी अन्य
id किसी chat model को route हो जाता, जो ऐसा prose लौटाता जिसे यह plugin किसी decision के रूप में
interpret नहीं कर सकता, इसलिए इसे call से पहले अस्वीकार किया जाता है, call के बाद गलत पढ़े जाने के बजाय।

किसी भी तरह, credential पहले DSH की credential service से resolve होती है, फिर उस नाम के
environment variable से। यह हर call पर पढ़ी जाती है, इसलिए process चलते समय जोड़ी गई key उठा ली जाती है। यह
कभी log नहीं होती, कभी किसी tool से return नहीं होती, और कभी configuration में नहीं लिखी जाती।
हर route का अपना reference है (`apiKeyRef` और `openRouterApiKeyRef`) ताकि दोनों गलती से एक ही key साझा न कर सकें।

`@typesafe-ai/sdk` ही एकमात्र optional dependency है; plugin दोनों में से किसी के बिना भी
offline load और run होता है, और केवल आपके चुने हुए route के लिए वह एक चाहिए।

---

## Configuration

| Key | Default | अर्थ |
|---|---|---|
| `provider` | `mock` | `mock` (offline, deterministic, synthetic), `live` (TypeSafe), या `openrouter` |
| `apiKeyRef` | `TYPESAFE_API_KEY` | `live` route के लिए credential reference |
| `openRouterApiKeyRef` | `OPENROUTER_API_KEY` | `openrouter` route के लिए credential reference |
| `baseURL` | `https://api.typesafe.ai` | `live` route के लिए API root। Loopback के अलावा non-HTTPS अस्वीकार किया जाता है |
| `openRouterBaseURL` | `https://openrouter.ai/api` | `openrouter` route के लिए API root। वही नियम |
| `model` | `jev-latest` | हर request के साथ भेजा जाता है। OpenRouter route पर बिना prefix वाला default ही चलता है; `typesafe/` को किसी versioned id जैसे `typesafe/jev-1.13` की ज़रूरत होती है, और `typesafe/jev-latest` स्वीकार नहीं किया जाता |
| `logLevel` | `warn` | `silent` \| `warn` \| `info` \| `debug` |
| `minConfidence` | `0.7` | इससे नीचे किसी उत्तर पर कार्रवाई नहीं होती |
| `minProbability` | `0.6` | इससे नीचे किसी निर्णय पर कार्रवाई नहीं होती |
| `maxStateChars` | per feature | हर feature के लिए `state` cap बदल देता है। `0` का मतलब है "declared cap रखो" |
| `gates.safety` | `false` | Tool calls को dispatch से पहले judge करें |
| `gates.context` | `false` | बड़े, uninformative tool results रोक कर रखें |

Declared `state` caps तीन tools के लिए 16,000 characters हैं और safety
और context gates के लिए 8,000 / 6,000। `maxStateChars` इन सबको बदल देता है, और startup report declared के
बजाय effective value दिखाती है, इसलिए जो वह छापती है वही लागू होता है।

Gates एक bare boolean (`safety: false`) या `onUndecided` वाला object स्वीकार करते हैं: `ask` (default),
`allow`, या `deny`।

`ask` एक सवाल है, इसलिए उसे पूछने के लिए किसी की ज़रूरत होती है। जो deployment कोई approval service
compose नहीं करता, वह किसी इंसान तक बात नहीं बढ़ा सकता, और DeepSeek Harness तब उस call को चलाने के
बजाय अस्वीकार कर देता है: safety gate जिस-जिस tool से मेल खाता है, हर एक अस्वीकार हो जाता है, और
operator को यह plugin द्वारा सारे shell commands तोड़ देने जैसा लगता है।
[docs/approval.md](docs/approval.md) में तंत्र है, और plugin README deployment का नज़रिया देता है।

अज्ञात value को load पर अस्वीकार किया जाता है, key का नाम लेते हुए संदेश के साथ, बजाय इसके कि चुपचाप
अनदेखा कर दिया जाए — config की एक typo चुपचाप privacy posture नहीं बदलनी चाहिए।

---

## इसका उपयोग

### किसी दूसरे plugin से, बिना किसी model के

Service ही मुख्य surface है। एक decision model की बात ही यही है: routing या gating का
निर्णय एक model round-trip पर नहीं पड़ना चाहिए।

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

`result.answers` में probabilities और confidence होती हैं। उनके साथ क्या करना है यह आपके code का
काम है — एक स्पष्ट confidence floor वाला worked example `src/policy.ts` में देखें, जहाँ एक अनिश्चित
उत्तर `allow` के बजाय `ask` देता है।

### Model से

तीन tools, जान-बूझकर कम और orthogonal:

- **`jev_ask`** — एक state पर typed questions का batch।
- **`jev_rank`** — एक criterion के विरुद्ध candidates को score और sort करें, प्रति candidate एक question,
  एक ही round-trip में। Probabilities प्रति candidate स्वतंत्र judgments हैं, कोई distribution नहीं।
- **`jev_check`** — क्या यह evidence इस claim का समर्थन करता है? `supported`, `contradicted`,
  `conflicted`, `insufficient`, `undecided`, या `unknown` लौटाता है। Contradiction समर्थन से ऊपर है, क्योंकि जो evidence
  समर्थन और खंडन दोनों करता है वह एक conflict है, कोई कमज़ोर हाँ नहीं।

### एक bundled skill

Plugin एक skill register करता है, `typesafe-ai-dsh`, जो एक agent को सिखाती है कि Jev का
निर्णय कब सही tool है और कब एक category error है। यह skill registry के ज़रिए register होती है,
न कि किसी provider के scan करने के लिए एक directory के रूप में भेजी जाती है, इसलिए इसे इस बात पर कोई
dependency नहीं कि कोई profile अपनी skills कहाँ रखती है, और plugin हटने पर यह साफ़ तौर पर गायब हो जाती है।

इसका body `skills/typesafe-ai-dsh/SKILL.md` में रहता है और load पर पढ़ा जाता है,
embed नहीं किया जाता, इसलिए जिस file को कोई मनुष्य edit करता है वही file ship होती है। एक test दावा करता है
कि दोनों अलग नहीं हो सकतीं।

Registry एक **optional** dependency के रूप में declared है: जो profile skill subsystem
compose नहीं करती, उसे फिर भी service और तीन tools मिलते हैं, इस चेतावनी के साथ कि skill छोड़ दी गई।

### mock provider

`provider: mock` के साथ, हर उत्तर question और state के hash से निकाला जाता है, इसलिए tests
सटीक values assert कर सकते हैं और कोई socket नहीं खुलता। Synthetic results को तीन जगहों पर ऐसा label
किया जाता है: `provider: "mock"`, एक `mock/jev-synthetic` model name, और result पर एक `warning` field। एक mock
जिसे असली निर्णय समझ लिया जा सके, किसी भी mock न होने से बुरा होगा।

---

## स्थिति

क्या verified हुआ है और क्या नहीं, इसका ईमानदार हिसाब।

**Verified**
- तीन packages में 410 tests pass होते हैं (314 core, 66 DSH, 30 MCP), बिना network access और बिना
  `TYPESAFE_API_KEY`। CI उस variable को clear करता है और फिर भी suite के pass होने की अपेक्षा करता है।
- **OpenRouter route असली API के विरुद्ध verified है।** `pnpm --filter jevcore run
  probe:live` provider को चलाता है और `pnpm --filter jevcore-mcp run smoke:live` पूरे MCP
  surface को — transport, tool schemas, service और provider — असली System One models
  (`typesafe/jev-1.13-20260917`) के विरुद्ध चलाता है। तीन-primitive वाले batch ने 0.91 पर एक `noul`, 0.97 पर
  एक `choice`, और चार-स्तरीय rubric पर `1.05` का एक `score` लौटाया, usage के साथ
  `{ inputTokens: 469, outputTokens: 68, costUsd: 0.000019698 }` के रूप में reported। `jev_rank` ने
  एक credential runbook को billing guide से ऊपर रखा; `jev_check` ने `contradicted` लौटाया। दोनों scripts के लिए
  `OPENROUTER_API_KEY` चाहिए और वे CI से बाहर रखे गए हैं।
- **Payload shapes vendors की अपनी type definitions के विरुद्ध जाँचे जाते हैं।**
  `test/vendor-conformance.test.ts` इस project के question और answer types को दोनों SDKs पर pin करता है, इसलिए
  किसी भी दिशा में drift एक compile error है, न कि उस एकमात्र route पर कोई malformed request जो पैसा खर्च करता है
  और डेटा भेजता है। उसी जाँच ने यह पाया कि `score.criteria` को एक keyed map के रूप में भेजा जा रहा था
  जबकि API एक ordered array माँगता है — एक defect जिसे stubbed unit tests शुरू से पार कर गए थे।
  एक script भी है जो हमारे payloads को `alpha/decisions` route के लिए OpenRouter के प्रकाशित zod
  schemas के विरुद्ध parse करती थी; वह script और वह route दोनों अब नहीं हैं, क्योंकि
  OpenRouter provider अब उसी client के ज़रिए documented `/v1/systemone` path इस्तेमाल करता है जो TypeSafe
  इस्तेमाल करता है, जिसे conformance test पहले ही cover करता है।
- **Plugin एक चल रहे harness में activate होता है और उसके tools काम करते हैं।** Plugin row `active` बताती है;
  `jev_ask` ने mock के विरुद्ध 1 ms में `urgent=true (0.8307)` और `team=billing (0.5027)` लौटाया, और
  `jev_check` ने अपनी तीन probabilities के साथ `verdict="insufficient"` लौटाया। हर result में
  `provider: "mock"` और शून्य token usage था, इसलिए डिफ़ॉल्ट path ने कोई network call नहीं किया।
- **Bundled skill register होती है।** `typesafe-ai-dsh` session skill catalog में दिखती है।
- डिफ़ॉल्ट path कोई network call नहीं करता: plugin mount करते समय और service के ज़रिए उत्तर देते समय
  `globalThis.fetch` पर spy करके यह asserted किया गया है, और MCP runtime assemble करते समय भी।
- एक disabled gate **कोई** event listener register नहीं करता, और denied egress कभी provider तक नहीं पहुँचता।
- `Config` उस Standard Schema protocol को पूरा करता है जो Cordis plugin शुरू होने से पहले माँगता है।
- यहाँ इस्तेमाल हर DSH API (`ctx.provide`, `ctx.effect`, `tools.register`, `defineTool`,
  `tools/pre-execute`, `tools/post-execute`, `credentials.resolve`) इस्तेमाल से पहले installed
  runtime के विरुद्ध जाँचा गया, और payload types installed declaration files से आते हैं।

**Not verified, or known-broken**
- **TypeSafe route exercised है, पर हल्के रूप से।** `packages/core/scripts/probe-live.mjs`
  (`pnpm --filter jevcore run probe:typesafe`) असली API से तीन बातें पूछता है: दस claim/evidence
  जोड़े जिनका verdict पहले से ज्ञात है, एक ही प्रश्न छह बार, और `criteria: {true, false}` सीमा वाला
  एक noul। दो अलग runs सहमत हुए — समर्थन करता evidence 0.95, खंडन करता evidence 0.10,
  claim पर चुप रहने वाला evidence 0.03, और दोहराया गया प्रश्न 0.01 या उससे कम हिला।
  वह सीमा स्वीकार की गई। जो अब भी untested है वह request के चारों ओर की चीज़ें हैं,
  request स्वयं नहीं: असली account पर quota, rate-limit और entitlement व्यवहार।
- **जिस build पर यह अभी चल रहा है, उसमें `jev_ask` के description में एक भ्रष्ट dash है।** यह
  `branches on —?routing` पढ़ता है, जहाँ एक em dash और उसके बाद एक space होना चाहिए। कारण: development के
  शुरू में एक UTF-8 round-trip ने em dash के तीसरे byte को `?` से बदल दिया। यह disk पर ठीक है — चार
  occurrences, शून्य शेष, source और build output दोनों में पुष्ट — पर चल रहे process ने अपना module
  fix से पहले load किया था और restart के बिना उसे दोबारा पढ़ नहीं सकता। dash स्वयं cosmetic है,
  पर यह पुरानापन नहीं: उसी process के पास शुरू होने के बाद हुए हर fix भी नहीं हैं,
  जिसमें वह `band` field भी है जो 0.51 को settled हाँ के रूप में पढ़े जाने से रोकता है।
- MCP server को stdio पर एक असली MCP client द्वारा end to end चलाया गया है
  (`pnpm --filter jevcore-mcp run smoke`): handshake, tool discovery, तीन सफल calls, और एक
  invalid batch के लिए एक error result। इसे किसी अन्य third-party host द्वारा नहीं चलाया गया है।
- Live traffic पर gate व्यवहार। Gates synthetic answers और असली hook
  payload shapes के विरुद्ध tested हैं, पर कोई असली tool call end to end gate नहीं हुआ है।
- Context gate पहले ही खर्च हो चुका context वापस नहीं ला सकता। यह एक result को
  agent तक पहुँचने से रोकता है; यह पीछे जाकर कुछ prune नहीं करता, और इसके विपरीत दावा करने वाले किसी भी plugin का
  README संदेह के साथ पढ़ा जाना चाहिए।
- कोई long-running या adversarial testing नहीं। Redaction pattern-based है और किसी अनजानी
  secret shape को चूक जाएगी।

---

## Design notes

तीन निर्णय जिन्हें गलत करना आसान है और गलत करना महँगा:

**जो judge उत्तर नहीं दे सकता, उसका मतलब "allow" नहीं होना चाहिए।** अगर Jev तक पहुँच न हो, या वह
confidence floor से नीचे उत्तर दे, तो gates `onUndecided` के ज़रिए तय होते हैं, जिसका default `ask` है। Fail-open
व्यवहार पाने का एकमात्र तरीका उसे configure करना है। Context gate जान-बूझकर अपवाद है: यह
बिना शर्त fail open होता है, क्योंकि एक असली tool result को किसी phantom "irrelevant" verdict से खोना
एक uninformative result रखने से बुरा है।

**Model जो कुछ भी कह सकता है, वह gate नहीं बदलता।** कोई tool gate configuration, thresholds, या
scope उजागर नहीं करता। जिस guard को guarded process खुद reconfigure कर सके, वह guard नहीं है।

**एक probability अनुमति नहीं है।** Jev numbers लौटाता है; `src/policy.ts` उन्हें locally configured
thresholds के विरुद्ध `allow`/`ask`/`deny` में बदलता है। जो उत्तर declared criteria के बाहर कोई value बताता है
वह `invalid` है और deny करता है — एक typed decision model की गारंटी यही है कि वह कोई
undeclared value return नहीं कर सकता, इसलिए violation का मतलब है कि ऊपर कहीं कुछ गलत है।

## Development

```sh
pnpm install
pnpm run check      # typecheck + tests + build
pnpm test           # tests only
```

कोई test credential या network connection नहीं माँगता, और CI इसे `TYPESAFE_API_KEY` clear करके
चलाकर लागू करता है।

## PerryLink DSH Plugin Family

यह प्रोजेक्ट [PerryLink](https://github.com/PerryLink) के **87 सक्रिय रूप से अनुरक्षित** DeepSeek Harness प्लगइन में से एक है। पूरा परिवार **95** प्लगइन है — **5 फ़्रोज़न**, **3 सेवानिवृत्त** — और नीचे संक्षिप्त रखा गया है ताकि हर README की पहली स्क्रीन छोटी रहे। हर पंक्ति देखने के लिए इसे खोलें; कारण स्थिति कॉलम में है।

<details>
<summary>सभी 95 प्लगइन खोलें</summary>

| प्लगइन | एक पंक्ति | स्थिति |
|---|---|---|
| **[dsh-aqua-input-check](https://github.com/PerryLink/dsh-aqua-input-check)** | 水产养殖投入品记录核对（按投入品用量、休药期与起捕间隔核对记录自洽，仅提示差异，不作出定性结论） |  |
| **[dsh-archive-check](https://github.com/PerryLink/dsh-archive-check)** | 档案归档完整性与保管期限核对（依据《档案法》及配套规定，仅提示差异，不作出定性结论） |  |
| **[dsh-auto-review](https://github.com/PerryLink/dsh-auto-review)** | Second-model auto-review on the approval chain, fail-closed by default |  |
| **[dsh-autotier](https://github.com/PerryLink/dsh-autotier)** | Automatic strong/cheap model-tier routing with deterministic risk guards and a `/tier` command |  |
| **[dsh-background-agents](https://github.com/PerryLink/dsh-background-agents)** | Durable background child agents with a Web UI sidebar, messaging and interrupt | 🚫 सेवानिवृत्त — रिपॉज़िटरी README देखें |
| **[dsh-bid-ca-precheck](https://github.com/PerryLink/dsh-bid-ca-precheck)** | 投标文件符合性预检（按招标文件逐条核对响应情况，仅提示差异，不作出定性结论） |  |
| **[dsh-bid-qual-check](https://github.com/PerryLink/dsh-bid-qual-check)** | 投标人资格条件核对（按资格条件与证明材料核对逐条响应，仅提示差异，不作出定性结论） |  |
| **[dsh-budget](https://github.com/PerryLink/dsh-budget)** | Cost governance for DeepSeek Harness: budgets, carbon, and latency in one panel. | 🧊 फ़्रोज़न — रिपॉज़िटरी README देखें |
| **[dsh-cert-mcp](https://github.com/PerryLink/dsh-cert-mcp)** | Read-only MCP server exposing the certification registry: grades, snapshots and five-dimension evidence |  |
| **[dsh-checkpoint-rewind](https://github.com/PerryLink/dsh-checkpoint-rewind)** | Claude Code /rewind-equivalent: snapshots, session forks, one-shot restore |  |
| **[dsh-claude-move](https://github.com/PerryLink/dsh-claude-move)** | Migrate Claude Code sessions, memory, skills and CLAUDE.md into DSH | 🧊 फ़्रोज़न — रिपॉज़िटरी README देखें |
| **[dsh-click](https://github.com/PerryLink/dsh-click)** | Cross-platform native desktop control for DeepSeek Harness — Windows first. |  |
| **[dsh-composer-history](https://github.com/PerryLink/dsh-composer-history)** | Terminal-style input history for the web composer: arrows, Ctrl+R search |  |
| **[dsh-contract-stance](https://github.com/PerryLink/dsh-contract-stance)** | 合同条款立场台账核对（按立场、风险等级与退让底线核对台账自洽，仅提示差异，不作出定性结论） |  |
| **[dsh-customs-doc-check](https://github.com/PerryLink/dsh-customs-doc-check)** | 报关单证一致性核对（按公开的报关单填制规范核对单证间字段一致性，仅提示差异，不作出定性结论） |  |
| **[dsh-data-quality](https://github.com/PerryLink/dsh-data-quality)** | Dataset quality checks and citation cross-checks (the optional numeric bridge consumed here) |  |
| **[dsh-defend](https://github.com/PerryLink/dsh-defend)** | Prompt-injection, jailbreak, and secret-leak defense for DeepSeek Harness. | 🧊 फ़्रोज़न — रिपॉज़िटरी README देखें |
| **[dsh-demurrage-ledger](https://github.com/PerryLink/dsh-demurrage-ledger)** | 滞箱费台账核对（按免箱期与费率核对超期天数与金额的自洽性，仅提示差异，不作出定性结论） |  |
| **[dsh-doublecheck](https://github.com/PerryLink/dsh-doublecheck)** | Engineering-discipline guard: requirements grill, test gates, adversary review |  |
| **[dsh-draw](https://github.com/PerryLink/dsh-draw)** | Unified static-image generation routing for DeepSeek Harness. | 🧊 फ़्रोज़न — रिपॉज़िटरी README देखें |
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
| **[dsh-reach](https://github.com/PerryLink/dsh-reach)** | Multi-channel approval/question bridge: WeChat/Telegram/Feishu, session console | 🧊 फ़्रोज़न — रिपॉज़िटरी README देखें |
| **[dsh-repair-order-qc](https://github.com/PerryLink/dsh-repair-order-qc)** | 维修工单结算核对（按项目金额、配件工时合计与结算总额核对算术自洽，仅提示差异，不作出定性结论） |  |
| **[dsh-research-report](https://github.com/PerryLink/dsh-research-report)** | Verifiable research-report engine: content-addressed evidence ledger and sealed versions |  |
| **[dsh-review-reply-check](https://github.com/PerryLink/dsh-review-reply-check)** | 审稿意见逐条回应覆盖核对（按意见与回应一一对应核对覆盖完整性，仅提示差异，不作出定性结论） |  |
| **[dsh-rulefile-check](https://github.com/PerryLink/dsh-rulefile-check)** | 规则库文件自检核对（按条款引用纪律与效力上限核对规则库自身合规，仅提示差异，不作出定性结论） |  |
| **[dsh-safety-brief-check](https://github.com/PerryLink/dsh-safety-brief-check)** | 安全技术交底记录要素齐备性与签字闭环核对（依据公开的安全生产法规与检查标准，仅提示差异，不作出定性结论） |  |
| **[dsh-score](https://github.com/PerryLink/dsh-score)** | Multi-dimensional quality scoring for DeepSeek Harness plugins. |  |
| **[dsh-session-pin](https://github.com/PerryLink/dsh-session-pin)** | Pin sessions in the Web sidebar with durable ordering | 🚫 सेवानिवृत्त — रिपॉज़िटरी README देखें |
| **[dsh-session-sync](https://github.com/PerryLink/dsh-session-sync)** | Cross-device session sync for DeepSeek Harness — a dedicated git mirror of your session store. |  |
| **[dsh-site-log-check](https://github.com/PerryLink/dsh-site-log-check)** | 监理日志跨日连续性与旁站覆盖提示（依据 GB/T 50319-2013 等公开文件，仅提示差异，不作出定性结论） |  |
| **[dsh-skill-pack-security](https://github.com/PerryLink/dsh-skill-pack-security)** | Security-audit skill pack: secret scan, dependency and supply-chain review |  |
| **[dsh-soe-decision-check](https://github.com/PerryLink/dsh-soe-decision-check)** | 三重一大决策台账核对（按前置研究、会议审议与决议记录核对程序留痕，仅提示差异，不作出定性结论） |  |
| **[dsh-soilwater-check](https://github.com/PerryLink/dsh-soilwater-check)** | 土壤与地下水监测台账核对（按点位、监测项目、限值与超标判定核对台账自洽，仅提示差异，不作出定性结论） |  |
| **[dsh-sop-sync-check](https://github.com/PerryLink/dsh-sop-sync-check)** | 作业规程与 FMEA／控制计划一致性核对（按编号与版本核对三份文件是否同步，仅提示差异，不作出定性结论） |  |
| **[dsh-spc-gbt-adapter](https://github.com/PerryLink/dsh-spc-gbt-adapter)** | 控制图常数与过程能力指数核对（按 GB/T 4091 的常规控制图常数表核对控制限与 Cp/Cpk 的自洽性，仅提示差异，不作出定性结论） |  |
| **[dsh-talk](https://github.com/PerryLink/dsh-talk)** | Voice-first session loop for DeepSeek Harness: talk to it, hear it answer. |  |
| **[dsh-team-rooms](https://github.com/PerryLink/dsh-team-rooms)** | Cross-session team rooms: shared message bus, task board and timeline | 🚫 सेवानिवृत्त — रिपॉज़िटरी README देखें |
| **[dsh-tender-extract](https://github.com/PerryLink/dsh-tender-extract)** | 招标文件条款摘录核对（按出处与原文逐字核对摘录完整性，仅提示差异，不作出定性结论） |  |
| **[dsh-tender-matrix](https://github.com/PerryLink/dsh-tender-matrix)** | 评标因素评分矩阵核对（按分值上限与合计核对矩阵自洽，仅提示差异，不作出定性结论） |  |
| **[dsh-test-drive](https://github.com/PerryLink/dsh-test-drive)** | Isolated install-and-smoke test drives for DeepSeek Harness plugins. |  |
| **[dsh-ticktick](https://github.com/PerryLink/dsh-ticktick)** | TickTick/Dida365 task bridge: session-header panel + 11 tools |  |
| **[dsh-translate](https://github.com/PerryLink/dsh-translate)** | Vendor parameter translation and deterministic JSON repair for DeepSeek Harness. |  |
| **[dsh-warranty-calc](https://github.com/PerryLink/dsh-warranty-calc)** | 质保期与索赔金额核对（按质保期月数与里程、索赔金额算式核对自洽，仅提示差异，不作出定性结论） |  |

</details>

</details>

## License

[Apache License 2.0](LICENSE) © 2026 jevcore contributors

TypeSafe, Jev, और System One, TypeSafe AI के trademarks हैं। यह project एक स्वतंत्र
integration है और TypeSafe AI से affiliated नहीं है और न ही उसके द्वारा endorsed है।
