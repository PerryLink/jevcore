# jevcore

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) और किसी भी अन्य MCP host के लिए
TypeSafe [Jev](https://typesafe.ai)।

Jev कोई chat model नहीं है। यह typed questions — `noul` (हाँ/नहीं), `choice`, `score` — का उत्तर देता है और
calibrated probabilities लौटाता है। यह prose नहीं लिखता, और उससे prose माँगना एक category error है। यह project
एक agent को ठीक वही surface देता है, और उससे अधिक कुछ नहीं।

**डिफ़ॉल्ट रूप से offline। egress का खुलासा। कुछ भी डिफ़ॉल्ट रूप से चालू नहीं।**

---

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

## License

[Apache License 2.0](LICENSE) © 2026 jevcore contributors

TypeSafe, Jev, और System One, TypeSafe AI के trademarks हैं। यह project एक स्वतंत्र
integration है और TypeSafe AI से affiliated नहीं है और न ही उसके द्वारा endorsed है।
