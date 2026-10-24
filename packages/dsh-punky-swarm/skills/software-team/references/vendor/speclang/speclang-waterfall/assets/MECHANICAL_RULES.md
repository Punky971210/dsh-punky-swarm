# SpecLang Mechanical Rules

These rules are deterministic structural checks. They do not require agent judgment and should be validated by script before an agent spends time on semantic review.

Authoritative validator:
- `assets/validate_speclang_mechanical.rb`

Recommended command:
- `ruby .github/skills/speclang-waterfall/assets/validate_speclang_mechanical.rb path/to/spec.yaml`

If the validator reports any `MC-*` failure, fix those issues before running the semantic checks in `SKILL.md` Part 6.

## MC-1: Required Sections and Required Shapes

The validator checks these structural requirements:
- `version` exists at the document root.
- All six core top-level sections exist: `feature_context`, `modularity_design`, `behavioral_contracts`, `ui_layout`, `reuse_and_boundary`, `traceability_and_validation`.
- If `system_architecture` is present, it contains `subsystems[]`. `composition_roots[]` is optional, but if present it must be a list.
- `feature_context` contains `feature_id`, `source_event_ids`, `feature_goal`, `success_signals`, and `out_of_scope`.
- `modularity_design` contains `modules[]` and `shared_data_types[]`.
- Each module entry contains `module_id`, `responsibility`, `dependencies`, `main_api_signatures`, `internal_states`, `is_new`, and `implementation_file`.
- Each `implementation_file` is a single scalar string path.
- `behavioral_contracts` contains `api_specs[]` and `use_case_specs[]`.
- Each api spec contains `contract_id`, `module_belonging`, `signature`, `source_event_ids`, `scope`, `status`, `natural_language_summary`, and `hoare_contract`.
- Each use case spec contains `contract_id`, `involved_modules`, `source_event_ids`, `scope`, `status`, `natural_language_summary`, `hoare_contract`, `ordered_implementation_chain`, `acceptance_check`, and `ui_logic_native_pseudocode`.
- If a use case declares `branch_scenarios[]`, each branch scenario contains `branch_id`, `branch_from_step`, `hoare_contract`, `ui_logic_native_pseudocode`, `ordered_implementation_chain`, and `acceptance_check`.
- `ui_layout` contains `screens[]`.
- Each screen may declare an optional `design_source`, which must be a single scalar string using the strict source protocol:
  - local source: `<local-file-path>`
  - web source: `<http-or-https-url>`
  - free-form prose, labels, combined references, and snapshot annotations are invalid.
- `reuse_and_boundary` contains `related_code_artifacts[]`, `api_dependency[]`, `extended_modules_summary[]`, and `impacted_files.modified[]` plus `impacted_files.created[]`.
- `traceability_and_validation` contains `pm_to_spec_trace[]`, `nl_to_intent_trace[]`, `spec_to_code_trace[]`, and `spec_to_test_trace[]`. If `system_architecture` is present, it must also contain `architecture_to_code_trace[]`.

## MC-2: Identifier Uniqueness

The validator checks:
- `contract_id` uniqueness across `api_specs` and `use_case_specs`.
- `branch_id` uniqueness within each `use_case_specs[].branch_scenarios[]` list.
- `module_id` uniqueness across `modularity_design.modules[]`.
- `subsystem_id` uniqueness across `system_architecture.subsystems[]` when architecture is present.
- `root_id` uniqueness across `system_architecture.composition_roots[]` when architecture is present.

## MC-3: Reference Resolution

The validator checks:
- `module_belonging` resolves to a declared `module_id`.
- `screens[].ownership_module` resolves to a declared `module_id`.
- `involved_modules[]` resolves to declared module IDs.
- Every `ordered_implementation_chain` step resolves either to an active api spec `contract_id` or to an active qualified api signature.
- Every module referenced by a resolved chain step appears in the use case's `involved_modules`.
- Every `branch_scenarios[].branch_from_step` resolves to a previously declared chain node in the same use case. Use chain-node identifiers of the form `UC-...#MAIN[n]` or `UC-...#BRANCH-ID[n]`.
- `source_event_ids` in behavioral contracts resolve to an ID present in `pm_to_spec_trace` or mentioned in `nl_to_intent_trace`.
- `spec_to_code_trace` and `spec_to_test_trace` reference declared `contract_id` values.
- When `system_architecture` is present, `owned_modules`, `exported`, `dependencies`, `bootstrapped_modules`, and `architecture_to_code_trace` all resolve to declared IDs.

## MC-4: UI Tree Structural Validity

The validator checks:
- Screen roots use a full-surface container kind: `Page`, `Screen`, `Modal`, `Drawer`, `Sheet`, or `FullscreenOverlay`.
- `repeating_type` is present only on nodes that declare `ui_element_id`.
- `repeating_type`, when present, is one of `one`, `optional`, or `any`.
- Repeated `ui_element_id` values in the layout tree are allowed only when every occurrence uses `repeating_type: any`.
- `ui_logic_native_pseudocode` references resolve to declared `ui_element_id` values.
- When the sibling `ui-component-registry` catalog is available, each `ui_layout.kind` must be registered and each `Kind(id=UI-...).operation` must be registered for that kind.

Authors and reviewers must additionally use `../ui-component-registry/assets/kinds-catalog.yaml` as the source of truth for legal UI kinds and per-kind operations. The preferred UI logic form is:
- `Kind(id=UI-...).operation(...)`

The validator extracts `ui_element_id` references from this preferred form and from legacy literal forms such as:
- `id=UI-...`
- `Tap(UI-...)`
- `Show(UI-...)`
- `Hide(UI-...)`
- `Focus(UI-...)`
- `Select(UI-...)`
- `Transition(UI-... -> ...)`

## MC-5: Dependency DAGs

The validator checks:
- `modularity_design.modules[].dependencies` has no self-dependency and no cycle.
- When `system_architecture` is present, `subsystems[].dependencies` has no self-dependency and no cycle.

## MC-6: Trace and Impact Bookkeeping

The validator checks:
- Every active `contract_id` appears in at least one of `spec_to_code_trace` or `spec_to_test_trace`.
- When `system_architecture` is present, every declared `subsystem_id` and `root_id` appears in `architecture_to_code_trace`.
- `impacted_files.modified[]` and `impacted_files.created[]` both exist.
- At least one impacted file path is declared.
- Paths are unique across `modified[]` and `created[]`.
- Every `modularity_design.modules[].implementation_file` appears in exactly one of `impacted_files.modified[]` or `impacted_files.created[]`.

## MC-7: Integration Bookkeeping

The validator checks:
- Every main-flow and branch-flow chain node that references an existing API via a qualified signature has exactly one matching `api_dependency` entry with `used as: use case step`.
- Every `api_dependency` entry has the required fields for its `used as` value.
- Every `signature` is module-qualified.
- When `used as: use case step`, `required by` points to a chain-node identifier such as `UC-...#MAIN[n]` or `UC-...#BRANCH-ID[n]`.
- `required by` is module-qualified when `used as: library`.
- Modules with `is_new: false` declare `extension_note`.

## MC-8: Architecture Boundary Structure

When `system_architecture` is present, the validator checks:
- Every owned module belongs to exactly one subsystem.
- No subsystem has an empty `owned_modules[]` list.
- Every exported module also appears in that subsystem's `owned_modules[]` list.
- Every cross-subsystem module dependency is permitted by the caller subsystem's `dependencies` list.
- Every cross-subsystem module dependency targets a module listed in the callee subsystem's `exported` list.
- Every composition-root bootstrapped module belongs to a declared subsystem.

## Deliberately Not Automated Here

These checks remain in `SKILL.md` because they require semantic judgment rather than pure structure checking:
- semantic gaps between use-case chain steps
- Hoare predicate meaning, precision, and implication
- contradiction analysis between contracts
- implementation-to-code reasoning that depends on target-language semantics
