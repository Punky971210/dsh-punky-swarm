## Part 7 — Code Compliance Checks

Use these checks to verify that code derived from a SpecLang document honors the contracts specified in it. These checks are performed on the code, using the SpecLang document as the authoritative reference.

Hoare reasoning hard gate:
- `CC-2` through `CC-7` must be verified by running the sibling `speclang-hoare-check` skill, or by producing an equivalent Hoare reasoning report that follows `speclang-hoare-check/assets/hoare-reasoning-report-template.md` and gives an explicit overall conclusion of `PASS` / `通过`.
- The Hoare reasoning report is required for implementation completion whenever any code is created, modified, or bug-fixed against a SpecLang document.
- After any subsequent implementation code change, bug fix, refactor, or test-driven correction that can affect code behavior, rerun the Hoare reasoning check. The task is not complete until the latest report explicitly marks the overall result as `PASS` / `通过`.
- Zero `VIOLATED`, zero `CHAIN_BREAK`, or other intermediate counts alone are not sufficient completion criteria unless the Hoare reasoning report itself concludes `PASS` / `通过`.
- The general `speclang-code-compliance-report` may summarize the result, but it must not replace the Hoare reasoning report's explicit `PASS` / `通过` conclusion for `CC-2` through `CC-7`.

### CC-1: API Signature Conformance
For every active `contract_id` in `api_specs`:
- Locate the implementing function in the code.
- Verify the function signature exactly matches `signature` in the SpecLang (parameter names, types, return type).
- Fail if: the function is absent, has different parameter types, or has a different return type.

### CC-2: Hoare Pre-Condition Enforcement (API)
For every active api_spec's `hoare_contract.pre_condition`:
- The implementing code must guard against violating pre-conditions before performing its main logic.
- Fail if: a pre-condition is stated (for example `task_service.store[taskId].status == AVAILABLE`) but no corresponding guard or assertion exists in the code path.

### CC-3: Hoare Post-Condition Guarantee (API)
For every active api_spec's `hoare_contract.post_condition`:
- On the success path, all post-conditions must be achievable from code behavior.
- Fail if: a post-condition claims a state change but the code has no write path that produces that state.

### CC-4: Side Effect Accounting (API)
For every active api_spec's `hoare_contract.side_effects`:
- All stated side effects must be present in the code.
- No significant side effects may exist in the code that are absent from SpecLang.
- Fail if: a stated side effect (for example a network mutation to accept a task) has no corresponding call in the code, or if the code has a notable undeclared side effect.

### CC-5: Use-Case Hoare Contract Validity
For every active `use_case_specs` entry:
- Verify `hoare_contract` predicates refer only to module-qualified internal state in `involved_modules`.
- Verify every branch scenario `hoare_contract` also refers only to module-qualified internal state in `involved_modules`.
- Fail if: a predicate names UI or layout concepts, uses unqualified state, or references a module not in `involved_modules`.

### CC-6: Use-Case Hoare vs API Chain Composition
For every active `use_case_specs` entry, resolve the main `ordered_implementation_chain` and each `branch_scenarios[].ordered_implementation_chain` to active `api_specs` and verify in code (or by static review of the spec):
- After a successful chain run, module-internal state satisfies the use-case `hoare_contract.post_condition`.
- After a branch path runs from its `branch_from_step`, module-internal state satisfies that branch's `hoare_contract.pre_condition`.
- The use-case `hoare_contract` does not require internal-state outcomes that the composed api contracts cannot jointly produce.
- Fail if: code reaches a success path but violates use-case post-conditions, a branch path violates branch pre-conditions, or use-case and branch post-conditions contradict the composed api hoare contracts.

### CC-7: UI Element Binding Conformance
For every `ui_logic_native_pseudocode` entry in active api_specs, use_case_specs, and branch scenarios:
- Locate each `ui_element_id` in `ui_layout`.
- Confirm the referenced `Kind.operation` pair exists in `../ui-component-registry/assets/kinds-catalog.yaml`.
- When checking implementation code, load the matching `../ui-component-registry/assets/guides/pseudocode-to-{target}.yaml` guide and use it as the target-runtime translation reference.
- Verify the event binding (onClick, onTap, submit, gesture handler, lifecycle hook, etc.) exists in the rendered code and points to the correct API/usecase/function chain.
- Verify the UI trigger side as a pre-condition: the declared UI event can reach the implementation entry, its enabled/validation state matches the spec, and UI inputs/state are mapped to function parameters or request payloads.
- Verify the UI follow-up side as a post-condition: declared visibility, navigation, text, list, error, loading, empty, partial failure, optimistic update, or transition changes are produced on the matching success/failure/branch path and are observable through the target runtime's rendering/binding model.
- The `speclang-hoare-check` report must include one ordinary API/usecase Obligation for each `ui_logic_native_pseudocode` entry and prove both trigger-side and follow-up-side behavior when present.
- Fail if: the binding is absent, points to a different API, uses a different locator, uses an unregistered UI operation, bypasses the target-runtime guide's expected mapping without documented justification, maps UI inputs incorrectly, or fails to produce the declared follow-up UI behavior.

### CC-8: UI Layout Conformance
Using `ui_layout` as the source of truth:
- Confirm each declared `kind` exists in `../ui-component-registry/assets/kinds-catalog.yaml`.
- Use each kind's `framework_mapping` plus the matching guide in `../ui-component-registry/assets/guides/` to interpret the expected target-runtime implementation.
- Verify newly added elements in a screen correspond to their position specified in `screens[]`.
- Verify parent-child containment relationships in code or layout files match the declarative tree (`screens[].root` and descendants).
- Verify sibling visual order follows `children[]` sequence unless an explicit responsive override changes that sequence.
- Verify layout wrappers (nodes whose `kind` is a layout container) are reflected in code as matching container semantics.
- Verify responsive adjustments in code match `responsive_overrides` conditions and deltas.
- Fail if: code renders the right elements but violates declared tree structure, sequence ordering semantics, registered kind semantics, or target-runtime guide expectations.

### CC-9: Ordered Chain Honoring
For every active use_case_spec's main chain and branch chains:
- The code must call the listed APIs in the declared order within the use case's execution path.
- Each branch path must diverge from the code path represented by `branch_from_step` and then honor the declared branch chain order.
- Fail if: steps are skipped, reordered in a way that contradicts the contract, or the main or branch chain is broken by early exit not specified in the use-case or api `hoare_contract`.

### CC-10: Impact Boundary Adherence
Using `reuse_and_boundary.impacted_files`:
- Build the allowed set as `modified U created`.
- All real implementation changes must be within that set.
- Files in `modified` must be pre-existing before changes.
- Files in `created` must be newly added by the implementation change.
- Fail if: any changed file is outside `modified U created`, or if a file operation type contradicts its list (`modified` vs `created`).

### CC-11: Concurrency Invariant Respect
For every `concurrency_invariants` entry in active contracts:
- Verify the code enforces the stated invariant (for example exclusive write via lock, atomic operation, or serialized queue).
- Fail if: the invariant claims exclusive access but the code path has no synchronization mechanism.

### CC-12: Trace Link Validity
For every entry in `traceability_and_validation.spec_to_code_trace`:
- The referenced file path must exist in the codebase.
- The referenced contract must have at least one visible implementing artifact at that path.
- Fail if: the file does not exist or the contract's signature is absent from the referenced file.

When `system_architecture` is present, also verify every entry in `traceability_and_validation.architecture_to_code_trace`:
- The referenced file path must exist in the codebase.
- The referenced architecture ID (`subsystem_id` or `root_id`) must have at least one visible implementing artifact at that path.
- Fail if: the file does not exist or the mapped subsystem ownership or composition root wiring is absent from the referenced file.

### CC-13: Reuse Decision Conformance
Using `reuse_and_boundary.api_dependency` and `reuse_and_boundary.extended_modules_summary`:
- Verify implemented call sites follow the planned `updated` decision for each integration point (signature changed vs kept as-is), including use-case chain steps and API-to-API delegation edges.
- Verify extended modules in the implementation match the summarized extended modules and their extension notes.
- Verify no existing modules or APIs that are planned for reuse or extension are re-implemented from scratch or significantly modified beyond the declared extension.
- Fail if: code violates any explicit entry in `api_dependency` or the extended module summary.

### CC-14: Subsystem Ownership Conformance
Run this check only when `system_architecture` is present.
- For every subsystem, verify the implementation artifacts for its `owned_modules` live within `owned_code_artifacts` or files reached through `architecture_to_code_trace`.
- Verify no single implementation artifact ambiguously belongs to multiple subsystems unless the file is an explicit composition root.
- Fail if: a module implementation falls outside its declared ownership boundary or subsystem ownership is ambiguous.

### CC-15: Cross-Subsystem Dependency Conformance
Run this check only when `system_architecture` is present.
- Every real cross-subsystem call or event between declared modules must correspond to a dependency edge declared in `modularity_design.modules[].dependencies`.
- Each such edge must be permitted by the caller subsystem's `dependencies`, must target a module listed in the callee subsystem's `exported` list, and must be explainable through `behavioral_contracts` or `reuse_and_boundary.api_dependency`.
- No undeclared cross-subsystem imports, service calls, or dispatch edges may exist on the implementation path.
- Fail if: code introduces a cross-subsystem edge absent from `modularity_design.modules[].dependencies`, violates the subsystem dependency allowlist, targets a non-exported module, or uses a contract path not declared elsewhere in the spec.

### CC-16: Composition Root Conformance
Run this check only when `system_architecture` is present.
- Every `composition_roots[].entry_files` path must exist in the implementation when the feature is delivered.
- Each composition root must wire only the declared `bootstrapped_modules` or a strict subset justified by feature staging.
- Fail if: the entry file is absent, wires an undeclared module, or omits required module wiring without an explicit staging explanation.

### CC-17: Design Source Visual Conformance
Run this check for every implemented screen whose `ui_layout.screens[].design_source` is present.
- Use the referenced local file directly, or for web sources use the referenced URL as the visual reference.
- Verify implemented user-visible text, images, icons, component styling, colors, typography, spacing, and visual hierarchy match the referenced design source.
- Verify intentional deviations from the design source are explicitly justified by SpecLang requirements, responsive overrides, or stated out-of-scope/iteration constraints.
- Fail if: the implementation satisfies the `ui_layout` tree but visibly diverges from the design source in unapproved style, image, icon, text, spacing, typography, or visual hierarchy details.

---
