# jevcore

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) के लिए और किसी भी अन्य
MCP host के लिए TypeSafe [Jev](https://typesafe.ai)।

Jev कोई chat model नहीं है। यह typed सवालों के जवाब देता है — `noul` (हाँ/नहीं), `choice`, `score` — और
calibrated probabilities लौटाता है। यह prose नहीं लिखता, और उससे ऐसा माँगना एक category error है। यह project
एक agent को ठीक वही सतह देता है, और उससे कुछ नहीं।

**डिफ़ॉल्ट रूप से ऑफ़लाइन। Egress का खुलासा। कुछ भी डिफ़ॉल्ट रूप से चालू नहीं।**

---

## तीन packages, एक निर्णय-परत

| Package | यह क्या है | इसे कब इस्तेमाल करें |
|---|---|---|
| [`jevcore`](packages/core) | निर्णय। DeepSeek Harness या Cordis से कुछ भी import नहीं करता। | आप Jev को किसी सादे script, service, या अपने harness में चाहते हैं |
| [`jevcore-dsh`](packages/dsh) | DSH plugin: एक service, तीन tools, दो opt-in gates | आप DeepSeek Harness चला रहे हैं |
| [`jevcore-mcp`](packages/mcp) | वही तीन tools MCP पर, एक stdio binary के साथ | आपका host MCP बोलता है पर DSH नहीं है |

Adapters जानबूझकर पतले हैं। `packages/dsh` में चार files हैं: यह tool schemas घोषित करता है और
hook payloads का अनुवाद करता है। निर्णय जैसा हर कुछ — primitives, providers, egress
contract, policy, gates — core में रहता है, इसलिए कोई नया adapter उन गारंटियों से
भटक नहीं सकता जो बाकी देते हैं।
इन तीनों में एक runtime आवश्यकता अलग है: `jevcore-dsh` harness का अनुसरण करता है और उसे
Node `^22.19.0 || >=24.0.0` चाहिए, जबकि `jevcore` और `jevcore-mcp` को `>=20` चाहिए।

---

## यह क्यों मौजूद है

2026-09-17 और 09-20 के बीच, उन्नीस plugins आए जो Jev को DSH में जोड़ते हैं। उनके source की
auditing में एक एकरूप पैटर्न मिला: जिस module पर *guard*, *gate*, या *warden* का लेबल था, वही module
prompts, tool arguments, और file contents किसी तीसरे पक्ष को भेज रहा था, और README में आम तौर पर यह
नहीं लिखा था। कई डिफ़ॉल्ट रूप से enabled थे। एक gate को उसी model द्वारा reconfigure किया जा सकता था
जिसकी वह रखवाली कर रहा था।

यह project वही विचार है, पर उन failure modes को डिज़ाइन से बाहर किए हुए:

| Property | यहाँ इसकी गारंटी कैसे है |
|---|---|
| जब तक आप न कहें, कोई network call नहीं | डिफ़ॉल्ट provider एक ऑफ़लाइन mock है; live रास्ते को `provider: live` और एक resolved credential — दोनों चाहिए |
| हर transmission पहले ही नामित | प्रति सुविधा एक startup log line: `off` या `SENDS <feature> { fields }` |
| Disabled gates कुछ register नहीं करते | Policy से नहीं, test से सत्यापित — एक disabled gate कोई event listener जोड़ता ही नहीं |
| Model अपनी ही सीमाएँ नहीं बढ़ा सकता | कोई tool gate configuration उजागर नहीं करता |
| जो judge जवाब नहीं दे सकता, वह कभी "allow" नहीं होता | Undecided स्पष्ट config से तय होता है, जिसका डिफ़ॉल्ट `ask` है |

---

## Egress अनुबंध

यही वह हिस्सा है जो install करने से पहले पढ़ने लायक है।

Transmission हर सुविधा के हिसाब से तय होता है, और हर सुविधा का डिफ़ॉल्ट बंद है। Plugin load होते समय
अपना अनुबंध स्वयं प्रिंट करता है:

```
[jevcore] provider=mock  endpoint=none  egress=OFF  (no network calls will be made; every answer is synthetic)
[jevcore] ready - provider=mock - gates: safety=off context=off
```

`provider: live` और हर सुविधा enabled होने पर वही रिपोर्ट स्पष्ट कर देती है कि बाहर क्या जाता है:

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

| Feature | डिफ़ॉल्ट रूप से बंद? | यह क्या भेजती है |
|---|---|---|
| `tool:jev_ask` | तब चलती है जब model इसे call करता है | redaction के बाद वे arguments जो model ने पास किए |
| `tool:jev_rank` | तब चलती है जब model इसे call करता है | query और हर candidate |
| `tool:jev_check` | तब चलती है जब model इसे call करता है | claim और उसका evidence |
| `gate:safety` | **हाँ — स्पष्ट opt-in** | tool का नाम, उसके arguments, workspace root |
| `gate:context` | **हाँ — स्पष्ट opt-in** | एक बड़ा tool result जो agent को अभी मिला है |

Tools तभी transmit करते हैं जब model उन्हें call करने का चुनाव करता है, जो transcript में दिखता है। Gates
हर मेल खाते tool call पर चलते, जो दिखता नहीं है, इसलिए वे opt-in हैं।

### Redaction, और उसकी ईमानदार सीमा

कुछ भी भेजे जाने से पहले, `src/redact.ts` दो passes चलाता है: संवेदनशील field names
(`password`, `token`, `apiKey`, `authorization`, …) के नीचे की values पूरी तरह बदल दी जाती हैं, और मुक्त पाठ
तक पहुँच चुकी secret-आकार की strings pattern-match की जाती हैं (`Bearer …`, `sk-…`, `ts_live_…`, AWS/GitHub/Google
key shapes, JWTs, private-key headers, connection strings में credentials)।

यह एक शमन है, अनुमति नहीं। कोई secret जो किसी अपरिचित key name के नीचे बैठा है *और* किसी
ज्ञात shape से मेल नहीं खाता, वह पार निकल जाएगा। अगर यह संभावना आपके workload के लिए अस्वीकार्य है, तो
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

`packages/dsh`, `jevcore` को नाम से import करता है, इसलिए एक checkout के लिए core का profile से
resolvable होना भी ज़रूरी है (`add /absolute/path/to/jevcore/packages/core`)।

फिर पुष्टि करें कि row activate हुआ — plugin list में `jev` को `active` दिखना चाहिए,
`failed` नहीं — और log में startup report देखें।

### एक MCP server के रूप में

MCP बोलने वाले host के लिए, वही तीन tools stdio पर उपलब्ध हैं:

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

दोनों में से कोई key न होने पर यह ऑफ़लाइन mock पर ही रहता है। Plugin के विपरीत, MCP server
अपना credential startup पर एक बार resolve करता है, इसलिए `JEV_PROVIDER=live` के साथ key न होना
हर call पर आश्चर्य नहीं बल्कि एक startup error है।

इसकी egress report **stderr** पर जाती है, कभी stdout पर नहीं — stdio transport पर stdout
ही protocol channel है, और वहाँ एक भी भटकी हुई line stream को भ्रष्ट कर देगी।

### Live पर जाना

Jev तक पहुँचने के दो रास्ते हैं। दोनों वही models call करते हैं और दोनों वही
typed उत्तर लौटाते हैं; अंतर यह है कि आपका credential किसके पास रहता है और आपका state किसके servers देखते हैं।

**सीधे TypeSafe** — यह इस्तेमाल करें अगर आपके पास
[console.typesafe.ai](https://console.typesafe.ai/settings/keys) से key है:

```yml
- insert:
    - id: jev
      name: 'jevcore-dsh'
      config:
        provider: live
        apiKeyRef: TYPESAFE_API_KEY   # a reference, never the key
        model: jev-latest
```

**OpenRouter के माध्यम से** — यह इस्तेमाल करें अगर TypeSafe key अव्यावहारिक है और आपके पास
पहले से [OpenRouter](https://openrouter.ai) key है। OpenRouter, System One models को उसी `POST /v1/systemone` पथ पर
host करता है जो TypeSafe करता है, अपने ही API root से एक स्तर नीचे, इसलिए यह Jev तक का प्रलेखित
मार्ग है, कोई अनुमान नहीं:

```yml
- insert:
    - id: jev
      name: 'jevcore-dsh'
      config:
        provider: openrouter
        openRouterApiKeyRef: OPENROUTER_API_KEY
        model: jev-latest              # a bare `jev-*` id, or `typesafe/jev-1.13`
```

OpenRouter route के बारे में दो बातें जानने लायक:

- **आपका state OpenRouter को जाता है, TypeSafe को नहीं।** एक अलग तीसरा पक्ष, अलग retention
  और logging के साथ। Startup report ठीक इसी कारण endpoint का नाम बताती है — उसे पढ़ें, और
  provider के नाम से गंतव्य का अनुमान न लगाएँ।
- **यह एक cost लौटाता है**, जो TypeSafe का अपना route नहीं लौटाता, इसलिए `usage.costUsd` यहाँ
  भरा होता है और वहाँ अनुपस्थित रहता है।

Model id एक System One वाला ही होना चाहिए। बिना prefix वाला `jev-latest` ही default है;
`typesafe/` किसी versioned id जैसे `typesafe/jev-1.13` पर स्वीकार किया जाता है, पर moving tag
पर नहीं — route `typesafe/jev-latest` स्वीकार नहीं करता। कोई भी अन्य id chat
model को route हो जाता, जो ऐसा prose लौटाता है जिसे यह plugin एक निर्णय के रूप में नहीं पढ़ सकता, इसलिए इसे
call से पहले अस्वीकार कर दिया जाता है, बाद में गलत पढ़े जाने के बजाय।

किसी भी तरह, credential पहले DSH की credential service से resolve किया जाता है,
फिर उस नाम के environment variable से। यह प्रति call पढ़ा जाता है, इसलिए process चलते समय जोड़ी गई key
भी उठा ली जाती है। यह कभी log नहीं होता, किसी tool से कभी वापस नहीं लौटाया जाता, और कभी configuration में
नहीं लिखा जाता। हर route का अपना reference है
(`apiKeyRef` और `openRouterApiKeyRef`) ताकि दोनों गलती से एक ही key साझा न कर सकें।

`@typesafe-ai/sdk` एकमात्र optional dependency है; plugin इसके बिना भी load होकर ऑफ़लाइन चलता है, और
इसकी ज़रूरत केवल उस route के लिए होती है जो आप चुनते हैं।

---

## Configuration

| Key | Default | Meaning |
|---|---|---|
| `provider` | `mock` | `mock` (ऑफ़लाइन, deterministic, synthetic), `live` (TypeSafe), या `openrouter` |
| `apiKeyRef` | `TYPESAFE_API_KEY` | `live` route के लिए credential reference |
| `openRouterApiKeyRef` | `OPENROUTER_API_KEY` | `openrouter` route के लिए credential reference |
| `baseURL` | `https://api.typesafe.ai` | `live` route के लिए API root। Non-HTTPS अस्वीकार किया जाता है, सिवाय loopback पर |
| `openRouterBaseURL` | `https://openrouter.ai/api` | `openrouter` route के लिए API root। वही नियम |
| `model` | `jev-latest` | हर request के साथ भेजा जाता है। OpenRouter route पर बिना prefix वाला default ही चलता है; `typesafe/` को किसी versioned id जैसे `typesafe/jev-1.13` की ज़रूरत होती है, और `typesafe/jev-latest` स्वीकार नहीं किया जाता |
| `logLevel` | `warn` | `silent` \| `warn` \| `info` \| `debug` |
| `minConfidence` | `0.7` | इससे नीचे किसी उत्तर पर कार्रवाई नहीं की जाती |
| `minProbability` | `0.6` | इससे नीचे किसी निर्णय पर कार्रवाई नहीं की जाती |
| `maxStateChars` | प्रति सुविधा | हर सुविधा के लिए `state` cap बदल देता है। `0` का अर्थ है "घोषित cap रखो" |
| `gates.safety` | `false` | dispatch से पहले tool calls का निर्णय करें |
| `gates.context` | `false` | बड़े, निरर्थक tool results रोकें |

घोषित `state` caps तीनों tools के लिए 16,000 characters हैं और safety
और context gates के लिए 8,000 / 6,000। `maxStateChars` इन सबको बदल देता है, और startup report घोषित मान के बजाय
प्रभावी मान दिखाती है, इसलिए जो वह प्रिंट करती है वही लागू होता है।

Gates एक सादा boolean (`safety: false`) स्वीकार करते हैं या `onUndecided` वाला object: `ask` (डिफ़ॉल्ट),
`allow`, या `deny`।

कोई अपरिचित value load पर key का नाम बताते हुए अस्वीकार कर दी जाती है, चुपचाप
अनदेखी नहीं की जाती — एक config typo को privacy posture चुपचाप नहीं बदलनी चाहिए।

---

## इसे इस्तेमाल करना

### किसी अन्य plugin से, बिना कोई model बीच में

Service ही मुख्य सतह है। एक decision model का यही उद्देश्य है: एक routing या gating
निर्णय पर model round-trip खर्च नहीं होना चाहिए।

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
काम है — एक स्पष्ट confidence floor वाला काम का उदाहरण `src/policy.ts` में देखें, जहाँ एक अनिश्चित
उत्तर `ask` के बजाय `allow` उत्पन्न करता है।

### Model से

तीन tools, जानबूझकर कम और orthogonal:

- **`jev_ask`** — एक state पर typed सवालों का batch।
- **`jev_rank`** — एक criterion पर candidates को score और sort करें, प्रति candidate एक सवाल एक
  ही round-trip में। Probabilities प्रति-candidate स्वतंत्र निर्णय हैं, कोई distribution नहीं।
- **`jev_check`** — क्या यह evidence इस claim का समर्थन करता है? `supported`, `contradicted`,
  `conflicted`, `insufficient`, `undecided`, या `unknown` लौटाता है। Contradiction, support से ऊपर है, क्योंकि जो evidence
  समर्थन और खंडन दोनों करता है वह एक conflict है, कोई कमज़ोर हाँ नहीं।

### एक bundled skill

Plugin एक skill register करता है, `typesafe-ai-dsh`, जो agent को सिखाती है कि Jev का
निर्णय कब सही tool है और कब एक category error है। यह skill registry के माध्यम से register होती है,
किसी provider के scan करने के लिए directory के रूप में ship नहीं की जाती, इसलिए इसे इस बात पर कोई निर्भरता नहीं
चाहिए कि कोई profile अपनी skills कहाँ रखती है, और plugin हटने पर यह साफ़-सुथरे ढंग से गायब हो जाती है।

इसका body `skills/typesafe-ai-dsh/SKILL.md` में रहता है और embed होने के बजाय load पर पढ़ा जाता है,
इसलिए जिस file को कोई इंसान edit करता है वही ship होती है। एक test assert करता है
कि दोनों भटक नहीं सकतीं।

Registry एक **optional** dependency के रूप में घोषित है: जो profile skill subsystem को
compose नहीं करती, उसे भी service और तीनों tools मिलते हैं, इस चेतावनी के साथ कि skill छोड़ दी गई।

### Mock provider

`provider: mock` के साथ, हर उत्तर प्रश्न और state के hash से निकाला जाता है, इसलिए tests ठीक-ठीक
values assert कर सकते हैं और कोई socket नहीं खुलता। Synthetic नतीजे तीन जगह वैसे ही लेबल होते हैं:
`provider: "mock"`, एक `mock/jev-synthetic` model नाम, और result पर एक `warning` field। ऐसा mock
जिसे असली निर्णय समझ लिया जा सके, बिना mock के होने से भी बुरा होगा।

---

## Status

क्या सत्यापित हुआ है और क्या नहीं, इसका ईमानदार हिसाब।

**Verified**
- तीन packages में 410 tests पास होते हैं (314 core, 66 DSH, 30 MCP), बिना network access और बिना
  `TYPESAFE_API_KEY`। CI उस variable को clear करता है और फिर भी suite के पास होने की अपेक्षा करता है।
- **OpenRouter route असली API के सामने सत्यापित है।** `pnpm --filter jevcore run
  probe:live` and `pnpm --filter jevcore-mcp run smoke:live` दोनों ने असली System One
  models के सामने जवाब दिए। दर्ज नतीजों के लिए root README का status section देखें।
- **Plugin एक चल रहे harness में activate होता है और उसके tools काम करते हैं।** Plugin row `active`
  बताती है; `jev_ask` ने mock के सामने 1 ms में `urgent=true (0.8307)` और `team=billing (0.5027)` लौटाया, और
  `jev_check` ने अपनी तीन probabilities के साथ `verdict="insufficient"` लौटाया। हर result में
  `provider: "mock"` और शून्य token usage था, इसलिए डिफ़ॉल्ट रास्ते ने कोई network call नहीं किया।
- **Bundled skill register होती है।** `typesafe-ai-dsh` session skill catalog में दिखती है।
- डिफ़ॉल्ट रास्ता कोई network call नहीं करता: यह plugin mount करते समय और service के ज़रिए जवाब देते समय
  `globalThis.fetch` पर spy लगाकर assert किया गया, और MCP runtime assemble करते समय भी।
- एक disabled gate **कोई** event listener register नहीं करता, और denied egress कभी provider तक नहीं पहुँचता।
- `Config` उस Standard Schema protocol को पूरा करता है जो Cordis plugin शुरू होने से पहले माँगता है।
- यहाँ इस्तेमाल हुई हर DSH API (`ctx.provide`, `ctx.effect`, `tools.register`, `defineTool`,
  `tools/pre-execute`, `tools/post-execute`, `credentials.resolve`) इस्तेमाल से पहले installed
  runtime के सामने जाँची गई, और payload types installed declaration files से आते हैं।

**Not verified, or known-broken**
- **TypeSafe route कभी असली API के सामने नहीं चलाया गया।** कोई TypeSafe credential
  उपलब्ध नहीं था, इसलिए `LiveProvider` एक injected stub के सामने और vendor की type
  definitions के सामने covered है — जो असली call से कमज़ोर है। दोनों routes वही primitives लेते हैं, इसलिए एक TypeSafe key के
  बिना बदलाव काम करने की *अपेक्षा* है; वह एक अपेक्षा है, कोई प्रेक्षण नहीं।
- **जो build अभी चल रहा है उस पर `jev_ask` का description एक भ्रष्ट dash लिए हुए है।** वह
  `branches on —?routing` पढ़ता है, जहाँ em dash के बाद एक space होना चाहिए। कारण: development में शुरुआत में एक UTF-8 round-trip
  ने em dash के तीसरे byte को `?` से बदल दिया। यह disk पर ठीक है — चार
  occurrences, शून्य शेष, source और build output दोनों में पुष्ट — पर चल रहे process ने अपना module
  fix से पहले load कर लिया था और restart के बिना उसे दोबारा नहीं पढ़ सकता। केवल cosmetic; यह
  किसी व्यवहार को नहीं बदलता।
- MCP server को एक असली MCP client ने stdio पर end to end चलाया है
  (`pnpm --filter jevcore-mcp run smoke`): handshake, tool discovery, तीन सफल calls, और एक
  invalid batch के लिए एक error result। इसे किसी अन्य तीसरे पक्ष के host ने नहीं चलाया।
- Live traffic पर gate व्यवहार। Gates synthetic उत्तरों और असली hook
  payload shapes के सामने tested हैं, पर कोई असली tool call end to end gated नहीं हुआ।
- Context gate पहले ही खर्च हो चुका context वापस नहीं ला सकता। यह एक result को
  agent तक पहुँचने से रोकता है; यह पीछे जाकर कुछ भी prune नहीं करता, और जो कोई plugin इसके विपरीत दावा करता है
  उसका README संदेह के साथ पढ़ा जाना चाहिए।
- कोई long-running या adversarial testing नहीं। Redaction pattern-आधारित है और एक अपरिचित
  secret shape को चूक जाएगी।

---

## Design notes

तीन निर्णय जिन्हें गलत करना आसान है और गलत करना महँगा:

**जो judge जवाब नहीं दे सकता, उसका अर्थ "allow" नहीं होना चाहिए।** अगर Jev पहुँच से बाहर है, या
confidence floor से नीचे जवाब देता है, तो gates `onUndecided` से तय होते हैं, जिसका डिफ़ॉल्ट `ask` है। Fail-open
व्यवहार पाने का एकमात्र तरीका उसे configure करना है। Context gate जानबूझकर अपवाद है: यह बिना शर्त
fail open होता है, क्योंकि एक असली tool result को किसी काल्पनिक "irrelevant" verdict की भेंट चढ़ाना एक निरर्थक
result रखने से भी बुरा है।

**Model जो कुछ भी कह सकता है, वह gate को नहीं बदलता।** कोई tool gate configuration, thresholds, या
scope उजागर नहीं करता। जिस guard को guarded process खुद reconfigure कर सके, वह guard नहीं है।

**Probability अनुमति नहीं है।** Jev संख्याएँ लौटाता है; `src/policy.ts` उन्हें स्थानीय रूप से configured thresholds के
सामने `allow`/`ask`/`deny` में बदलता है। ऐसा उत्तर जो घोषित criteria के बाहर कोई value बताता है, `invalid` है और deny करता है —
typed decision model की गारंटी यही है कि वह कोई अपघोषित value नहीं लौटा सकता, इसलिए उल्लंघन का अर्थ है कि
upstream में कुछ गड़बड़ है।

## Development

```sh
pnpm install
pnpm run check      # typecheck + tests + build
pnpm test           # tests only
```

किसी test को किसी credential या network connection की ज़रूरत नहीं होती, और CI इसे
`TYPESAFE_API_KEY` clear करके चलाकर लागू करता है।

## License

[Apache License 2.0](LICENSE) © 2026 jevcore contributors

TypeSafe, Jev, और System One, TypeSafe AI के trademarks हैं। यह project एक स्वतंत्र
integration है और TypeSafe AI से संबद्ध नहीं है और न ही उसके द्वारा अनुमोदित है।
