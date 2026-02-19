# Copilot Instructions for ciao

Always reference these instructions first when making changes to the ciao repository. This file highlights repository-specific guidance and enforces that all changes which affect mDNS / DNS-SD behavior are reviewed for RFC compliance.

## Repository summary

cIAO (Ciao) implements mDNS / DNS‑SD functionality and MDNS-conformance testing tools. Changes in networking, mDNS, DNS-SD, responder logic, name conflict handling, or packet serialization/deserialization can impact interoperability with other implementations and must follow the relevant RFCs.

## Mandatory RFC compliance requirement

All pull requests and changes that touch mDNS, DNS-SD, responder behavior, discovery, or any network-level handling MUST be reviewed for compliance with:

- RFC 6762 (Multicast DNS)
- RFC 6763 (DNS-Based Service Discovery)

This repository contains an additional instructions file (`.github/instructions/*.instructions.md`) that states: "All changes need to be reviewed for compliance with RFC 6762 and RFC 6763" — ensure you follow that requirement for any relevant changes.

## Pull Request guidance

- Target branch: follow the repository's branching strategy as usual.
- PR title and description: include a short summary of behavior changes and explicitly state whether the PR affects mDNS/DNS-SD behavior.
- All pull requests and changes MUST trigger an automatic Copilot RFC 6762/6763 compliance review. Copilot will run on every PR, analyze diffs for mDNS/DNS-SD impact, post findings as review comments, and add the `rfc-review-required` label for `error` severity issues that need human attention. If the PR affects mDNS/DNS-SD, also include a brief summary of protocol-relevant changes and any tests added.

(Checklist removed — use the Copilot automated PR review below to perform an RFC-focused first-pass.)

If you are unsure about RFC compliance after Copilot's automated review, add the `rfc-review-required` label and request a human reviewer with mDNS/DNS-SD expertise for a deeper review.

## Reviewer responsibilities

- When reviewing PRs that affect mDNS/DNS-SD, evaluate Copilot's automated review output (if present), verify findings are addressed, and ensure any `error` severity items are either fixed or labeled `rfc-review-required` and escalated to a human reviewer.
- Run the included tests locally (see "How to run checks" below) and validate that no regressions are introduced.
- Check for potential interoperability or security issues caused by timing, caching, or record handling changes.

## Suggested automated checks and CI

- Add a GitHub Action that triggers Copilot's automated RFC review for all pull requests (or invokes the review bot). The Action should:
	- run on pull_request events,
	- scan changed files for mDNS/DNS-SD-relevant paths,
	- invoke Copilot/bot to post review comments following this guidance, and
	- automatically add the `rfc-review-required` label when Copilot reports an `error` severity.
- If possible, add or update a CI job that runs the MDNS-related test suite (unit and integration tests) for PRs that modify networking code. This improves catch rate for protocol regressions.
- Consider adding a lightweight linter or script that inspects changes to mDNS-related source files and enforces an RFC-focused review; the GitHub Action above can coordinate that enforcement.

## Copilot automated PR review (instructions for Copilot)

When reviewing pull requests, Copilot should actively scan diffs for changes that may affect mDNS/DNS-SD behavior and provide an automated, RFC-focused code review. Aim to surface potential RFC 6762 / 6763 issues, provide concrete guidance, and escalate to a human reviewer when ambiguous or risky.

Primary rule for reviewers invoked on a PR: when asked to review a pull request, run an RFC 6762 and RFC 6763 compliance check over the PR diff and post findings as GitHub review comments. Mark high-severity findings so maintainers know human attention is required.

Detection heuristics (scan PR diffs for):

- File path or filename patterns: `src/**/MDNSServer*`, `src/**/Responder*`, `src/**/CiaoService*`, `src/**/responder/**`, `src/**/mdns/**`, `src/**/dns/**`.
- Keywords in diffs: `mDNS`, `mdns`, `DNS-SD`, `DNS-SD`, `service`, `probe`, `announce`, `SRV`, `PTR`, `TXT`, `A/AAAA`, `TTL`, `unicast`, `suppression`, `conflict`, `probe`, `announce`, `collision`, `name-change`.
- Changes to serialization/packet-building code, message timing, or probe/announce logic.

Automated checks Copilot should perform on matched diffs:

1. Resource record changes
	- Detect additions/changes to PTR/SRV/TXT/A/AAAA records. Check for correct label formatting, escaping and service-type domain (`_service._tcp.local.`) per RFC 6763.
2. Probing/announce behavior
	- If probe/announce code is modified, verify the presence of the 3-probe sequence and conflict handling logic described in RFC 6762. Flag missing or shortened probe sequences.
3. Multicast address and port usage
	- Confirm code still targets 224.0.0.251 / ff02::fb and UDP port 5353 (or documents why a different approach is used).
4. TTL and caching
	- Highlight changes that alter TTL defaults or caching behavior; warn against overly long TTLs that could interfere with conflict resolution.
5. Unicast responses & suppression
	- Check for changes to unicast-response logic and duplicate suppression; ensure behavior aligns with RFC guidance.
6. TXT and subtype handling
	- Verify TXT encoding and ordering, and that subtype labels are formed and used correctly.
7. Edge cases
	- Flag changes that touch name conflict resolution, character encoding, max label lengths, or internationalization handling.

Suggested automated outputs (what Copilot should leave in the PR review):

- For each potential issue, a focused review comment containing:
  - A one-line summary of the finding.
  - A short explanation referencing the relevant RFC section (cite RFC 6762/6763 and a short quote or paragraph number when possible).
  - Concrete suggestions to fix or mitigate (example code snippet, test to add, or where to preserve existing behavior).
  - A severity hint: `info`, `warning`, or `error` (errors should request human review).

Example review comment template Copilot can use:

"Potential RFC 6762/6763 issue: [short finding].

- Why: [one-sentence rationale with RFC reference, e.g. RFC 6762 §8 "probing"].
- Suggestion: [concrete fix or test to add].
- Severity: [info|warning|error]

If you're unsure about the change's impact, request a human reviewer with mDNS/DNS-SD experience by adding the `rfc-review-required` label and leaving a summary of the uncertain areas (Copilot should include file/line references).

Automation actions Copilot may take (recommendations — implement as review comments, not direct commits):

- Suggest specific unit/integration tests to add, with example test names or a one-line test scaffold.
- Where applicable, include a minimal reproducer or a small test vector showing the problematic packet or sequence.
- If the PR touches many protocol-critical files or the risk is high, recommend adding a brief design note to the PR explaining RFC rationale and linking to the RFC sections.

Rules for escalation

- If any check produces an `error` severity (e.g., missing 3-probe logic, removal of conflict handling, or major changes to record serialization), Copilot must mark the finding as requiring human review and add the `rfc-review-required` label.
- For `warning` severities, Copilot should still leave a comment but may allow the PR to proceed if maintainers accept the risk.

Privacy / safety note for Copilot reviewers

- Do not expose private keys, credentials, or secrets in review comments. If the diff contains secrets, report them to maintainers through the preferred security channel instead of echoing them in a public review comment.

By following these steps, Copilot can provide a proactive, RFC-aware first-pass review for PRs that touch mDNS/DNS-SD behavior and reduce the load on human reviewers while surfacing potential interoperability issues.


## How to run checks locally (recommended)

1. Run the unit and integration tests that cover mDNS and DNS-SD code paths. Example (from repo root):

```bash
# Run test runner used by this repository (adjust to your environment)
npm install
npm test
```

2. Run any MDNS conformance or integration tests in `test/` that exercise responder behavior. Example:

```bash
# Run mdns/responder tests only (example pattern)
npm test -- -t MDNSServer
```

3. If you added a new test, ensure it is deterministic and documents what behavior/RFC it verifies.

## Examples and notes for common checks

- Probing: verify that a new name is probed three times before announcing and that conflicts cause the instance to pick a new name (per RFC 6762).
- Service types: ensure `_service._tcp.local.` formatting is used for DNS-SD service types (RFC 6763 examples).
- TXT records: verify encoding/escaping of keys and values, and ensure empty values are represented correctly.

## Documentation and follow-ups

- Small, low-risk improvements: if you change behavior, add a test and update inline docs and CHANGELOG.
- Larger or risky protocol changes: open an issue describing the change, the RFC rationale, and propose CI updates to validate behavior across platforms.

## Closing

Follow these instructions for all PRs touching mDNS/DNS-SD behavior. When in doubt, request review from maintainers with protocol expertise.
