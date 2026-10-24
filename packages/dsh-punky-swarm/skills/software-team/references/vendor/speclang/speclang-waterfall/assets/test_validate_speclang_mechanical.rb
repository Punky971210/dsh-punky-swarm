#!/usr/bin/env ruby
# frozen_string_literal: true

require 'minitest/autorun'
require 'tempfile'
require 'tmpdir'
require 'yaml'

require File.expand_path('validate_speclang_mechanical.rb', __dir__)

class MechanicalValidatorTest < Minitest::Test
  TEMPLATE_PATH = File.expand_path('speclang-template.yaml', __dir__)

  CASES = [
    {
      name: 'root_not_mapping',
      raw_text: "- not\n- a\n- mapping\n",
      check_id: 'MC-0',
      finding: 'document root is not a mapping/object',
      location: 'LOCATION: root',
      action: 'Make the YAML root a mapping with the required top-level sections.'
    },
    {
      name: 'yaml_parse_error',
      raw_text: "version: 1\nfeature_context: [\n",
      check_id: 'MC-0',
      finding: 'YAML parser error:',
      location: 'LOCATION: file:',
      action: 'Fix the YAML syntax so the document can be parsed deterministically.'
    },
    {
      name: 'missing_version',
      mutate: ->(_test, data) { data.delete('version') },
      check_id: 'MC-1',
      finding: 'Missing `version` at the document root.',
      location: 'LOCATION: root.version',
      action: 'Add a `version` field to the SpecLang document.'
    },
    {
      name: 'missing_top_level_section',
      mutate: ->(_test, data) { data.delete('ui_layout') },
      check_id: 'MC-1',
      finding: 'Missing required top-level section `ui_layout`.',
      location: 'LOCATION: root.ui_layout',
      action: 'Add the `ui_layout` section to the SpecLang document.'
    },
    {
      name: 'subsystem_entry_not_mapping',
      mutate: ->(_test, data) { data['system_architecture']['subsystems'][0] = 'bad' },
      check_id: 'MC-1',
      finding: 'Each subsystem entry must be a mapping/object.',
      location: 'LOCATION: root.system_architecture.subsystems[0]',
      action: 'Rewrite the subsystem entry as a mapping with the required fields.'
    },
    {
      name: 'composition_root_entry_not_mapping',
      mutate: ->(_test, data) { data['system_architecture']['composition_roots'][0] = 'bad' },
      check_id: 'MC-1',
      finding: 'Each composition root entry must be a mapping/object.',
      location: 'LOCATION: root.system_architecture.composition_roots[0]',
      action: 'Rewrite the composition root entry as a mapping with the required fields.'
    },
    {
      name: 'module_entry_not_mapping',
      mutate: ->(_test, data) { data['modularity_design']['modules'][0] = 'bad' },
      check_id: 'MC-1',
      finding: 'Each module entry must be a mapping/object.',
      location: 'LOCATION: root.modularity_design.modules[0]',
      action: 'Rewrite the module entry as a mapping with the required fields.'
    },
    {
      name: 'module_is_new_not_boolean',
      mutate: ->(test, data) { test.module_entry(data, 'accept_widget_panel')['is_new'] = 'yes' },
      check_id: 'MC-1',
      finding: '`is_new` must be a boolean.',
      location: 'LOCATION: root.modularity_design.modules[0].is_new',
      action: 'Set `is_new` to either `true` or `false`.'
    },
    {
      name: 'module_implementation_file_not_string',
      mutate: ->(test, data) { test.module_entry(data, 'accept_widget_panel')['implementation_file'] = ['src/ui/accept_widget_panel.cj'] },
      check_id: 'MC-1',
      finding: '`implementation_file` must be a scalar string path.',
      location: 'LOCATION: root.modularity_design.modules[0].implementation_file',
      action: 'Rewrite `implementation_file` as a single planned file path for the module implementation.'
    },
    {
      name: 'api_spec_entry_not_mapping',
      mutate: ->(_test, data) { data['behavioral_contracts']['api_specs'][0] = 'bad' },
      check_id: 'MC-1',
      finding: 'Each api spec entry must be a mapping/object.',
      location: 'LOCATION: root.behavioral_contracts.api_specs[0]',
      action: 'Rewrite the api spec entry as a mapping with the required fields.'
    },
    {
      name: 'use_case_entry_not_mapping',
      mutate: ->(_test, data) { data['behavioral_contracts']['use_case_specs'][0] = 'bad' },
      check_id: 'MC-1',
      finding: 'Each use case spec entry must be a mapping/object.',
      location: 'LOCATION: root.behavioral_contracts.use_case_specs[0]',
      action: 'Rewrite the use case spec entry as a mapping with the required fields.'
    },
    {
      name: 'branch_scenario_entry_not_mapping',
      mutate: ->(test, data) { test.use_case_spec(data, 'UC-ACCEPT-VIA-WIDGET')['branch_scenarios'][0] = 'bad' },
      check_id: 'MC-1',
      finding: 'Each branch scenario entry must be a mapping/object.',
      location: 'LOCATION: root.behavioral_contracts.use_case_specs[0].branch_scenarios[0]',
      action: 'Rewrite the branch scenario entry as a mapping with the required fields.'
    },
    {
      name: 'screen_entry_not_mapping',
      mutate: ->(_test, data) { data['ui_layout']['screens'][0] = 'bad' },
      check_id: 'MC-1',
      finding: 'Each screen entry must be a mapping/object.',
      location: 'LOCATION: root.ui_layout.screens[0]',
      action: 'Rewrite the screen entry as a mapping with the required fields.'
    },
    {
      name: 'screen_design_source_not_scalar',
      mutate: ->(_test, data) { data['ui_layout']['screens'][0]['design_source'] = ['design/task_page_accept_widget.html'] },
      check_id: 'MC-1',
      finding: '`design_source` must be a scalar string path or reference.',
      location: 'LOCATION: root.ui_layout.screens[0].design_source',
      action: 'Rewrite `design_source` as a single scalar reference to the prototype source.'
    },
    {
      name: 'screen_design_source_combined_snapshot_reference',
      mutate: ->(_test, data) { data['ui_layout']['screens'][0]['design_source'] = 'https://example.com/prototype/task-page | design_sources/SCREEN-TASK-PAGE.snapshot.html' },
      check_id: 'MC-1',
      finding: '`design_source` must be a single source reference, not a combined source/snapshot reference.',
      location: 'LOCATION: root.ui_layout.screens[0].design_source',
      action: 'Use either a single local file path or a single `http`/`https` URL.'
    },
    {
      name: 'missing_required_field',
      mutate: ->(_test, data) { data['feature_context'].delete('feature_goal') },
      check_id: 'MC-1',
      finding: 'Missing required field `feature_goal`.',
      location: 'LOCATION: root.feature_context.feature_goal',
      action: 'Add `feature_goal` to this object.'
    },
    {
      name: 'required_hash_type',
      mutate: ->(_test, data) { data['feature_context'] = [] },
      check_id: 'MC-1',
      finding: '`root.feature_context` must be a mapping/object.',
      location: 'LOCATION: root.feature_context',
      action: 'Rewrite this section as a mapping/object.'
    },
    {
      name: 'required_list_type',
      mutate: ->(_test, data) { data['feature_context']['source_event_ids'] = 'IE-0001' },
      check_id: 'MC-1',
      finding: '`root.feature_context.source_event_ids` must be a list.',
      location: 'LOCATION: root.feature_context.source_event_ids',
      action: 'Rewrite this field as a YAML list.'
    },
    {
      name: 'invalid_scope_enum',
      mutate: ->(test, data) { test.api_spec(data, 'API-WIDGET-SUBMIT-ACCEPT')['scope'] = 'broken' },
      check_id: 'MC-1',
      finding: 'Expected `root.behavioral_contracts.api_specs[0].scope` to equal `api`, got `broken`.',
      location: 'LOCATION: root.behavioral_contracts.api_specs[0].scope',
      action: 'Set this field to `api`.'
    },
    {
      name: 'invalid_status',
      mutate: ->(test, data) { test.api_spec(data, 'API-WIDGET-SUBMIT-ACCEPT')['status'] = 'broken' },
      check_id: 'MC-1',
      finding: 'Status `broken` is invalid.',
      location: 'LOCATION: root.behavioral_contracts.api_specs[0].status',
      action: 'Use either `active` or `superseded`.'
    },
    {
      name: 'duplicate_contract_id',
      mutate: ->(test, data) { test.use_case_spec(data, 'UC-ACCEPT-VIA-WIDGET')['contract_id'] = 'API-WIDGET-SUBMIT-ACCEPT' },
      check_id: 'MC-2',
      finding: 'Identifier `API-WIDGET-SUBMIT-ACCEPT` appears 2 times.',
      location: 'LOCATION: behavioral_contracts.contract_id',
      action: 'Make every `contract_id` unique across api specs and use case specs.'
    },
    {
      name: 'duplicate_branch_id',
      mutate: lambda do |test, data|
        test.use_case_spec(data, 'UC-ACCEPT-VIA-WIDGET')['branch_scenarios'] << test.branch_scenario(data).dup
      end,
      check_id: 'MC-2',
      finding: 'Identifier `BRANCH-ACCEPT-LIMIT-REACHED` appears 2 times.',
      location: 'LOCATION: behavioral_contracts.use_case_specs[0].branch_scenarios[].branch_id',
      action: 'Make every `branch_id` unique within its parent use case.'
    },
    {
      name: 'api_unknown_module_belonging',
      mutate: ->(test, data) { test.api_spec(data, 'API-WIDGET-SUBMIT-ACCEPT')['module_belonging'] = 'ghost_module' },
      check_id: 'MC-3',
      finding: 'belongs to unknown module `ghost_module`',
      location: 'LOCATION: root.behavioral_contracts.api_specs[0].module_belonging',
      action: 'Point `module_belonging` at a declared module ID from `modularity_design.modules`.'
    },
    {
      name: 'use_case_unknown_involved_module',
      mutate: ->(test, data) { test.use_case_spec(data, 'UC-ACCEPT-VIA-WIDGET')['involved_modules'] << 'ghost_module' },
      check_id: 'MC-3',
      finding: 'references unknown module `ghost_module` in `involved_modules`',
      location: 'LOCATION: root.behavioral_contracts.use_case_specs[0].involved_modules',
      action: 'Replace the module reference with a declared `module_id`.'
    },
    {
      name: 'unresolved_chain_step',
      mutate: ->(test, data) { test.use_case_spec(data, 'UC-ACCEPT-VIA-WIDGET')['ordered_implementation_chain'][0] = 'API-UNKNOWN' },
      check_id: 'MC-3',
      finding: 'references unresolved chain step `API-UNKNOWN`',
      location: 'LOCATION: root.behavioral_contracts.use_case_specs[0].ordered_implementation_chain[0]',
      action: 'Use an active api spec `contract_id` or an active qualified api signature.'
    },
    {
      name: 'resolved_chain_module_missing_from_involved_modules',
      mutate: lambda do |test, data|
        test.use_case_spec(data, 'UC-ACCEPT-VIA-WIDGET')['involved_modules'] = ['accept_widget_panel']
      end,
      check_id: 'MC-3',
      finding: 'resolves chain step `API-COORDINATOR-ORCHESTRATE-ACCEPT` to module `accept_flow_coordinator`, but that module is missing from `involved_modules`.',
      location: 'LOCATION: root.behavioral_contracts.use_case_specs[0].ordered_implementation_chain[1]',
      action: 'Add the resolved module to `involved_modules` or change the chain step.'
    },
    {
      name: 'screen_unknown_ownership_module',
      mutate: ->(_test, data) { data['ui_layout']['screens'][0]['ownership_module'] = 'ghost_module' },
      check_id: 'MC-3',
      finding: 'is owned by unknown module `ghost_module`',
      location: 'LOCATION: root.ui_layout.screens[0].ownership_module',
      action: 'Point `ownership_module` at a declared module ID.'
    },
    {
      name: 'unknown_branch_from_step',
      mutate: ->(test, data) { test.branch_scenario(data)['branch_from_step'] = 'UC-ACCEPT-VIA-WIDGET#BRANCH-GHOST[0]' },
      check_id: 'MC-3',
      finding: 'references unknown `branch_from_step` `UC-ACCEPT-VIA-WIDGET#BRANCH-GHOST[0]`.',
      location: 'LOCATION: root.behavioral_contracts.use_case_specs[0].branch_scenarios[0].branch_from_step',
      action: 'Point `branch_from_step` at a step in the main chain or an earlier branch chain.'
    },
    {
      name: 'spec_to_code_unknown_contract',
      mutate: ->(_test, data) { data['traceability_and_validation']['spec_to_code_trace'][0] = 'API-GHOST -> src/ghost.*' },
      check_id: 'MC-3',
      finding: '`spec_to_code_trace` references unknown contract `API-GHOST`.',
      location: 'LOCATION: root.traceability_and_validation.spec_to_code_trace',
      action: 'Replace the trace entry with a declared `contract_id`.'
    },
    {
      name: 'spec_to_test_unknown_contract',
      mutate: ->(_test, data) { data['traceability_and_validation']['spec_to_test_trace'][0] = 'UC-GHOST -> tests/ghost.*' },
      check_id: 'MC-3',
      finding: '`spec_to_test_trace` references unknown contract `UC-GHOST`.',
      location: 'LOCATION: root.traceability_and_validation.spec_to_test_trace',
      action: 'Replace the trace entry with a declared `contract_id`.'
    },
    {
      name: 'subsystem_owns_unknown_module',
      mutate: ->(_test, data) { data['system_architecture']['subsystems'][0]['owned_modules'] << 'ghost_module' },
      check_id: 'MC-3',
      finding: 'owns unknown module `ghost_module`',
      location: 'LOCATION: root.system_architecture.subsystems[0].owned_modules',
      action: 'Replace the owned module reference with a declared `module_id`.'
    },
    {
      name: 'subsystem_exports_unknown_module',
      mutate: ->(_test, data) { data['system_architecture']['subsystems'][0]['exported'] << 'ghost_module' },
      check_id: 'MC-3',
      finding: 'exports unknown module `ghost_module`',
      location: 'LOCATION: root.system_architecture.subsystems[0].exported',
      action: 'Replace the exported module reference with a declared `module_id`.'
    },
    {
      name: 'subsystem_depends_unknown_subsystem',
      mutate: ->(_test, data) { data['system_architecture']['subsystems'][0]['dependencies'] << 'SUBSYS-GHOST' },
      check_id: 'MC-3',
      finding: 'depends on unknown subsystem `SUBSYS-GHOST`',
      location: 'LOCATION: root.system_architecture.subsystems[0].dependencies',
      action: 'Replace the subsystem dependency with a declared `subsystem_id`.'
    },
    {
      name: 'composition_root_unknown_bootstrapped_module',
      mutate: ->(_test, data) { data['system_architecture']['composition_roots'][0]['bootstrapped_modules'] << 'ghost_module' },
      check_id: 'MC-3',
      finding: 'bootstraps unknown module `ghost_module`',
      location: 'LOCATION: root.system_architecture.composition_roots[0].bootstrapped_modules',
      action: 'Replace the bootstrapped module reference with a declared `module_id`.'
    },
    {
      name: 'architecture_trace_unknown_id',
      mutate: ->(_test, data) { data['traceability_and_validation']['architecture_to_code_trace'][0] = 'SUBSYS-GHOST -> src/ghost.*' },
      check_id: 'MC-3',
      finding: '`architecture_to_code_trace` references unknown architecture ID `SUBSYS-GHOST`.',
      location: 'LOCATION: root.traceability_and_validation.architecture_to_code_trace',
      action: 'Replace the trace entry with a declared `subsystem_id` or `root_id`.'
    },
    {
      name: 'source_event_missing_from_trace',
      mutate: ->(test, data) { test.api_spec(data, 'API-WIDGET-SUBMIT-ACCEPT')['source_event_ids'] = ['IE-GHOST'] },
      check_id: 'MC-3',
      finding: 'Source event ID `IE-GHOST` is missing from `pm_to_spec_trace` and `nl_to_intent_trace`.',
      location: 'LOCATION: root.behavioral_contracts.api_specs[0].source_event_ids',
      action: 'Add the event ID to `pm_to_spec_trace` or mention it explicitly in `nl_to_intent_trace`.'
    },
    {
      name: 'trace_entry_not_string',
      mutate: ->(_test, data) { data['traceability_and_validation']['pm_to_spec_trace'][0] = { 'bad' => 'entry' } },
      check_id: 'MC-3',
      finding: 'Trace entries must be strings of the form `ID -> target`.',
      location: 'LOCATION: root.traceability_and_validation.pm_to_spec_trace[0]',
      action: 'Rewrite the trace entry as a string in `ID -> target` form.'
    },
    {
      name: 'trace_entry_bad_form',
      mutate: ->(_test, data) { data['traceability_and_validation']['pm_to_spec_trace'][0] = 'bad entry' },
      check_id: 'MC-3',
      finding: 'Trace entry `bad entry` is not in `ID -> target` form.',
      location: 'LOCATION: root.traceability_and_validation.pm_to_spec_trace[0]',
      action: 'Rewrite the trace entry as `ID -> target`.'
    },
    {
      name: 'duplicate_ui_id_without_any',
      mutate: ->(test, data) { test.error_text_node(data)['ui_element_id'] = 'UI-ACCEPT-BUTTON' },
      check_id: 'MC-4',
      finding: '`ui_element_id` `UI-ACCEPT-BUTTON` appears multiple times in the layout tree without every occurrence using `repeating_type: any`.',
      location: 'LOCATION: root.ui_layout.screens[0].root.children[0].children[0].children[0].children[0], root.ui_layout.screens[0].root.children[0].children[0].children[0].children[1]',
      action: 'Either make the duplicated node repeatable with `repeating_type: any` or give each occurrence a unique `ui_element_id`.'
    },
    {
      name: 'unknown_ui_id_in_pseudocode',
      mutate: ->(test, data) { test.use_case_spec(data, 'UC-ACCEPT-VIA-WIDGET')['ui_logic_native_pseudocode'][0] = 'Tap(UI-GHOST)' },
      check_id: 'MC-4',
      finding: 'Pseudocode references unknown `ui_element_id` `UI-GHOST`.',
      location: 'LOCATION: root.behavioral_contracts.use_case_specs[0].ui_logic_native_pseudocode[0]',
      action: 'Declare the UI element in `ui_layout` or fix the pseudocode reference.'
    },
    {
      name: 'unknown_ui_id_in_branch_pseudocode',
      mutate: ->(test, data) { test.branch_scenario(data)['ui_logic_native_pseudocode'][0] = 'Show(UI-GHOST)' },
      check_id: 'MC-4',
      finding: 'Pseudocode references unknown `ui_element_id` `UI-GHOST`.',
      location: 'LOCATION: root.behavioral_contracts.use_case_specs[0].branch_scenarios[0].ui_logic_native_pseudocode[0]',
      action: 'Declare the UI element in `ui_layout` or fix the pseudocode reference.'
    },
    {
      name: 'screen_root_not_full_surface',
      mutate: ->(test, data) { test.root_node(data)['kind'] = 'VerticalStack' },
      check_id: 'MC-4',
      finding: 'does not describe a full-page surface.',
      location: 'LOCATION: root.ui_layout.screens[0].root.kind',
      action: 'Use a full-screen container kind such as `Page`, `Screen`, `Modal`, `Drawer`, `Sheet`, or `FullscreenOverlay`.'
    },
    {
      name: 'ui_node_not_mapping',
      mutate: ->(test, data) { test.root_node(data)['children'][0] = 'bad-node' },
      check_id: 'MC-4',
      finding: 'Each UI node must be a mapping/object.',
      location: 'LOCATION: root.ui_layout.screens[0].root.children[0]',
      action: 'Rewrite the UI node as a mapping with at least `kind` and optional structural fields.'
    },
    {
      name: 'ui_node_missing_kind',
      mutate: ->(test, data) { test.primary_button_node(data).delete('kind') },
      check_id: 'MC-4',
      finding: 'UI node is missing `kind`.',
      location: 'LOCATION: root.ui_layout.screens[0].root.children[0].children[0].children[0].children[0].kind',
      action: 'Add a `kind` value for the UI node.'
    },
    {
      name: 'invalid_repeating_type',
      mutate: ->(test, data) { test.primary_button_node(data)['repeating_type'] = 'many' },
      check_id: 'MC-4',
      finding: 'Invalid `repeating_type` `many`.',
      location: 'LOCATION: root.ui_layout.screens[0].root.children[0].children[0].children[0].children[0].repeating_type',
      action: 'Use one of `one`, `optional`, or `any`.'
    },
    {
      name: 'repeating_type_without_ui_id',
      mutate: ->(test, data) { test.root_node(data)['repeating_type'] = 'one' },
      check_id: 'MC-4',
      finding: '`repeating_type` is present on a node without `ui_element_id`.',
      location: 'LOCATION: root.ui_layout.screens[0].root',
      action: 'Only declare `repeating_type` on nodes that also declare `ui_element_id`.'
    },
    {
      name: 'unregistered_ui_kind',
      mutate: ->(test, data) { test.primary_button_node(data)['kind'] = 'MagicButton' },
      check_id: 'MC-4',
      finding: 'UI node kind `MagicButton` is not registered in ui-component-registry.',
      location: 'LOCATION: root.ui_layout.screens[0].root.children[0].children[0].children[0].children[0].kind',
      action: 'Use a kind from `.github/skills/ui-component-registry/assets/kinds-catalog.yaml` or add the kind to the registry first.'
    },
    {
      name: 'ui_logic_operation_not_registered_for_kind',
      mutate: ->(test, data) { test.use_case_spec(data, 'UC-ACCEPT-VIA-WIDGET')['ui_logic_native_pseudocode'][0] = 'Button(id=UI-ACCEPT-BUTTON).fly -> accept_widget_panel.submitAccept(taskId)' },
      check_id: 'MC-4',
      finding: 'Pseudocode uses operation `fly` that is not registered for kind `Button`.',
      location: 'LOCATION: root.behavioral_contracts.use_case_specs[0].ui_logic_native_pseudocode[0]',
      action: 'Use an operation listed under that kind in ui-component-registry/assets/kinds-catalog.yaml.'
    },
    {
      name: 'children_not_list',
      mutate: ->(test, data) { test.root_node(data)['children'] = 'bad-children' },
      check_id: 'MC-4',
      finding: '`children` must be a list.',
      location: 'LOCATION: root.ui_layout.screens[0].root.children',
      action: 'Rewrite `children` as an ordered list of child nodes.'
    },
    {
      name: 'module_self_dependency',
      mutate: ->(test, data) { test.module_entry(data, 'accept_widget_panel')['dependencies'] << 'accept_widget_panel' },
      check_id: 'MC-5',
      finding: '`accept_widget_panel` depends on itself.',
      location: 'LOCATION: modularity_design.modules[0].dependencies',
      action: 'Remove self-dependencies and break any cycle in `modularity_design.modules[].dependencies`.'
    },
    {
      name: 'subsystem_dependency_cycle',
      mutate: ->(_test, data) { data['system_architecture']['subsystems'][1]['dependencies'] << 'SUBSYS-TASK-UI' },
      check_id: 'MC-5',
      finding: 'Dependency cycle detected: SUBSYS-TASK-UI -> SUBSYS-TASK-FLOW -> SUBSYS-TASK-UI.',
      location: 'LOCATION: system_architecture.subsystems',
      action: 'Remove self-dependencies and break any cycle in `system_architecture.subsystems[].dependencies`.'
    },
    {
      name: 'active_contract_missing_trace',
      mutate: ->(_test, data) { data['traceability_and_validation']['spec_to_code_trace'] = ['API-COORDINATOR-ORCHESTRATE-ACCEPT -> src/flow/accept_flow_coordinator.*'] },
      check_id: 'MC-6',
      finding: 'Active contract `API-WIDGET-SUBMIT-ACCEPT` is missing from both `spec_to_code_trace` and `spec_to_test_trace`.',
      location: 'LOCATION: root.traceability_and_validation',
      action: 'Add the contract to `spec_to_code_trace`, `spec_to_test_trace`, or both.'
    },
    {
      name: 'architecture_trace_missing',
      mutate: ->(_test, data) { data['traceability_and_validation']['architecture_to_code_trace'] = data['traceability_and_validation']['architecture_to_code_trace'].reject { |entry| entry.start_with?('SUBSYS-TASK-UI') } },
      check_id: 'MC-6',
      finding: 'Architecture ID `SUBSYS-TASK-UI` is missing from `architecture_to_code_trace`.',
      location: 'LOCATION: root.traceability_and_validation.architecture_to_code_trace',
      action: 'Add a trace entry for the declared subsystem or composition root.'
    },
    {
      name: 'impacted_files_empty',
      mutate: ->(_test, data) { data['reuse_and_boundary']['impacted_files'] = { 'modified' => [], 'created' => [] } },
      check_id: 'MC-6',
      finding: '`impacted_files.modified` and `impacted_files.created` are both empty.',
      location: 'LOCATION: root.reuse_and_boundary.impacted_files',
      action: 'Declare at least one modified or created file path.'
    },
    {
      name: 'impacted_file_in_both_lists',
      mutate: lambda do |_test, data|
        duplicate = data['reuse_and_boundary']['impacted_files']['modified'].first
        data['reuse_and_boundary']['impacted_files']['created'] << duplicate
      end,
      check_id: 'MC-6',
      finding: 'appears in both `modified` and `created`.',
      location: 'LOCATION: root.reuse_and_boundary.impacted_files',
      action: 'List each impacted path in exactly one of `modified` or `created`.'
    },
    {
      name: 'module_implementation_file_missing_from_impacted_files',
      mutate: ->(test, data) { test.module_entry(data, 'accept_widget_panel')['implementation_file'] = 'src/ui/missing_panel.cj' },
      check_id: 'MC-6',
      finding: 'Module `accept_widget_panel` implementation file `src/ui/missing_panel.cj` is missing from `impacted_files.modified` and `impacted_files.created`.',
      location: 'LOCATION: root.modularity_design.modules[0].implementation_file',
      action: 'List every module implementation file in exactly one of `impacted_files.modified` or `impacted_files.created`.'
    },
    {
      name: 'extended_module_missing_extension_note',
      mutate: ->(test, data) { test.module_entry(data, 'accept_flow_coordinator').delete('extension_note') },
      check_id: 'MC-7',
      finding: 'Extended module `accept_flow_coordinator` is missing `extension_note`.',
      location: 'LOCATION: root.modularity_design.modules[1].extension_note',
      action: 'Describe what was extended and why it belongs in this design.'
    },
    {
      name: 'invalid_api_dependency_used_as',
      mutate: ->(_test, data) { data['reuse_and_boundary']['api_dependency'][0]['used as'] = 'broken' },
      check_id: 'MC-7',
      finding: '`used as` must be either `use case step` or `library`, got `broken`.',
      location: 'LOCATION: root.reuse_and_boundary.api_dependency[0].used as',
      action: 'Set `used as` to either `use case step` or `library`.'
    },
    {
      name: 'api_dependency_missing_required_field',
      mutate: ->(_test, data) { data['reuse_and_boundary']['api_dependency'][0].delete('rationale') },
      check_id: 'MC-7',
      finding: 'API dependency entry is missing required field `rationale`.',
      location: 'LOCATION: root.reuse_and_boundary.api_dependency[0]',
      action: 'Add `rationale` to the api dependency entry.'
    },
    {
      name: 'api_dependency_signature_not_qualified',
      mutate: ->(_test, data) { data['reuse_and_boundary']['api_dependency'][4]['signature'] = 'acceptTask(taskId: String): Result<AcceptResult, Error>' },
      check_id: 'MC-7',
      finding: 'is not module-qualified.',
      location: 'LOCATION: root.reuse_and_boundary.api_dependency[4].signature',
      action: 'Use a module-qualified signature such as `module_id.apiName(...)`.'
    },
    {
      name: 'api_dependency_updated_not_boolean',
      mutate: ->(_test, data) { data['reuse_and_boundary']['api_dependency'][0]['updated'] = 'yes' },
      check_id: 'MC-7',
      finding: '`updated` must be a boolean.',
      location: 'LOCATION: root.reuse_and_boundary.api_dependency[0].updated',
      action: 'Set `updated` to either `true` or `false`.'
    },
    {
      name: 'library_dependency_required_by_not_qualified',
      mutate: ->(_test, data) { data['reuse_and_boundary']['api_dependency'][4]['required by'] = 'UC-ACCEPT-VIA-WIDGET' },
      check_id: 'MC-7',
      finding: 'Library dependency `required by` value `UC-ACCEPT-VIA-WIDGET` is not module-qualified.',
      location: 'LOCATION: root.reuse_and_boundary.api_dependency[4].required by',
      action: 'Point `required by` at a module-qualified caller signature.'
    },
    {
      name: 'use_case_step_required_by_unknown_chain_node',
      mutate: ->(_test, data) { data['reuse_and_boundary']['api_dependency'][0]['required by'] = 'UC-GHOST' },
      check_id: 'MC-7',
      finding: 'Use-case-step dependency references unknown chain node `UC-GHOST`.',
      location: 'LOCATION: root.reuse_and_boundary.api_dependency[0].required by',
      action: 'Point `required by` at an existing main-flow or branch chain node identifier.'
    },
    {
      name: 'chain_step_missing_api_dependency_match',
      mutate: lambda do |_test, data|
        data['behavioral_contracts']['use_case_specs'][0]['ordered_implementation_chain'][0] = 'accept_widget_panel.submitAccept(taskId: String): Result<AcceptResult, Error>'
        data['reuse_and_boundary']['api_dependency'].reject! do |entry|
          entry['used as'] == 'use case step' && entry['required by'] == 'UC-ACCEPT-VIA-WIDGET#MAIN[0]'
        end
      end,
      check_id: 'MC-7',
      finding: 'Chain node `UC-ACCEPT-VIA-WIDGET#MAIN[0]` step `accept_widget_panel.submitAccept(taskId: String): Result<AcceptResult, Error>` references an existing qualified signature and must have exactly one matching `api_dependency` entry; found 0.',
      location: 'LOCATION: root.behavioral_contracts.use_case_specs[0].ordered_implementation_chain[0]',
      action: 'For qualified-signature chain steps, create exactly one `api_dependency` entry with `used as: use case step`, the chain node identifier in `required by`, and the resolved api signature in `signature`.'
    },
    {
      name: 'chain_step_duplicate_api_dependency_match',
      mutate: lambda do |_test, data|
        data['behavioral_contracts']['use_case_specs'][0]['ordered_implementation_chain'][0] = 'accept_widget_panel.submitAccept(taskId: String): Result<AcceptResult, Error>'
        data['reuse_and_boundary']['api_dependency'] << data['reuse_and_boundary']['api_dependency'][0].dup
      end,
      check_id: 'MC-7',
      finding: 'Chain node `UC-ACCEPT-VIA-WIDGET#MAIN[0]` step `accept_widget_panel.submitAccept(taskId: String): Result<AcceptResult, Error>` references an existing qualified signature and must have exactly one matching `api_dependency` entry; found 2.',
      location: 'LOCATION: root.behavioral_contracts.use_case_specs[0].ordered_implementation_chain[0]',
      action: 'For qualified-signature chain steps, create exactly one `api_dependency` entry with `used as: use case step`, the chain node identifier in `required by`, and the resolved api signature in `signature`.'
    },
    {
      name: 'subsystem_owned_modules_empty',
      mutate: ->(_test, data) { data['system_architecture']['subsystems'][0]['owned_modules'] = [] },
      check_id: 'MC-8',
      finding: 'Subsystem `SUBSYS-TASK-UI` has an empty `owned_modules` list.',
      location: 'LOCATION: root.system_architecture.subsystems[0].owned_modules',
      action: 'List at least one owned module for the subsystem.'
    },
    {
      name: 'module_owned_by_two_subsystems',
      mutate: ->(_test, data) { data['system_architecture']['subsystems'][1]['owned_modules'] << 'accept_widget_panel' },
      check_id: 'MC-8',
      finding: 'Module `accept_widget_panel` is owned by both `SUBSYS-TASK-UI` and `SUBSYS-TASK-FLOW`.',
      location: 'LOCATION: root.system_architecture.subsystems[1].owned_modules',
      action: 'Assign each owned module to exactly one subsystem.'
    },
    {
      name: 'exported_module_not_owned',
      mutate: ->(_test, data) { data['system_architecture']['subsystems'][1]['exported'] << 'accept_widget_panel' },
      check_id: 'MC-8',
      finding: 'exports `accept_widget_panel` but does not own it.',
      location: 'LOCATION: root.system_architecture.subsystems[1].exported',
      action: 'Only export modules that appear in the subsystem\'s `owned_modules` list.'
    },
    {
      name: 'cross_module_dependency_unassigned_to_subsystem',
      mutate: lambda do |test, data|
        data['modularity_design']['modules'] << {
          'module_id' => 'ghost_module',
          'responsibility' => 'Ghost module for validation testing',
          'dependencies' => [],
          'main_api_signatures' => ['ghost(): Void'],
          'internal_states' => [],
          'is_new' => true
        }
        test.module_entry(data, 'accept_widget_panel')['dependencies'] = ['ghost_module']
      end,
      check_id: 'MC-8',
      finding: 'Cross-module dependency `accept_widget_panel -> ghost_module` cannot be checked because one of the modules is not assigned to a subsystem.',
      location: 'LOCATION: root.modularity_design.modules[0].dependencies',
      action: 'Assign the participating modules to `system_architecture.subsystems[].owned_modules`.'
    },
    {
      name: 'cross_subsystem_dependency_not_permitted',
      mutate: ->(_test, data) { data['system_architecture']['subsystems'][0]['dependencies'] = [] },
      check_id: 'MC-8',
      finding: 'Cross-subsystem dependency `accept_widget_panel -> accept_flow_coordinator` is not permitted because subsystem `SUBSYS-TASK-UI` does not depend on `SUBSYS-TASK-FLOW`.',
      location: 'LOCATION: root.modularity_design.modules[0].dependencies',
      action: 'Add the target subsystem to the caller subsystem\'s `dependencies` list or remove the cross-subsystem dependency.'
    },
    {
      name: 'cross_subsystem_dependency_targets_non_exported_module',
      mutate: ->(_test, data) { data['system_architecture']['subsystems'][1]['exported'] = [] },
      check_id: 'MC-8',
      finding: 'Cross-subsystem dependency `accept_widget_panel -> accept_flow_coordinator` targets a non-exported module in subsystem `SUBSYS-TASK-FLOW`.',
      location: 'LOCATION: root.modularity_design.modules[0].dependencies',
      action: 'Export the target module from the callee subsystem or change the dependency to an exported module.'
    },
    {
      name: 'composition_root_bootstraps_unowned_module',
      mutate: lambda do |_test, data|
        data['modularity_design']['modules'] << {
          'module_id' => 'ghost_module',
          'responsibility' => 'Ghost module for validation testing',
          'dependencies' => [],
          'main_api_signatures' => ['ghost(): Void'],
          'internal_states' => [],
          'is_new' => true
        }
        data['system_architecture']['composition_roots'][0]['bootstrapped_modules'] << 'ghost_module'
      end,
      check_id: 'MC-8',
      finding: 'Composition root `ROOT-TASK-PAGE` bootstraps module `ghost_module` that is not owned by any declared subsystem.',
      location: 'LOCATION: root.system_architecture.composition_roots[0].bootstrapped_modules',
      action: 'Assign the bootstrapped module to a subsystem in `system_architecture.subsystems[].owned_modules`.'
    }
  ].freeze

  def setup
    @template = YAML.safe_load(File.read(TEMPLATE_PATH), permitted_classes: [], aliases: true)
  end

  def test_missing_file_reports_read_error
    missing_path = File.join(Dir.tmpdir, "speclang-missing-#{Process.pid}-#{rand(1_000_000)}.yaml")
    status, stdout, = run_validator(path: missing_path)

    assert_equal 1, status
    assert_includes stdout, 'CHECK [MC-0]: Spec File Read'
    assert_includes stdout, "Spec file `#{missing_path}` does not exist."
    assert_includes stdout, 'LOCATION: file'
    assert_includes stdout, 'Pass a valid SpecLang YAML path to the validator.'
  end

  def test_template_passes_mechanical_validation
    status, stdout, = run_validator(data: deep_copy(@template))

    assert_equal 0, status
    assert_equal "SUMMARY: 0 failures, 0 warnings. [PROCEED: deterministic checks passed]\n", stdout
  end

  def test_web_design_source_url_passes
    data = deep_copy(@template)
    data['ui_layout']['screens'][0]['design_source'] = 'https://example.com/prototype/task-page'

    status, stdout, = run_validator(data: data)

    assert_equal 0, status
    assert_equal "SUMMARY: 0 failures, 0 warnings. [PROCEED: deterministic checks passed]\n", stdout
  end

  CASES.each do |test_case|
    define_method("test_#{test_case[:name]}") do
      status, stdout, = if test_case[:raw_text]
                          run_validator(raw_text: test_case[:raw_text])
                        else
                          data = deep_copy(@template)
                          test_case[:mutate].call(self, data)
                          run_validator(data: data)
                        end

      assert_equal 1, status
      assert_includes stdout, "CHECK [#{test_case[:check_id]}]"
      assert_includes stdout, test_case[:finding]
      assert_includes stdout, test_case[:location]
      assert_includes stdout, test_case[:action]
      assert_includes stdout, 'SUMMARY: '
    end
  end

  def run_validator(data: nil, raw_text: nil, path: nil)
    if path
      return capture_validator(path)
    end

    Tempfile.create(['speclang-validator', '.yaml']) do |file|
      file.write(raw_text || YAML.dump(data))
      file.flush
      capture_validator(file.path)
    end
  end

  def capture_validator(path)
    status = nil
    stdout, stderr = capture_io do
      status = MechanicalValidator.new(path).run
    end
    [status, stdout, stderr]
  end

  def deep_copy(value)
    Marshal.load(Marshal.dump(value))
  end

  def module_entry(data, module_id)
    data['modularity_design']['modules'].find { |entry| entry['module_id'] == module_id }
  end

  def api_spec(data, contract_id)
    data['behavioral_contracts']['api_specs'].find { |entry| entry['contract_id'] == contract_id }
  end

  def use_case_spec(data, contract_id)
    data['behavioral_contracts']['use_case_specs'].find { |entry| entry['contract_id'] == contract_id }
  end

  def branch_scenario(data)
    use_case_spec(data, 'UC-ACCEPT-VIA-WIDGET')['branch_scenarios'][0]
  end

  def root_node(data)
    data['ui_layout']['screens'][0]['root']
  end

  def primary_button_node(data)
    horizontal_pair_node(data)['children'][0]
  end

  def error_text_node(data)
    horizontal_pair_node(data)['children'][1]
  end

  def horizontal_pair_node(data)
    root_node(data)['children'][0]['children'][0]['children'][0]
  end
end
