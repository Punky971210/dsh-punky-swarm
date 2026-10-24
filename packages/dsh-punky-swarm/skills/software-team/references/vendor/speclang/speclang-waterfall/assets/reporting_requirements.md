## Reporting Format

When running the deterministic validator (`MC-*`), AI judgment checks (Part 6, `AJ-*`), or code compliance checks (Part 7, `CC-*`), report findings in this format:

```
CHECK [MC-N / AJ-N / CC-N]: <check name>
STATUS: PASS | FAIL | WARN
FINDING: <specific description of what was found>
LOCATION: <section.field or file:line>
ACTION REQUIRED: <what must be fixed before implementation or before delivery>
```

List all failures before all warnings. Group by check ID. End the report with a summary line:

```
SUMMARY: N failures, M warnings. [BLOCK: do not proceed to implementation] | [PROCEED: with N warnings logged]
```

Any `MC` failure is a hard failure before semantic review. Any `CC` failure is a hard failure — do not treat the implementation as ready for downstream handoff until resolved.

## Workflow-Specific Required Outputs

### Workflow A Requirement-Coverage Checklist

The Workflow A report must include a dedicated requirement-coverage checklist against the source input.
This checklist must explicitly enumerate coverage for:
- all required features
- corner cases and exception scenarios
- major UI designs, including placement and interaction behavior

### Workflow B Hoare-Check Output

The Workflow B report package must include the output of `speclang-hoare-check` (or equivalent hoare-reasoning report output) with an explicit overall conclusion of `PASS` / `通过`.
When the SpecLang document contains `ui_logic_native_pseudocode`, the Hoare-check output must include those entries as ordinary API/usecase Obligations that prove the declared UI trigger behavior and follow-up UI observable changes; a report that only proves internal `hoare_contract` state predicates is incomplete.

## File Organization

- `MC-*` and `AJ-*` results must be put in a same report file called `speclang-self-check-report.md`
- Requirement-Coverage Checklist must be put in a report file called `speclang-completeness-report.md`
- `CC-*` checks, except the hoare reasoning part, must be put in a file called `speclang-code-consistency-report.md`
- All the report files, including the Hoare-Check report and Implementation Architecture Report, must be placed under the same folder of speclang.yaml, unless specified by user explicitly.

---

## Asset Reference

The authoritative SpecLang template with annotated examples is at:
- `assets/speclang-template.yaml`

Deterministic structural rules and validator are at:
- `assets/MECHANICAL_RULES.md`
- `assets/validate_speclang_mechanical.rb`
