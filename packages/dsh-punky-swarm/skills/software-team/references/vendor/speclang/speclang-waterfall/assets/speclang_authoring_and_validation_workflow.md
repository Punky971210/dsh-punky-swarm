## Part 4 — Authoring a Feature with SpecLang (Step by Step)

Use this sequence when drafting a new SpecLang file or updating an existing one.

### Step 0 — Investigate the current codebase
- Search relevant code paths.
- Collect the evidence you need to understand existing modules, APIs, states, and patterns.
- If the feature has any UI surface, load `../ui-component-registry/SKILL.md` and `../ui-component-registry/assets/kinds-catalog.yaml` before writing `ui_layout` or `ui_logic_native_pseudocode`.

### Step 1 — Identify scope
- Determine whether this is a new feature or an iteration on an existing one.
- Determine whether this is a large-scale design task. Only then should `system_architecture` be added.
- List the PM intent event IDs that drive this change.

### Step 2 — Write `feature_context`
- Complete the `feature_context` section.

### Step 3 — Write `system_architecture` when applicable
- For large-scale design tasks only, define subsystem ownership, exported module surface, allowed dependency boundaries, and composition roots.

### Step 4 — Co-design `modularity_design` and `reuse_and_boundary`
- Record the details of modules and shared types new to or extended by this feature in `modularity_design`.
- Record each module's exact `implementation_file` in `modularity_design`.
- If `system_architecture` is present, also include any exact modules needed to resolve subsystem ownership or dependency edges.
- Record existing APIs this feature depends on or reuses in `reuse_and_boundary`.
- Ensure every module `implementation_file` is also listed in `reuse_and_boundary.impacted_files.modified[]` or `reuse_and_boundary.impacted_files.created[]`.

### Step 5 — Co-design `behavioral_contracts` and `ui_layout`
- Write the affected `api_specs` and `use_case_specs` in `behavioral_contracts`, including `branch_scenarios[]` whenever the scenario has meaningful alternate or exception paths.
- Write the impacted full-surface screen trees in `ui_layout` using only `kind` values registered in `../ui-component-registry/assets/kinds-catalog.yaml`.
- Write `ui_logic_native_pseudocode` using the `Kind(id=UI-ID).operation` format from `ui-component-registry`; every operation must be registered for that exact `kind`.
- If a UI prototype already exists, set `design_source` and translate that prototype into the screen tree instead of inventing a fresh layout. If the prototype is a web page, set `design_source` to the page URL only.
- If the change is local to one widget or area, keep the enclosing screen and the ancestor path to the changed node explicit.

### Step 6 — Write `traceability_and_validation`
- Add trace links between intent, spec, code, and tests.
- If `system_architecture` is present, add architecture-to-code trace links for subsystems and composition roots.

### Step 7 — Run the completeness gate (see Part 5 below)
- Run Part 5 for completeness.- Run the deterministic validator and then Part 6 semantic review before implementation.

---

## Part 5 — Completeness Gate (Before Implementation)

Before any implementation update, confirm the document is filled out enough to validate. This gate checks section completion only; detailed correctness belongs to Part 6.

- [ ] All six core top-level sections exist for the feature's scope.
- [ ] If this is a large-scale design task, `system_architecture` exists and resolves to exact module IDs declared in `modularity_design`.
- [ ] `feature_context` is filled for this change.
- [ ] `modularity_design` describes the changed modules, states, and shared types.
- [ ] Every module declares its planned `implementation_file`.
- [ ] `behavioral_contracts` covers the changed APIs, the main end-to-end use case path, and any required branch scenarios.
- [ ] `ui_layout` is present for the impacted full-surface UI screens, not isolated widgets.
- [ ] If UI is present, `ui-component-registry` was loaded and every UI `kind` and UI operation conforms to its catalog.
- [ ] `reuse_and_boundary` records dependency decisions and file impact planning.
- [ ] Every module `implementation_file` appears in exactly one of `reuse_and_boundary.impacted_files.modified[]` or `reuse_and_boundary.impacted_files.created[]`.
- [ ] `traceability_and_validation` contains trace stubs for the changed scope, plus architecture trace stubs when `system_architecture` is present.
- [ ] The finished spec has been checked against the input requirement document, requirement description, or PRD, and every required scenario and process is either represented in the spec or explicitly captured as excluded scope.
- [ ] `assets/validate_speclang_mechanical.rb` has been run with zero failures after the document was completed.
- [ ] Part 6 semantic review has been run after the deterministic validator passed.

---

## Part 6 — Consistency Review

Use a two-stage flow.

### Stage 1 — Deterministic Mechanical Validation

The following checks are intentionally extracted from the main skill because they are structural and do not require agent judgment:
- required section and required-field presence
- identifier uniqueness and dependency DAG checks
- cross-reference resolution
- UI tree structural validity and `ui_element_id` coverage
- trace, impact, integration, and architecture-boundary bookkeeping

The authoritative mechanical rule set is at:
- `assets/MECHANICAL_RULES.md`

The deterministic validator is at:
- `assets/validate_speclang_mechanical.rb`

Run it with:
- `ruby .github/skills/speclang-waterfall/assets/validate_speclang_mechanical.rb path/to/spec.yaml`

If the validator reports any `MC-*` failure, fix those issues before continuing to Stage 2.

### Stage 2 — AI Judgment Checks

Use the agent only for checks that require semantic interpretation rather than schema validation.

### AJ-1: Use-Case Semantic Completability
- No main-path chain or branch-path chain has a semantic gap: each step's module-internal outputs must be a plausible input to the next step's api `pre_condition`.
- Every `branch_scenarios[].branch_from_step` points at a real divergence point, and the branch path is semantically compatible with what the anchor step can produce.
- `natural_language_summary` is consistent with (but does not replace) the formal `hoare_contract` and `ui_logic_native_pseudocode`.

### AJ-2: Hoare Logic Semantic Soundness
- Every `pre_condition` and `post_condition` (api and use case) is a concrete, meaningful predicate on module-owned internal state, not vague language or disguised UI wording.
- Every state reference used in a semantically important way is properly qualified or otherwise unambiguous in context.
- For consecutive api_specs in a use case's `ordered_implementation_chain`, the `post_condition` of step N is semantically compatible with the `pre_condition` of step N+1.
- For each active `use_case_specs` entry, resolve every main-path `ordered_implementation_chain` step and every `branch_scenarios[].ordered_implementation_chain` step to active `api_specs` entries and verify:
  - `use_case_specs.hoare_contract.pre_condition` implies (or equals) the first resolved api's `pre_condition` over shared qualified state (use-case pre may be stricter).
  - `use_case_specs.hoare_contract.post_condition` is implied by the combined post-conditions of all resolved apis in order (use-case post may summarize the net internal-state delta only).
  - Each branch `hoare_contract` is implied by the anchor step named by `branch_from_step` plus the branch's own chain steps.
  - No use-case `post_condition` predicate references UI or presentation state.
- No `post_condition` directly contradicts a declared `concurrency_invariant` in the same contract.

### AJ-3: Prototype Fidelity
- When `design_source` is present on a screen, `ui_layout` should be a structured restatement of that prototype, not a fresh layout concept.
- New UI elements should appear inside the correct enclosing screen and context from the prototype; they should not be promoted into standalone `screens[]` entries unless they are genuinely new full-surface screens.
- If the spec intentionally deviates from the prototype, the requirement delta causing that deviation should be explicit elsewhere in the document.

### AJ-3b: UI Registry Conformance
- Every `ui_layout` node kind must be present in `../ui-component-registry/assets/kinds-catalog.yaml`.
- Every `ui_logic_native_pseudocode` operation must be listed under the referenced element kind in the catalog.
- UI behavior should use catalog operations rather than free-form aliases such as `Show(UI-X)`, `Tap(UI-X)`, or framework-specific names.
- Fail if: the spec invents an unregistered UI kind, uses an operation not bound to that kind, or writes UI logic in a form that cannot be translated through `ui-component-registry`.

### AJ-4: Requirements Coverage Against Source Inputs
- Compare the finished SpecLang document against the input requirement document, requirement description, or PRD used to author it.
- Verify every required scenario, branch, exception path, and user-visible process from the source input is represented somewhere in `feature_context`, `behavioral_contracts`, `ui_layout`, `reuse_and_boundary`, or explicit exclusions such as `out_of_scope`.
- Fail if: the source input contains a required scenario or process that is missing from the spec, or the spec silently drops a requirement without explicitly excluding or staging it.

---
