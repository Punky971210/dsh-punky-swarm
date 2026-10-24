## What Is SpecLang

SpecLang is a semi-formal product specification language used as an intermediate documentation artifact in a waterfall workflow.

Core philosophy:
- Every meaningful PM or requirements request maps to explicit SpecLang deltas before implementation changes.
- Requirements, code, and tests are downstream artifacts of SpecLang — not independent sources of truth.
- SpecLang must be precise enough to support deterministic implementation and verification.

SpecLang documents are YAML files. The authoritative template is bundled at:
- `assets/speclang-template.yaml` (alongside this SKILL.md)

Deterministic structural validation support is bundled at:
- `assets/MECHANICAL_RULES.md`
- `assets/validate_speclang_mechanical.rb`

---

## Part 1 — Design Goals for SpecLang

When authoring or reviewing a SpecLang document, keep in mind that it should achieve all six goals:

### 1. Intent Fidelity
- Capture the PM request as explicit, traceable spec changes.

### 2. End-to-End Integrity
- Describe both module-level APIs and end-to-end use cases.

### 3. Architecture-Scale Boundary Control
- For large-scale design tasks, describe subsystem architecture, module ownership and subsystem's exported interfaces.

### 4. Reuse-First Evolution
- Prefer reusing or extending existing modules and APIs before introducing new ones.
- Always investigate existing code before designing anything new.

### 5. UI-Contract Exactness
- Represent UI behavior through explicit UI events, APIs, and a declarative layout tree.

### 6. Verifiability
- Keep enough structure to trace contracts to code/tests and verify end-to-end behavior.

---

## Part 2 — Required Top-Level Sections and Field Meanings

A valid SpecLang document must contain all six core top-level sections (plus `version`). For large-scale design tasks — multi-subsystem features, architectural refactors, or net-new app design — it must also contain `system_architecture`. Below are the required fields and their semantics.

### 1. `feature_context`

| Field | Semantics |
|---|---|
| `feature_id` | Unique feature key (e.g. `FEATURE-001`). |
| `source_event_ids` | List of PM intent event IDs that produced this version. |
| `feature_goal` | User-value statement: what the user can do as a result of this feature. |
| `success_signals` | Observable outcomes that constitute PM acceptance. |
| `out_of_scope` | Explicitly excluded behaviors; prevents scope creep. |

### 2. `system_architecture` (large-scale design only)

Use this section only when the task requires architecture-level design above individual modules. Omit it for smaller feature work contained within a single local slice.

| Field | Semantics |
|---|---|
| `subsystems[]` | High-level architecture partitions for this design. |
| `subsystems[].subsystem_id` | Stable identifier for this subsystem (e.g. `SUBSYS-CHECKOUT-UI`). |
| `subsystems[].responsibility` | Single-sentence statement of what this subsystem owns at the architecture level. |
| `subsystems[].owned_modules` | Non-empty list of exact `modularity_design.modules[].module_id` values owned by this subsystem. Each module may belong to only one subsystem. |
| `subsystems[].exported` | Optional list of owned `module_id` values that form the public module surface of this subsystem. Use it for modules that are intentionally visible to other subsystems or composition roots. |
| `subsystems[].dependencies` | List of `subsystem_id` values this subsystem depends on. |
| `subsystems[].owned_code_artifacts` | Exact file paths or path globs expected to contain this subsystem's implementation. Used for code-boundary verification. |
| `composition_roots[]` | Optional entry points or wiring roots that compose multiple subsystems. Include when bootstrap or dependency-injection structure matters to the task. |
| `composition_roots[].root_id` | Stable identifier for this composition root. |
| `composition_roots[].entry_files` | Existing or planned files where composition occurs. |
| `composition_roots[].bootstrapped_modules` | Exact `module_id` values wired or started by this root. |
| `composition_roots[].responsibility` | Short explanation of what this root wires and why it exists. |

### 3. `modularity_design`

| Field | Semantics |
|---|---|
| `modules[].module_id` | Stable identifier for this module. |
| `modules[].responsibility` | Single-sentence statement of what this module owns. |
| `modules[].dependencies` | List of module IDs this module depends on. Must be acyclic. When `system_architecture` is present, any cross-subsystem dependency implied here must be permitted by the owning subsystem's `dependencies` and must target a module listed in the callee subsystem's `exported` set. |
| `modules[].is_new` | Boolean. `true` means this is a newly introduced module; `false` means this is an existing module being extended or explicitly included to resolve architecture-level ownership or interaction edges. Fully reused modules should normally not be listed unless they are referenced by `system_architecture` or `behavioral_contracts`. |
| `modules[].main_api_signatures` | Authoritative API signatures owned by this module. Use a language-agnostic format for data types. |
| `modules[].internal_states` | Semantically important internal states and their types. |
| `shared_data_types` | Cross-module types with field list and ownership. |
| `extension_note` | Optional field. Only needed if the module is extending an existing one (that is, if `is_new` is false). Provide a brief explanation of what was extended and why it belongs in this design. |
| `modules[].implementation_file` | Exact planned implementation file path for this module. This path must also appear in `reuse_and_boundary.impacted_files.modified[]` or `reuse_and_boundary.impacted_files.created[]`. |

### 4. `behavioral_contracts`

#### api_specs (one entry per API)

| Field | Semantics |
|---|---|
| `contract_id` | Stable identifier (e.g. `API-ACCEPT-TASK`). |
| `module_belonging` | The `module_id` that owns this API. Must resolve to a declared module. |
| `signature` | Type signature in target language — authoritative, code must conform. |
| `source_event_ids` | PM intent events that triggered this contract. |
| `scope` | Always `api` for api_specs. |
| `status` | `active` / `superseded`. |
| `natural_language_summary` | Plain-language description of the API. |
| `hoare_contract.pre_condition` | List of predicates on module-owned internal state before invocation. It can be the state of the belonging module or other modules it is interacting with. Therefore qualify state references with `module_id`. It is possible to declare temporary variables for the post_condition to compare against, such as `let len_before = tasks.list.length`. No UI or layout predicates. |
| `hoare_contract.post_condition` | List of predicates on module-owned internal state guaranteed after successful completion. The same qualification rules apply as in `pre_condition`. It is possible to reference temporary variables declared in `pre_condition`, such as `tasks.list.length == len_before + 1`. |
| `hoare_contract.side_effects` | Observable non-return effects on external systems (network, storage, terminal print, etc.). |
| `concurrency_invariants` | (When applicable) Guarantees on concurrent access patterns. |
| `ui_logic_native_pseudocode` | UI events wired to this API with exact `ui_element_id` references. Must use `Kind(id=UI-ID).operation` statements whose `Kind` and `operation` are registered in `../ui-component-registry/assets/kinds-catalog.yaml`. Should include both UI events triggering this API and the resulting UI updates, if applicable. All UI-triggered events must appear here. |

#### use_case_specs (one entry per end-to-end scenario)

A use case is not owned by a single module. It defines one main execution path via `ordered_implementation_chain` and may declare `branch_scenarios[]` for alternate, exceptional, or recovery paths that diverge from an earlier chain node.

| Field | Semantics |
|---|---|
| `contract_id` | Stable identifier (e.g. `UC-ACCEPT-FLOW`). |
| `involved_modules` | Non-empty list of `module_id` values whose internal states appear in this use case's `hoare_contract` or `ordered_implementation_chain`. Every module referenced by the chain must be listed. |
| `source_event_ids` | PM intent events that triggered this use case. |
| `scope` | Always `use_case` for use_case_specs. |
| `status` | `active` / `superseded`. |
| `natural_language_summary` | Plain-language walkthrough for human readers only; not a substitute for formal predicates. |
| `hoare_contract` | Same semantics as `api_specs`: `pre_condition`, `post_condition`, and optional `side_effects` as precise predicates on module-owned internal state across `involved_modules`. Every state reference must be qualified with `module_id` (or `module_id.path.toState`). Do not encode UI visibility, navigation, or layout outcomes here. |
| `concurrency_invariants` | Cross-module guarantees for the full chain (qualify state with `module_id`). |
| `ui_logic_native_pseudocode` | Only place for UI behavior: triggers, transitions, visibility, and bindings with exact `ui_element_id` references. Must use registered `ui-component-registry` kind/operation pairs. |
| `ordered_implementation_chain` | Ordered list of steps implementing the main path of this use case. Each step is a `contract_id` from `api_specs` or a qualified `module_id.apiName` signature that resolves to an active api_spec. |
| `branch_scenarios[]` | Optional alternate paths attached to this use case. Use for meaningful branches, exceptions, and recovery flows that must remain tied to the same end-to-end scenario. |
| `branch_scenarios[].branch_id` | Stable identifier for this branch within the parent use case. |
| `branch_scenarios[].branch_from_step` | Chain-node identifier naming the divergence point inside this use case, such as `UC-ACCEPT-FLOW#MAIN[1]` or `UC-ACCEPT-FLOW#BRANCH-NETWORK-FAILURE[0]`. It must point to a previously declared main-path or branch-path step. |
| `branch_scenarios[].hoare_contract` | Same semantics as the parent use-case `hoare_contract`, but only for the branch path after divergence. |
| `branch_scenarios[].ui_logic_native_pseudocode` | Branch-specific UI consequences and transitions with exact `ui_element_id` references. Must use registered `ui-component-registry` kind/operation pairs. |
| `branch_scenarios[].ordered_implementation_chain` | Ordered list of steps executed after the divergence point for this branch. |
| `branch_scenarios[].acceptance_check` | End-to-end checks specific to this branch path. |
| `acceptance_check` | End-to-end verifiable checks that complement but do not replace `hoare_contract`. |

### 5. `ui_layout`

This section is the canonical, declarative UI tree. It defines topology, sibling sequence semantics, and element repeatability — not pixel-level coordinates.

When authoring or reviewing this section, load `../ui-component-registry/SKILL.md` and `../ui-component-registry/assets/kinds-catalog.yaml`. The registry is the only source of legal `kind` values and per-kind operations.

| Field | Semantics |
|---|---|
| `screens[]` | List of impacted full-surface UI trees. A `screen` is a complete navigable page or a full-surface modal/drawer/sheet overlay, not a newly added widget or isolated local component. |
| `screens[].screen_id` | Stable full-surface screen/layout ID (e.g. `SCREEN-TASK-PAGE`). |
| `screens[].ownership_module` | Module owning this screen tree. Must resolve to `modularity_design.modules[].module_id`. |
| `screens[].design_source` | Optional strict scalar reference to the UI prototype source. It must be either a local file path or a single `http`/`https` URL. Do not use free-form prose, labels, combined references, or snapshot annotations. When present, the screen tree should be derived from the referenced source. |
| `screens[].root` | Root node of the declarative tree for this screen. Use a full-surface container kind such as `Page`, `Screen`, `Modal`, `Drawer`, `Sheet`, or `FullscreenOverlay`. |
| `node.kind` | Element type registered in `../ui-component-registry/assets/kinds-catalog.yaml`: full-surface containers, layout containers, semantic state containers, interactive components, static elements, navigation elements, or feedback elements. Do not invent kind names outside the registry. |
| `node.ui_element_id` | Optional. Present only when this node interacts with internal logic or is referenced by contracts/tests. |
| `node.repeating_type` | Presence cardinality for nodes with `ui_element_id`: `one` (required, single), `optional` (zero or one), `any` (zero or more, repeatable). Omit for nodes without `ui_element_id`. Can be omitted for nodes of type `one`. |
| `node.children[]` | Ordered child nodes (nesting expresses parent-child relationship; sequence is canonical order). When a change only affects a local region, keep the enclosing ancestor path explicit so the new or modified element is positioned within the whole screen; unaffected siblings may be simplified. |
| `screens[].responsive_overrides[]` | Breakpoint/form-factor deltas that modify tree semantics without changing IDs. |

When generating code from `ui_layout` and `ui_logic_native_pseudocode`, load the matching `../ui-component-registry/assets/guides/pseudocode-to-{target}.yaml` guide for the implementation target. The guide maps registered kinds and operations to target-runtime patterns; it does not authorize new SpecLang operation names.
| `screens[].responsive_overrides[].condition` | Condition expression (e.g. `screen_width < 600dp`). |
| `screens[].responsive_overrides[].adjustments` | Explicit node-level semantic deltas (for example reorder a `children` sequence, change a node's `kind`, or add/remove optional nodes). |

### 6. `reuse_and_boundary`

| Field | Semantics |
|---|---|
| `related_code_artifacts` | All code files relevant to this feature's scope. |
| `api_dependency` | List entries with exact sub-fields: `used as`, `signature`, `updated`, `rationale`; plus relation-dependent field: `required by` (content semantics vary by `used as`). |
| `extended_modules_summary` | List of all modules marked extended. |
| `impacted_files.modified[]` | Planned existing files to modify. Must include every module `implementation_file` that refers to an existing file. |
| `impacted_files.created[]` | Planned new files to create. Must include every module `implementation_file` that refers to a new file. |

#### 5a. `reuse_and_boundary` Sub-Field Semantics

`api_dependency[]` sub-fields:

| Sub-field | Required | Semantics |
|---|---|---|
| `used as` | yes | Integration relation kind: `use case step` or `library`. |
| `signature` | yes | Target API identifier/signature used by this integration point. Must be module-qualified (`module_id.apiName(...)` or equivalent qualified signature). If `updated: true`, this is the updated signature after change; if `updated: false`, this is the existing signature kept as-is. |
| `updated` | yes | Boolean flag for signature change intent: `true` means the signature needs to change; `false` means the API signature is kept as-is. |
| `rationale` | yes | Short concrete reason for this integration decision. |
| `required by` | conditional | Required by relation: when `used as: use case step`, references the exact chain-node identifier for a main-path or branch-path step (for example `UC-ACCEPT-FLOW#MAIN[0]` or `UC-ACCEPT-FLOW#BRANCH-NETWORK-FAILURE[1]`). Use this bookkeeping for chain steps written as qualified signatures (existing APIs); chain steps written as `api_specs.contract_id` do not require a matching `use case step` dependency entry. When `used as: library`, `required by` is the caller or delegating API and must be module-qualified (`module_id.apiName(...)` or equivalent qualified signature). |

### 7. `traceability_and_validation`

| Field | Semantics |
|---|---|
| `pm_to_spec_trace` | Maps intent event IDs to `feature_id` values. |
| `nl_to_intent_trace` | Documents how PM natural language was mapped to normalized intent. |
| `architecture_to_code_trace` | When `system_architecture` is present, maps `subsystem_id` and `root_id` values to code file paths. |
| `spec_to_code_trace` | Maps contract IDs to code file paths. |
| `spec_to_test_trace` | Maps contract IDs to test file paths. |

---

## Part 3 — Core Warnings and Common Mistakes

These are the few mistakes that most often make the document unstable or invalidate later checks.

1. Stable IDs — Never regenerate `feature_id`, `contract_id`, `branch_id`, `ui_element_id`, `subsystem_id`, or `root_id` once established.

2. Keep hoare logic precise — Use concrete predicates, qualify state with `module_id`, and keep UI behavior out of `hoare_contract`.

3. Do not guess feature boundaries or intent — Create a new SpecLang file for a net-new feature; otherwise update the existing feature spec. If scope or PM intent is unclear, clarify before editing.

4. Use `system_architecture` only when architecture boundaries materially matter — multi-subsystem feature work, architecture refactors, or net-new apps. Do not add it to routine single-slice edits just to mirror the code tree.

5. Keep subsystem public surface explicit — When cross-subsystem access matters, list the visible module surface in `subsystems[].exported` and treat everything else in that subsystem as internal.

6. Keep screen boundaries strict — `ui_layout.screens[]` must describe full surfaces, not local widgets. When a feature adds or changes one element inside an existing page, update the enclosing screen tree and show the element in context.

7. Keep the UI tree canonical — Every `ui_element_id` referenced by contracts must exist in `ui_layout`. Broken UI tree ownership or missing IDs will cascade into contract, validation, and implementation drift.

8. Respect existing prototypes — If an HTML, Figma export, web page, or other UI prototype already exists, record it in `design_source` using the strict scalar protocol and derive the screen tree from that artifact. For web pages, write only the page URL. Do not invent a different page structure unless the requirement explicitly changes the prototype.

---
