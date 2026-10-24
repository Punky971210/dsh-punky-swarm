---
name: speclang-waterfall
description: "Use when: drafting, reviewing, or validating a SpecLang document as intermediate waterfall documentation; designing a new app feature or iteration using SpecLang format; checking the internal consistency of a finished SpecLang document; checking whether code derived from a SpecLang document complies with its contracts; checking whether code changes are consistent with the authoritative SpecLang document."
---

# SpecLang Waterfall Skill (v0)

## Usage Scenarios

Use this skill when:
- Drafting a SpecLang document from requirement inputs (PRD, requirement doc, requirement description).
- Reviewing or validating a SpecLang document as intermediate waterfall documentation.
- Designing a new feature/iteratively refining a feature in SpecLang format.
- Generating implementation code from an approved SpecLang document and verifying code-spec consistency.
- Updating implementation code and re-checking consistency against the authoritative SpecLang document.


## Workflow A: Requirement Inputs -> SpecLang Design Document

### Required Inputs

You must collect all of the following inputs before producing a final SpecLang document:
- Requirement source input: PRD, requirement document, or requirement description.
- Existing related SpecLang file (if this is an iteration rather than net-new feature).
- Relevant codebase evidence for reuse/extension decisions.
- UI prototype source when applicable (HTML/Figma export/web page URL/local design file).

### Required Self-Checks (Must Pass)

Before implementation, the SpecLang document must pass all of the following checks:
- Completeness gate.
- Deterministic mechanical validation (`MC-*`).
- AI judgment consistency checks (`AJ-*`).
- Requirement coverage check against the source input.

Operational details, exact rules, and full check definitions are read on demand from assets:
- `assets/speclang_authoring_and_validation_workflow.md`
- `assets/MECHANICAL_RULES.md`
- `assets/validate_speclang_mechanical.rb`

### Required Output Report

After finishing self-checks, you must output a structured validation report that includes:
- Mechanical validation results (`MC-*`).
- AI judgment validation results (`AJ-*`).
- A checklist of requirement coverage against the source input, including all features,  corner cases, and major UI designs(including placing and interaction).

The report format and hard-gate policy are mandatory and defined at:
- `assets/reporting_requirements.md`

## Workflow B: SpecLang Design Document -> Implementation Code

### Required Consistency Checks (Must Pass)

After code generation or any implementation update, you must run and pass code consistency checks against the authoritative SpecLang document:
- Full `CC-*` code compliance checks.
- Hoare reasoning hard gate for `CC-2` through `CC-6` via sibling `speclang-hoare-check` (or equivalent report with explicit overall `PASS` / `通过`).
- Re-run consistency checks after any behavior-affecting code change, bug fix, refactor, or test-driven correction.

Operational details and full check definitions are read on demand from assets:
- `assets/code_consistency_checks.md`

### Required Output Report

After consistency checks, you must output:
- `speclang-code-compliance-report` covering `CC-*` findings.
- Output of `speclang-hoare-check` (or equivalent hoare-reasoning report output) with explicit overall conclusion `PASS` / `通过`.

The report format and hard-gate policy are mandatory and defined at:
- `assets/reporting_requirements.md`

## On-Demand Asset Map

Detailed references are intentionally decomposed into assets and should be loaded only when needed:
- `assets/speclang_foundation_reference.md`
- `assets/speclang_authoring_and_validation_workflow.md`
- `assets/code_consistency_checks.md`
- `assets/reporting_requirements.md`
- `assets/speclang-template.yaml`
- `assets/MECHANICAL_RULES.md`
- `assets/validate_speclang_mechanical.rb`

## Essential References

When working on SpecLang UI sections or UI-derived implementation code, consult the sibling `ui-component-registry` skill for legal UI kinds, operations, and target-runtime translation guidance. The goal is to ensure that the SpecLang document and its derived code are consistent on the understanding of UI component types, operations, and runtime behavior.