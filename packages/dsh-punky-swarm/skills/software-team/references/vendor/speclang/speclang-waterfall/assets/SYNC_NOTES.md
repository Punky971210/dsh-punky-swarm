# Sync Notes for `speclang-waterfall`
This file is only for syncing from upstream skills. Should be ignored when using the skill itself.

This folder is a standalone fork of the upstream `speclang` skill.

Purpose:
- keep `speclang-waterfall` aligned with upstream structure and quality improvements,
- preserve its narrower role as intermediate documentation for a waterfall workflow,
- document every intentional divergence so future syncs stay mechanical instead of interpretive.

Important rule:
- `SKILL.md` and `assets/speclang-template.yaml` in this folder must not contain preview or data-mocking requirements.
- This file is allowed to mention removed topics because it is the maintenance ledger for the fork.

## Upstream Sources

- Upstream skill: `../speclang/SKILL.md`
- Upstream template: `../speclang/assets/speclang-template.yaml`

## Future Sync Procedure

1. Diff upstream `speclang` against the last synced version.
2. Classify each upstream change using the divergence table below.
3. Port changes automatically when the row says `keep`.
4. Re-evaluate changes manually when the row says `rewrite` or `remove`.
5. After syncing, run a keyword sweep on this folder's `SKILL.md` and `assets/speclang-template.yaml` for `preview`, `mock`, `mocking`, `data_access_and_mocking`, `preview_rendering_policy`, and `mock_data_contracts`.
6. Confirm the waterfall skill still declares the same required sections that its template actually contains.

## Divergence Table

| Upstream area | Waterfall action | Reason | Future sync rule |
|---|---|---|---|
| Frontmatter description and opening purpose | rewrite | The waterfall variant is positioned as intermediate documentation, not a preview-driving spec. | Keep wording improvements, but preserve the waterfall framing and exclude preview-specific triggers. |
| Core philosophy line about downstream artifacts | rewrite | Upstream ties preview behavior to SpecLang; waterfall keeps only requirements, code, and tests downstream. | Port clarity improvements unless they add preview or data-mocking obligations. |
| Part 1 goal set | rewrite | The waterfall variant replaces preview-readiness emphasis with architecture-boundary control for large-scale tasks and verification-focused handoff goals. | If upstream changes goal ordering or wording, preserve the waterfall emphasis on architecture boundaries and verifiability rather than preview concerns. |
| Part 2 section count | rewrite | Upstream requires eight top-level sections; waterfall now requires six core sections plus optional `system_architecture` for large-scale tasks. | Port section-definition changes only for the retained waterfall sections plus the conditional architecture section. |
| `system_architecture` edge modeling | rewrite | The waterfall variant derives concrete cross-subsystem edges from module dependencies and contract/reuse sections instead of maintaining a separate architecture-edge list, and uses `subsystems[].exported` as the public module surface. | Do not port upstream architecture-edge lists directly; keep ownership, exported surface, and dependency boundaries authoritative. |
| Part 6 structural consistency checks | rewrite | The waterfall variant extracts deterministic structural checks into `assets/MECHANICAL_RULES.md` and `assets/validate_speclang_mechanical.rb`, leaving only semantic review in `SKILL.md`. | Port structural rule changes into the mechanical rule file and validator first, then keep only semantic guidance in the main skill. |
| `traceability_and_validation.mock_data_contracts` | remove | Data-mocking contracts are out of scope for this variant. | Do not re-add unless the waterfall scope is explicitly expanded. |
| `data_access_and_mocking` section | remove | Preview data strategy is out of scope for this variant. | Ignore upstream changes in this section unless the variant is intentionally widened. |
| `preview_rendering_policy` section | remove | Preview-surface policy is out of scope for this variant. | Ignore upstream changes in this section unless the variant is intentionally widened. |
| Part 4 authoring steps that cover preview-data decisions and preview policy | remove and renumber | The waterfall flow stops at a complete handoff document before implementation. | Preserve authoring-sequence improvements, but keep the waterfall flow with the conditional `system_architecture` step for large-scale tasks only. |
| Part 5 completeness gate items for removed sections | remove | The gate should check only the waterfall-required sections. | Port any new completeness rules only if they apply to retained sections. |
| Part 6 cross-reference checks tied to removed sections | remove and renumber | Cross-reference validation should not require preview-only sections. | Port new cross-reference rules only if they target retained sections. |
| Part 6 UI-layout validity wording | rewrite | The waterfall fork drops the upstream prohibition on `ui_element_id` for all static elements because the example template legitimately tags `Text` nodes referenced by contracts. | If upstream resolves this inconsistency later, adopt the upstream fix if it remains compatible with tagged static elements used by contracts. |
| Part 6 integration-decision numbering | rewrite | Numbering collapses after removed checks. | Re-number mechanically after each sync. |
| Part 7 code-compliance check for generated mock-provider bindings | remove | Mock binding checks are out of scope for this variant. | Do not re-add unless the variant is widened to cover execution environments. |
| Part 7 summary wording about PM preview delivery | rewrite | Waterfall compliance should block downstream handoff, not preview delivery. | Port reporting-format improvements while preserving handoff wording. |
| Template example strings that mention preview or deterministic mocks | rewrite | Example language must stay neutral and implementation-focused. | Replace any preview-oriented example text with generic verification language. |
| Template example coverage for `api_dependency.used as: use case step` | rewrite | The waterfall template was normalized so qualified-signature chain steps satisfy the documented integration bookkeeping rule. | Keep this normalization unless upstream template is fixed equivalently. |

## Files Expected to Diverge Permanently

- `SKILL.md`
- `assets/speclang-template.yaml`

## Validation Checklist After Each Sync

- Required-section count in `SKILL.md` matches the template.
- No preview or data-mocking terms appear in `SKILL.md`.
- No preview or data-mocking terms appear in `assets/speclang-template.yaml`.
- Every intentional difference from upstream still appears in the divergence table above.