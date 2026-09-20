# jevcore-mcp

Model Context Protocol पर TypeSafe [Jev](https://typesafe.ai)।

Jev कोई chat model नहीं है। यह typed सवालों के जवाब देता है — `noul` (हाँ/नहीं), `choice`,
`score` — और calibrated probabilities लौटाता है। यह prose नहीं लिखता, और
उससे ऐसा माँगना एक category error है। यह server ठीक वही सतह उजागर करता है।

**डिफ़ॉल्ट रूप से ऑफ़लाइन। Egress का खुलासा। कुछ भी डिफ़ॉल्ट रूप से चालू नहीं।**

## Install

```sh
npx -y jevcore-mcp
```

इसे अपने host के साथ एक stdio MCP server के रूप में register करें। DeepSeek Harness के लिए, वह
एक configuration-only bundle है जिसका patch harness का MCP client insert करता है:

```yml
- insert:
    - id: jev-mcp
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: jev
        transport: stdio
        command: npx
        args: ['-y', 'jevcore-mcp']
        failOnStartupError: true
```

## Configuration

| Variable | असर |
|---|---|
| `TYPESAFE_API_KEY` | मौजूद होने पर TypeSafe route चुनता है |
| `OPENROUTER_API_KEY` | मौजूद होने पर और कोई TypeSafe key न होने पर OpenRouter route चुनता है |
| `JEV_PROVIDER` | `mock`, `live`, या `openrouter` — ऊपर की heuristic को override करता है |
| `TYPESAFE_MODEL` / `OPENROUTER_MODEL` | चुने गए route के लिए model id |
| `TYPESAFE_BASE_URL` / `OPENROUTER_BASE_URL` | चुने गए route के लिए API root |

दो routes एक ही models तक पहुँचते हैं। TypeSafe उन्हें सीधे serve करता है; OpenRouter उन्हें
अपने ही Decisions route के पीछे host करता है, जो तब रास्ता है जब TypeSafe key
अव्यावहारिक हो। इनमें अंतर यह है कि आपका state किसके servers देखते हैं, इसलिए startup report
endpoint का नाम बताती है, उसे provider के नाम से इंगित छोड़ने के बजाय। OpenRouter
route पर model id का `typesafe/` से शुरू होना ज़रूरी है; कोई भी अन्य ऐसा prose लौटाता है
जिसे यह server एक निर्णय के रूप में नहीं पढ़ सकता।

प्रति-call adapter के विपरीत, यह server अपना credential **startup पर एक बार** resolve
करता है — यह एक long-lived process है और इसका credential session के बीच में नहीं बदलता।
इसलिए बिना key के `JEV_PROVIDER=live` एक पठनीय संदेश के साथ startup error है,
पहले tool call पर होने वाली विफलता नहीं।

## Tools

| Tool | उद्देश्य |
|---|---|
| `jev_ask` | एक state पर एक या अधिक typed सवाल; उन्हें एक ही call में batch करें |
| `jev_rank` | एक criterion पर candidates को score और sort करें, प्रति candidate एक सवाल |
| `jev_check` | क्या यह evidence इस claim का समर्थन करता है? `supported`, `contradicted`, `conflicted`, `insufficient`, या `unknown` |

तीन tools, जानबूझकर कम और orthogonal। दो मौजूदा Jev MCP servers पहले से ही दस-दस tools
ship करते हैं; यह वाला उस स्थिति के लिए है जहाँ host को तीनों primitives चाहिए
और कुछ नहीं, और यह DeepSeek Harness plugin के समान core पर बना है ताकि दोनों भटक न सकें।

हर result probabilities लिए हुए आता है, निर्णय नहीं। कार्रवाई से पहले अपनी खुद की confidence
threshold लगाएँ, और कम-confidence वाले उत्तर को unknown मानें, उसके लिए चुनाव
करने के बजाय।

## Egress report

Server startup पर अपना अनुबंध **stderr** पर प्रिंट करता है:

```
[jevcore] provider=mock  endpoint=none  egress=OFF  (no network calls will be made; every answer is synthetic)
[jevcore]   armed  tool:jev_ask  (runs against the offline mock; would transmit if the provider became "live" or "openrouter")
```

Stderr, कभी stdout नहीं: stdio transport पर stdout ही protocol channel है और वहाँ एक
भटकी हुई line stream को भ्रष्ट कर देगी।

कुछ भी भेजे जाने से पहले redaction चलती है। यह एक शमन है, कोई गारंटी नहीं — मुक्त पाठ में कोई
अपरिचित secret पार निकल जाएगा। अगर यह संभावना अस्वीकार्य है, तो key सेट न करें।

## Status

Tools, provider selection, और egress enforcement tests से covered हैं, और
transport को एक असली MCP client ने stdio पर end to end चलाया है:

```sh
pnpm --filter jevcore-mcp run smoke        # offline, mock provider, no credential
pnpm --filter jevcore-mcp run smoke:live   # real answers, needs OPENROUTER_API_KEY
```

ऑफ़लाइन run handshake, tool discovery, तीन सफल calls,
और एक invalid batch के error path को चलाता है।

Live run वही सतह OpenRouter के माध्यम से असली System One models के सामने चलाता है:
तीनों tools ने जवाब दिया, एक three-primitive batch ने तीन-स्तरीय rubric पर अपनी legend सहित `1.08` का
`score` लौटाया, `jev_rank` ने एक credential runbook को एक billing guide से ऊपर रखा,
`jev_check` ने `contradicted` लौटाया, और
startup egress report ने protocol channel को बिना बिगाड़े stderr पर OpenRouter endpoint का नाम बताया।

**TypeSafe provider कभी असली API के सामने नहीं चलाया गया** — कोई
TypeSafe credential उपलब्ध नहीं था, इसलिए यह एक injected stub के सामने और
vendor की अपनी type definitions के सामने covered है। दोनों routes वही primitives लेते हैं,
इसलिए इसके बिना बदलाव काम करने की अपेक्षा है, पर वह एक अपेक्षा है, कोई प्रेक्षण नहीं।

## License

[Apache License 2.0](LICENSE) © 2026 jevcore contributors. TypeSafe, Jev, और
System One, TypeSafe AI के trademarks हैं; यह एक स्वतंत्र integration है और
इनसे संबद्ध नहीं है और न ही इनके द्वारा अनुमोदित है।
