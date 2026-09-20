# Security

## Reporting a vulnerability

Please report privately rather than in a public issue — use GitHub's
[private vulnerability reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability)
on this repository, or open an issue that says only that you have a report and
how to reach you.

Please include what you did, what happened, and what you expected. A reproduction
is worth more than a severity estimate.

## What this project handles

This plugin sends content to a third party, so the interesting failure modes are
about *what leaves the machine*, not about classic memory-safety bugs.

- **Credentials.** The TypeSafe API key is resolved through DSH's credential
  service, falling back to an environment variable of the configured reference
  name. It is read per call, never logged, never returned from a tool, and never
  written to configuration. If you find a path where the key reaches a log, an
  error message, a tool result, or a file, that is a vulnerability.
- **Content.** Redaction (`packages/core/src/redact.ts`) runs before anything is
  sent, and the egress contract caps every field. Its limitation is documented
  rather than hidden: it removes values under recognisable field names and
  strings matching known secret shapes, and it **will not** catch an
  unrecognised secret in free text. A bypass that defeats a rule which claims to
  cover a case is a vulnerability; a secret shape that was never claimed to be
  covered is a feature request.
- **Egress enforcement.** No provider call may happen without passing through
  `EgressContract.measure`. A path that reaches a provider while its feature is
  disabled is a vulnerability.
- **Gates.** A disabled gate must register no listener at all. A gate that can be
  reconfigured by the model it constrains is a vulnerability.

## The honest limitation

With `provider: live`, task text, tool arguments, and — for the enabled gates —
tool results are transmitted to `api.typesafe.ai`. Redaction is a mitigation, not
a guarantee. If the possibility of an unrecognised secret leaving your machine is
unacceptable, do not enable the live provider. That is a design decision, stated
plainly, not a bug to be reported.

## Supported versions

Pre-1.0. Fixes land on the latest published version; there are no maintenance
branches yet.
