#!/usr/bin/env ruby
# frozen_string_literal: true

require 'set'
require 'yaml'

class MechanicalValidator
  VALID_REPEATING_TYPES = Set.new(%w[one optional any]).freeze
  SCREEN_CONTAINER_KINDS = Set.new(%w[Page Screen Modal Drawer Sheet FullscreenOverlay]).freeze
  REQUIRED_TOP_LEVEL = %w[
    feature_context
    modularity_design
    behavioral_contracts
    ui_layout
    reuse_and_boundary
    traceability_and_validation
  ].freeze
  VALID_STATUSES = Set.new(%w[active superseded]).freeze

  Finding = Struct.new(:check_id, :check_name, :status, :finding, :location, :action, keyword_init: true)

  def initialize(spec_path)
    @spec_path = spec_path
    @failures = []
    @warnings = []
    @data = nil
    @ui_occurrences = {}
    @ui_registry_kinds = {}
    @ui_registry_loaded = false
  end

  def run
    load_spec
    load_ui_registry
    return report unless @data.is_a?(Hash)

    @system_architecture_present = @data.key?('system_architecture')

    check_required_sections_and_shapes
    collect_indexes
    check_id_uniqueness
    check_reference_resolution
    check_ui_structure
    check_dependency_dags
    check_trace_and_impact_bookkeeping
    check_integration_bookkeeping
    check_architecture_boundaries
    report
  end

  private

  def load_spec
    @data = YAML.safe_load(File.read(@spec_path), permitted_classes: [], aliases: true)
    return if @data.is_a?(Hash)

    fail_check(
      'MC-0',
      'YAML Parse',
      'The SpecLang file parsed successfully but the document root is not a mapping/object.',
      'root',
      'Make the YAML root a mapping with the required top-level sections.'
    )
  rescue Errno::ENOENT
    fail_check(
      'MC-0',
      'Spec File Read',
      "Spec file `#{@spec_path}` does not exist.",
      'file',
      'Pass a valid SpecLang YAML path to the validator.'
    )
  rescue Psych::SyntaxError => error
    location = if error.line && error.column
                 "file:#{error.line}:#{error.column}"
               else
                 'file'
               end
    fail_check(
      'MC-0',
      'YAML Parse',
      "YAML parser error: #{error.problem}.",
      location,
      'Fix the YAML syntax so the document can be parsed deterministically.'
    )
  end

  def load_ui_registry
    registry_path = File.expand_path('../../ui-component-registry/assets/kinds-catalog.yaml', __dir__)
    return unless File.exist?(registry_path)

    registry = YAML.safe_load(File.read(registry_path), permitted_classes: [], aliases: true)
    return unless registry.is_a?(Hash)

    registry.each_value do |items|
      next unless items.is_a?(Array)

      items.each do |item|
        next unless item.is_a?(Hash)
        kind = item['kind']
        operations = item['operations']
        next unless present_scalar?(kind) && operations.is_a?(Array)

        @ui_registry_kinds[kind] = operations.filter_map { |operation| operation['name'] if operation.is_a?(Hash) }.to_set
      end
    end
    @ui_registry_loaded = !@ui_registry_kinds.empty?
  rescue Psych::SyntaxError => error
    warn_check(
      'MC-4',
      'UI Registry Load',
      "Could not parse sibling ui-component-registry catalog: #{error.problem}.",
      registry_path,
      'Fix the UI registry catalog YAML so SpecLang UI kind/operation validation can run.'
    )
  end

  def check_required_sections_and_shapes
    fail_check('MC-1', 'Required Sections', 'Missing `version` at the document root.', 'root.version', 'Add a `version` field to the SpecLang document.') unless @data.key?('version')

    REQUIRED_TOP_LEVEL.each do |section|
      fail_check('MC-1', 'Required Sections', "Missing required top-level section `#{section}`.", "root.#{section}", "Add the `#{section}` section to the SpecLang document.") unless @data.key?(section)
    end

    feature_context = require_hash(@data, 'feature_context', 'root.feature_context')
    require_keys(feature_context, %w[feature_id source_event_ids feature_goal success_signals out_of_scope], 'root.feature_context') if feature_context
    require_array(feature_context, 'source_event_ids', 'root.feature_context.source_event_ids') if feature_context&.key?('source_event_ids')
    require_array(feature_context, 'success_signals', 'root.feature_context.success_signals') if feature_context&.key?('success_signals')
    require_array(feature_context, 'out_of_scope', 'root.feature_context.out_of_scope') if feature_context&.key?('out_of_scope')

    if @system_architecture_present
      system_architecture = require_hash(@data, 'system_architecture', 'root.system_architecture')
      subsystems = require_array(system_architecture, 'subsystems', 'root.system_architecture.subsystems') if system_architecture
      subsystems&.each_with_index do |subsystem, index|
        location = "root.system_architecture.subsystems[#{index}]"
        unless subsystem.is_a?(Hash)
          fail_check('MC-1', 'Required Sections', 'Each subsystem entry must be a mapping/object.', location, 'Rewrite the subsystem entry as a mapping with the required fields.')
          next
        end

        require_keys(subsystem, %w[subsystem_id responsibility owned_modules dependencies owned_code_artifacts], location)
        require_array(subsystem, 'owned_modules', "#{location}.owned_modules") if subsystem.key?('owned_modules')
        require_array(subsystem, 'exported', "#{location}.exported") if subsystem.key?('exported')
        require_array(subsystem, 'dependencies', "#{location}.dependencies") if subsystem.key?('dependencies')
        require_array(subsystem, 'owned_code_artifacts', "#{location}.owned_code_artifacts") if subsystem.key?('owned_code_artifacts')
      end

      if system_architecture&.key?('composition_roots')
        roots = require_array(system_architecture, 'composition_roots', 'root.system_architecture.composition_roots')
        roots&.each_with_index do |root, index|
          location = "root.system_architecture.composition_roots[#{index}]"
          unless root.is_a?(Hash)
            fail_check('MC-1', 'Required Sections', 'Each composition root entry must be a mapping/object.', location, 'Rewrite the composition root entry as a mapping with the required fields.')
            next
          end

          require_keys(root, %w[root_id entry_files bootstrapped_modules responsibility], location)
          require_array(root, 'entry_files', "#{location}.entry_files") if root.key?('entry_files')
          require_array(root, 'bootstrapped_modules', "#{location}.bootstrapped_modules") if root.key?('bootstrapped_modules')
        end
      end
    end

    modularity_design = require_hash(@data, 'modularity_design', 'root.modularity_design')
    modules = require_array(modularity_design, 'modules', 'root.modularity_design.modules') if modularity_design
    require_array(modularity_design, 'shared_data_types', 'root.modularity_design.shared_data_types') if modularity_design&.key?('shared_data_types')
    modules&.each_with_index do |mod, index|
      location = "root.modularity_design.modules[#{index}]"
      unless mod.is_a?(Hash)
        fail_check('MC-1', 'Required Sections', 'Each module entry must be a mapping/object.', location, 'Rewrite the module entry as a mapping with the required fields.')
        next
      end

      require_keys(mod, %w[module_id responsibility dependencies main_api_signatures internal_states is_new implementation_file], location)
      require_array(mod, 'dependencies', "#{location}.dependencies") if mod.key?('dependencies')
      unless mod['implementation_file'].is_a?(String)
        fail_check('MC-1', 'Required Sections', '`implementation_file` must be a scalar string path.', "#{location}.implementation_file", 'Rewrite `implementation_file` as a single planned file path for the module implementation.') if mod.key?('implementation_file')
      end
      require_array(mod, 'main_api_signatures', "#{location}.main_api_signatures") if mod.key?('main_api_signatures')
      require_array(mod, 'internal_states', "#{location}.internal_states") if mod.key?('internal_states')
      unless boolean?(mod['is_new'])
        fail_check('MC-1', 'Required Sections', '`is_new` must be a boolean.', "#{location}.is_new", 'Set `is_new` to either `true` or `false`.') if mod.key?('is_new')
      end
    end

    behavioral_contracts = require_hash(@data, 'behavioral_contracts', 'root.behavioral_contracts')
    api_specs = require_array(behavioral_contracts, 'api_specs', 'root.behavioral_contracts.api_specs') if behavioral_contracts
    use_case_specs = require_array(behavioral_contracts, 'use_case_specs', 'root.behavioral_contracts.use_case_specs') if behavioral_contracts
    api_specs&.each_with_index do |api, index|
      location = "root.behavioral_contracts.api_specs[#{index}]"
      unless api.is_a?(Hash)
        fail_check('MC-1', 'Required Sections', 'Each api spec entry must be a mapping/object.', location, 'Rewrite the api spec entry as a mapping with the required fields.')
        next
      end

      require_keys(api, %w[contract_id module_belonging signature source_event_ids scope status natural_language_summary hoare_contract], location)
      require_array(api, 'source_event_ids', "#{location}.source_event_ids") if api.key?('source_event_ids')
      hoare = require_hash(api, 'hoare_contract', "#{location}.hoare_contract") if api.key?('hoare_contract')
      require_array(hoare, 'pre_condition', "#{location}.hoare_contract.pre_condition") if hoare&.key?('pre_condition')
      require_array(hoare, 'post_condition', "#{location}.hoare_contract.post_condition") if hoare&.key?('post_condition')
      require_array(hoare, 'side_effects', "#{location}.hoare_contract.side_effects") if hoare&.key?('side_effects')
      require_array(api, 'ui_logic_native_pseudocode', "#{location}.ui_logic_native_pseudocode") if api.key?('ui_logic_native_pseudocode')
      validate_enum(api['scope'], 'api', "#{location}.scope", 'MC-1', 'Required Sections') if api.key?('scope')
      validate_status(api['status'], "#{location}.status") if api.key?('status')
    end

    use_case_specs&.each_with_index do |use_case, index|
      location = "root.behavioral_contracts.use_case_specs[#{index}]"
      unless use_case.is_a?(Hash)
        fail_check('MC-1', 'Required Sections', 'Each use case spec entry must be a mapping/object.', location, 'Rewrite the use case spec entry as a mapping with the required fields.')
        next
      end

      require_keys(use_case, %w[contract_id involved_modules source_event_ids scope status natural_language_summary hoare_contract ui_logic_native_pseudocode ordered_implementation_chain acceptance_check], location)
      require_array(use_case, 'involved_modules', "#{location}.involved_modules") if use_case.key?('involved_modules')
      require_array(use_case, 'source_event_ids', "#{location}.source_event_ids") if use_case.key?('source_event_ids')
      require_array(use_case, 'ui_logic_native_pseudocode', "#{location}.ui_logic_native_pseudocode") if use_case.key?('ui_logic_native_pseudocode')
      require_array(use_case, 'ordered_implementation_chain', "#{location}.ordered_implementation_chain") if use_case.key?('ordered_implementation_chain')
      require_array(use_case, 'acceptance_check', "#{location}.acceptance_check") if use_case.key?('acceptance_check')
      branch_scenarios = require_array(use_case, 'branch_scenarios', "#{location}.branch_scenarios") if use_case.key?('branch_scenarios')
      hoare = require_hash(use_case, 'hoare_contract', "#{location}.hoare_contract") if use_case.key?('hoare_contract')
      require_array(hoare, 'pre_condition', "#{location}.hoare_contract.pre_condition") if hoare&.key?('pre_condition')
      require_array(hoare, 'post_condition', "#{location}.hoare_contract.post_condition") if hoare&.key?('post_condition')
      require_array(hoare, 'side_effects', "#{location}.hoare_contract.side_effects") if hoare&.key?('side_effects')
      validate_enum(use_case['scope'], 'use_case', "#{location}.scope", 'MC-1', 'Required Sections') if use_case.key?('scope')
      validate_status(use_case['status'], "#{location}.status") if use_case.key?('status')

      branch_scenarios&.each_with_index do |branch, branch_index|
        branch_location = "#{location}.branch_scenarios[#{branch_index}]"
        unless branch.is_a?(Hash)
          fail_check('MC-1', 'Required Sections', 'Each branch scenario entry must be a mapping/object.', branch_location, 'Rewrite the branch scenario entry as a mapping with the required fields.')
          next
        end

        require_keys(branch, %w[branch_id branch_from_step hoare_contract ui_logic_native_pseudocode ordered_implementation_chain acceptance_check], branch_location)
        require_array(branch, 'ui_logic_native_pseudocode', "#{branch_location}.ui_logic_native_pseudocode") if branch.key?('ui_logic_native_pseudocode')
        require_array(branch, 'ordered_implementation_chain', "#{branch_location}.ordered_implementation_chain") if branch.key?('ordered_implementation_chain')
        require_array(branch, 'acceptance_check', "#{branch_location}.acceptance_check") if branch.key?('acceptance_check')
        branch_hoare = require_hash(branch, 'hoare_contract', "#{branch_location}.hoare_contract") if branch.key?('hoare_contract')
        require_array(branch_hoare, 'pre_condition', "#{branch_location}.hoare_contract.pre_condition") if branch_hoare&.key?('pre_condition')
        require_array(branch_hoare, 'post_condition', "#{branch_location}.hoare_contract.post_condition") if branch_hoare&.key?('post_condition')
        require_array(branch_hoare, 'side_effects', "#{branch_location}.hoare_contract.side_effects") if branch_hoare&.key?('side_effects')
      end
    end

    ui_layout = require_hash(@data, 'ui_layout', 'root.ui_layout')
    screens = require_array(ui_layout, 'screens', 'root.ui_layout.screens') if ui_layout
    screens&.each_with_index do |screen, index|
      location = "root.ui_layout.screens[#{index}]"
      unless screen.is_a?(Hash)
        fail_check('MC-1', 'Required Sections', 'Each screen entry must be a mapping/object.', location, 'Rewrite the screen entry as a mapping with the required fields.')
        next
      end

      require_keys(screen, %w[screen_id ownership_module root], location)
      require_hash(screen, 'root', "#{location}.root") if screen.key?('root')
      if screen.key?('design_source')
        if !screen['design_source'].is_a?(String)
          fail_check('MC-1', 'Required Sections', '`design_source` must be a scalar string path or reference.', "#{location}.design_source", 'Rewrite `design_source` as a single scalar reference to the prototype source.')
        else
          validate_design_source(screen['design_source'], "#{location}.design_source")
        end
      end
      require_array(screen, 'responsive_overrides', "#{location}.responsive_overrides") if screen.key?('responsive_overrides')
    end

    reuse_and_boundary = require_hash(@data, 'reuse_and_boundary', 'root.reuse_and_boundary')
    require_array(reuse_and_boundary, 'related_code_artifacts', 'root.reuse_and_boundary.related_code_artifacts') if reuse_and_boundary&.key?('related_code_artifacts')
    require_array(reuse_and_boundary, 'api_dependency', 'root.reuse_and_boundary.api_dependency') if reuse_and_boundary&.key?('api_dependency')
    require_array(reuse_and_boundary, 'extended_modules_summary', 'root.reuse_and_boundary.extended_modules_summary') if reuse_and_boundary&.key?('extended_modules_summary')
    impacted_files = require_hash(reuse_and_boundary, 'impacted_files', 'root.reuse_and_boundary.impacted_files') if reuse_and_boundary&.key?('impacted_files')
    require_array(impacted_files, 'modified', 'root.reuse_and_boundary.impacted_files.modified') if impacted_files&.key?('modified')
    require_array(impacted_files, 'created', 'root.reuse_and_boundary.impacted_files.created') if impacted_files&.key?('created')

    traceability = require_hash(@data, 'traceability_and_validation', 'root.traceability_and_validation')
    %w[pm_to_spec_trace nl_to_intent_trace spec_to_code_trace spec_to_test_trace].each do |key|
      require_array(traceability, key, "root.traceability_and_validation.#{key}") if traceability&.key?(key)
    end
    if @system_architecture_present && traceability
      require_array(traceability, 'architecture_to_code_trace', 'root.traceability_and_validation.architecture_to_code_trace')
    end
  end

  def collect_indexes
    @feature_context = @data.fetch('feature_context', {}) || {}
    @system_architecture = @data.fetch('system_architecture', {}) || {}
    @modularity_design = @data.fetch('modularity_design', {}) || {}
    @behavioral_contracts = @data.fetch('behavioral_contracts', {}) || {}
    @ui_layout = @data.fetch('ui_layout', {}) || {}
    @reuse_and_boundary = @data.fetch('reuse_and_boundary', {}) || {}
    @traceability = @data.fetch('traceability_and_validation', {}) || {}

    @modules = array_or_empty(@modularity_design['modules'])
    @subsystems = array_or_empty(@system_architecture['subsystems'])
    @composition_roots = array_or_empty(@system_architecture['composition_roots'])
    @api_specs = array_or_empty(@behavioral_contracts['api_specs'])
    @use_case_specs = array_or_empty(@behavioral_contracts['use_case_specs'])
    @api_dependencies = array_or_empty(@reuse_and_boundary['api_dependency'])

    @module_ids = collect_scalar_ids(@modules, 'module_id')
    @subsystem_ids = collect_scalar_ids(@subsystems, 'subsystem_id')
    @root_ids = collect_scalar_ids(@composition_roots, 'root_id')
    @api_contract_ids = collect_scalar_ids(@api_specs, 'contract_id')
    @use_case_contract_ids = collect_scalar_ids(@use_case_specs, 'contract_id')
    @all_contract_ids = @api_contract_ids + @use_case_contract_ids

    @active_api_specs = @api_specs.select { |entry| entry.is_a?(Hash) && entry['status'] == 'active' }
    @active_api_by_contract = {}
    @active_api_by_signature = {}
    @active_api_specs.each do |api|
      @active_api_by_contract[api['contract_id']] = api if api['contract_id']
      canonical_signature = canonical_api_signature(api)
      @active_api_by_signature[api['signature']] = api if api['signature']
      @active_api_by_signature[canonical_signature] = api if canonical_signature
    end

    @active_chain_nodes = {}
    collect_use_case_chain_indexes

    @active_contract_ids = (@api_specs + @use_case_specs).select { |entry| entry.is_a?(Hash) && entry['status'] == 'active' }.map { |entry| entry['contract_id'] }.compact

    @pm_trace_ids = parse_arrow_trace_ids(array_or_empty(@traceability['pm_to_spec_trace']), 'root.traceability_and_validation.pm_to_spec_trace')
    @nl_trace_texts = array_or_empty(@traceability['nl_to_intent_trace']).select { |entry| entry.is_a?(String) }
    @spec_to_code_ids = parse_arrow_trace_ids(array_or_empty(@traceability['spec_to_code_trace']), 'root.traceability_and_validation.spec_to_code_trace')
    @spec_to_test_ids = parse_arrow_trace_ids(array_or_empty(@traceability['spec_to_test_trace']), 'root.traceability_and_validation.spec_to_test_trace')
    @architecture_trace_ids = parse_arrow_trace_ids(array_or_empty(@traceability['architecture_to_code_trace']), 'root.traceability_and_validation.architecture_to_code_trace')
  end

  def check_id_uniqueness
    check_duplicates(@all_contract_ids, 'MC-2', 'Identifier Uniqueness', 'behavioral_contracts.contract_id', 'Make every `contract_id` unique across api specs and use case specs.')
    check_duplicates(@module_ids, 'MC-2', 'Identifier Uniqueness', 'modularity_design.modules[].module_id', 'Make every `module_id` unique in `modularity_design.modules`.')
    @use_case_specs.each_with_index do |use_case, index|
      next unless use_case.is_a?(Hash)

      branch_ids = array_or_empty(use_case['branch_scenarios']).each_with_object([]) do |branch, result|
        next unless branch.is_a?(Hash) && present_scalar?(branch['branch_id'])

        result << branch['branch_id']
      end
      check_duplicates(branch_ids, 'MC-2', 'Identifier Uniqueness', "behavioral_contracts.use_case_specs[#{index}].branch_scenarios[].branch_id", 'Make every `branch_id` unique within its parent use case.')
    end
    check_duplicates(@subsystem_ids, 'MC-2', 'Identifier Uniqueness', 'system_architecture.subsystems[].subsystem_id', 'Make every `subsystem_id` unique in `system_architecture.subsystems`.') if @system_architecture_present
    check_duplicates(@root_ids, 'MC-2', 'Identifier Uniqueness', 'system_architecture.composition_roots[].root_id', 'Make every `root_id` unique in `system_architecture.composition_roots`.') if @system_architecture_present
  end

  def check_reference_resolution
    @api_specs.each_with_index do |api, index|
      next unless api.is_a?(Hash)

      location = "root.behavioral_contracts.api_specs[#{index}]"
      module_belonging = api['module_belonging']
      if module_belonging && !@module_ids.include?(module_belonging)
        fail_check('MC-3', 'Reference Resolution', "API `#{api['contract_id']}` belongs to unknown module `#{module_belonging}`.", "#{location}.module_belonging", 'Point `module_belonging` at a declared module ID from `modularity_design.modules`.')
      end
      check_source_event_ids(api['source_event_ids'], "#{location}.source_event_ids")
    end

    @use_case_specs.each_with_index do |use_case, index|
      next unless use_case.is_a?(Hash)

      location = "root.behavioral_contracts.use_case_specs[#{index}]"
      involved_modules = array_or_empty(use_case['involved_modules'])
      involved_modules.each do |module_id|
        next if @module_ids.include?(module_id)

        fail_check('MC-3', 'Reference Resolution', "Use case `#{use_case['contract_id']}` references unknown module `#{module_id}` in `involved_modules`.", "#{location}.involved_modules", 'Replace the module reference with a declared `module_id`.')
      end
      check_source_event_ids(use_case['source_event_ids'], "#{location}.source_event_ids")

      validate_chain_steps(use_case['contract_id'], involved_modules, array_or_empty(use_case['ordered_implementation_chain']), "#{location}.ordered_implementation_chain")

      visible_anchor_nodes = array_or_empty(use_case['ordered_implementation_chain']).each_index.map do |step_index|
        chain_node_id(use_case['contract_id'], nil, step_index)
      end
      array_or_empty(use_case['branch_scenarios']).each_with_index do |branch, branch_index|
        next unless branch.is_a?(Hash)

        branch_location = "#{location}.branch_scenarios[#{branch_index}]"
        branch_from_step = branch['branch_from_step']
        unless visible_anchor_nodes.include?(branch_from_step)
          fail_check('MC-3', 'Reference Resolution', "Branch scenario `#{branch['branch_id']}` references unknown `branch_from_step` `#{branch_from_step}`.", "#{branch_location}.branch_from_step", 'Point `branch_from_step` at a step in the main chain or an earlier branch chain.')
        end

        branch_steps = array_or_empty(branch['ordered_implementation_chain'])
        validate_chain_steps(use_case['contract_id'], involved_modules, branch_steps, "#{branch_location}.ordered_implementation_chain")
        branch_steps.each_index do |step_index|
          visible_anchor_nodes << chain_node_id(use_case['contract_id'], branch['branch_id'], step_index)
        end
      end
    end

    array_or_empty(@ui_layout['screens']).each_with_index do |screen, index|
      next unless screen.is_a?(Hash)

      module_id = screen['ownership_module']
      next if module_id.nil? || @module_ids.include?(module_id)

      fail_check('MC-3', 'Reference Resolution', "Screen `#{screen['screen_id']}` is owned by unknown module `#{module_id}`.", "root.ui_layout.screens[#{index}].ownership_module", 'Point `ownership_module` at a declared module ID.')
    end

    @spec_to_code_ids.each do |contract_id|
      next if @all_contract_ids.include?(contract_id)

      fail_check('MC-3', 'Reference Resolution', "`spec_to_code_trace` references unknown contract `#{contract_id}`.", 'root.traceability_and_validation.spec_to_code_trace', 'Replace the trace entry with a declared `contract_id`.')
    end

    @spec_to_test_ids.each do |contract_id|
      next if @all_contract_ids.include?(contract_id)

      fail_check('MC-3', 'Reference Resolution', "`spec_to_test_trace` references unknown contract `#{contract_id}`.", 'root.traceability_and_validation.spec_to_test_trace', 'Replace the trace entry with a declared `contract_id`.')
    end

    return unless @system_architecture_present

    @subsystems.each_with_index do |subsystem, index|
      next unless subsystem.is_a?(Hash)

      location = "root.system_architecture.subsystems[#{index}]"
      array_or_empty(subsystem['owned_modules']).each do |module_id|
        next if @module_ids.include?(module_id)

        fail_check('MC-3', 'Reference Resolution', "Subsystem `#{subsystem['subsystem_id']}` owns unknown module `#{module_id}`.", "#{location}.owned_modules", 'Replace the owned module reference with a declared `module_id`.')
      end
      array_or_empty(subsystem['exported']).each do |module_id|
        next if @module_ids.include?(module_id)

        fail_check('MC-3', 'Reference Resolution', "Subsystem `#{subsystem['subsystem_id']}` exports unknown module `#{module_id}`.", "#{location}.exported", 'Replace the exported module reference with a declared `module_id`.')
      end
      array_or_empty(subsystem['dependencies']).each do |subsystem_id|
        next if @subsystem_ids.include?(subsystem_id)

        fail_check('MC-3', 'Reference Resolution', "Subsystem `#{subsystem['subsystem_id']}` depends on unknown subsystem `#{subsystem_id}`.", "#{location}.dependencies", 'Replace the subsystem dependency with a declared `subsystem_id`.')
      end
    end

    @composition_roots.each_with_index do |root, index|
      next unless root.is_a?(Hash)

      location = "root.system_architecture.composition_roots[#{index}]"
      array_or_empty(root['bootstrapped_modules']).each do |module_id|
        next if @module_ids.include?(module_id)

        fail_check('MC-3', 'Reference Resolution', "Composition root `#{root['root_id']}` bootstraps unknown module `#{module_id}`.", "#{location}.bootstrapped_modules", 'Replace the bootstrapped module reference with a declared `module_id`.')
      end
    end

    allowed_architecture_ids = @subsystem_ids + @root_ids
    @architecture_trace_ids.each do |trace_id|
      next if allowed_architecture_ids.include?(trace_id)

      fail_check('MC-3', 'Reference Resolution', "`architecture_to_code_trace` references unknown architecture ID `#{trace_id}`.", 'root.traceability_and_validation.architecture_to_code_trace', 'Replace the trace entry with a declared `subsystem_id` or `root_id`.')
    end
  end

  def check_ui_structure
    array_or_empty(@ui_layout['screens']).each_with_index do |screen, index|
      next unless screen.is_a?(Hash)

      root = screen['root']
      if root.is_a?(Hash) && !SCREEN_CONTAINER_KINDS.include?(root['kind'])
        fail_check('MC-4', 'UI Tree Structural Validity', "Screen `#{screen['screen_id']}` root kind `#{root['kind']}` does not describe a full-page surface.", "root.ui_layout.screens[#{index}].root.kind", 'Use a full-screen container kind such as `Page`, `Screen`, `Modal`, `Drawer`, `Sheet`, or `FullscreenOverlay`.')
      end

      traverse_ui_node(screen['root'], "root.ui_layout.screens[#{index}].root")
    end

    @ui_occurrences.each do |ui_id, occurrences|
      next if occurrences.length <= 1
      next if occurrences.all? { |occurrence| occurrence[:repeating_type] == 'any' }

      fail_check(
        'MC-4',
        'UI Tree Structural Validity',
        "`ui_element_id` `#{ui_id}` appears multiple times in the layout tree without every occurrence using `repeating_type: any`.",
        occurrences.map { |occurrence| occurrence[:location] }.join(', '),
        'Either make the duplicated node repeatable with `repeating_type: any` or give each occurrence a unique `ui_element_id`.'
      )
    end

    collect_ui_logic_entries.each do |location, line|
      extract_ui_ids_from_pseudocode(line).each do |ui_id|
        next if @ui_occurrences.key?(ui_id)

        fail_check('MC-4', 'UI Tree Structural Validity', "Pseudocode references unknown `ui_element_id` `#{ui_id}`.", location, 'Declare the UI element in `ui_layout` or fix the pseudocode reference.')
      end

      validate_ui_logic_operations(line, location)
    end
  end

  def check_dependency_dags
    check_self_and_cycles(@modules, 'module_id', 'dependencies', 'MC-5', 'Dependency DAGs', 'modularity_design.modules', 'Remove self-dependencies and break any cycle in `modularity_design.modules[].dependencies`.')
    return unless @system_architecture_present

    check_self_and_cycles(@subsystems, 'subsystem_id', 'dependencies', 'MC-5', 'Dependency DAGs', 'system_architecture.subsystems', 'Remove self-dependencies and break any cycle in `system_architecture.subsystems[].dependencies`.')
  end

  def check_trace_and_impact_bookkeeping
    traced_contract_ids = (@spec_to_code_ids + @spec_to_test_ids).uniq
    @active_contract_ids.each do |contract_id|
      next if traced_contract_ids.include?(contract_id)

      fail_check('MC-6', 'Trace and Impact Bookkeeping', "Active contract `#{contract_id}` is missing from both `spec_to_code_trace` and `spec_to_test_trace`.", 'root.traceability_and_validation', 'Add the contract to `spec_to_code_trace`, `spec_to_test_trace`, or both.')
    end

    if @system_architecture_present
      traced_architecture_ids = @architecture_trace_ids.uniq
      (@subsystem_ids + @root_ids).each do |architecture_id|
        next if traced_architecture_ids.include?(architecture_id)

        fail_check('MC-6', 'Trace and Impact Bookkeeping', "Architecture ID `#{architecture_id}` is missing from `architecture_to_code_trace`.", 'root.traceability_and_validation.architecture_to_code_trace', 'Add a trace entry for the declared subsystem or composition root.')
      end
    end

    impacted_files = @reuse_and_boundary.fetch('impacted_files', {}) || {}
    modified = array_or_empty(impacted_files['modified'])
    created = array_or_empty(impacted_files['created'])

    if modified.empty? && created.empty?
      fail_check('MC-6', 'Trace and Impact Bookkeeping', '`impacted_files.modified` and `impacted_files.created` are both empty.', 'root.reuse_and_boundary.impacted_files', 'Declare at least one modified or created file path.')
    end

    duplicates = modified & created
    duplicates.each do |path|
      fail_check('MC-6', 'Trace and Impact Bookkeeping', "Impacted file path `#{path}` appears in both `modified` and `created`.", 'root.reuse_and_boundary.impacted_files', 'List each impacted path in exactly one of `modified` or `created`.')
    end

    allowed_impacted_paths = (modified + created).uniq
    @modules.each_with_index do |mod, index|
      next unless mod.is_a?(Hash)
      next unless mod['implementation_file'].is_a?(String)
      next if allowed_impacted_paths.include?(mod['implementation_file'])

      fail_check('MC-6', 'Trace and Impact Bookkeeping', "Module `#{mod['module_id']}` implementation file `#{mod['implementation_file']}` is missing from `impacted_files.modified` and `impacted_files.created`.", "root.modularity_design.modules[#{index}].implementation_file", 'List every module implementation file in exactly one of `impacted_files.modified` or `impacted_files.created`.')
    end
  end

  def check_integration_bookkeeping
    @modules.each_with_index do |mod, index|
      next unless mod.is_a?(Hash)
      next unless mod['is_new'] == false
      next if present_scalar?(mod['extension_note'])

      fail_check('MC-7', 'Integration Bookkeeping', "Extended module `#{mod['module_id']}` is missing `extension_note`.", "root.modularity_design.modules[#{index}].extension_note", 'Describe what was extended and why it belongs in this design.')
    end

    @api_dependencies.each_with_index do |dependency, index|
      next unless dependency.is_a?(Hash)

      location = "root.reuse_and_boundary.api_dependency[#{index}]"
      used_as = dependency['used as']
      unless ['use case step', 'library'].include?(used_as)
        fail_check('MC-7', 'Integration Bookkeeping', "`used as` must be either `use case step` or `library`, got `#{used_as}`.", "#{location}.used as", 'Set `used as` to either `use case step` or `library`.')
        next
      end

      ['required by', 'signature', 'updated', 'rationale'].each do |key|
        next if dependency.key?(key)

        fail_check('MC-7', 'Integration Bookkeeping', "API dependency entry is missing required field `#{key}`.", location, "Add `#{key}` to the api dependency entry.")
      end

      unless qualified_signature?(dependency['signature'])
        fail_check('MC-7', 'Integration Bookkeeping', "API dependency signature `#{dependency['signature']}` is not module-qualified.", "#{location}.signature", 'Use a module-qualified signature such as `module_id.apiName(...)`.') if dependency.key?('signature')
      end

      unless boolean?(dependency['updated'])
        fail_check('MC-7', 'Integration Bookkeeping', '`updated` must be a boolean.', "#{location}.updated", 'Set `updated` to either `true` or `false`.') if dependency.key?('updated')
      end

      if used_as == 'library' && !qualified_signature?(dependency['required by'])
        fail_check('MC-7', 'Integration Bookkeeping', "Library dependency `required by` value `#{dependency['required by']}` is not module-qualified.", "#{location}.required by", 'Point `required by` at a module-qualified caller signature.')
      end

      if used_as == 'use case step' && dependency['required by'] && !@active_chain_nodes.key?(dependency['required by'])
        fail_check('MC-7', 'Integration Bookkeeping', "Use-case-step dependency references unknown chain node `#{dependency['required by']}`.", "#{location}.required by", 'Point `required by` at an existing main-flow or branch chain node identifier.')
      end
    end

    @active_chain_nodes.each_value do |chain_node|
      next unless chain_step_requires_use_case_step_dependency?(chain_node[:step])

      target_signature = resolve_step_signature(chain_node[:step])
      next unless target_signature

      matches = @api_dependencies.select do |dependency|
        dependency.is_a?(Hash) &&
          dependency['used as'] == 'use case step' &&
          dependency['required by'] == chain_node[:node_id] &&
          dependency['signature'] == target_signature
      end

      next if matches.length == 1

      fail_check(
        'MC-7',
        'Integration Bookkeeping',
        "Chain node `#{chain_node[:node_id]}` step `#{chain_node[:step]}` references an existing qualified signature and must have exactly one matching `api_dependency` entry; found #{matches.length}.",
        chain_node[:location],
        'For qualified-signature chain steps, create exactly one `api_dependency` entry with `used as: use case step`, the chain node identifier in `required by`, and the resolved api signature in `signature`.'
      )
    end
  end

  def check_architecture_boundaries
    return unless @system_architecture_present

    owned_by = {}
    @subsystems.each_with_index do |subsystem, index|
      next unless subsystem.is_a?(Hash)

      location = "root.system_architecture.subsystems[#{index}]"
      owned_modules = array_or_empty(subsystem['owned_modules'])
      if owned_modules.empty?
        fail_check('MC-8', 'Architecture Boundary Structure', "Subsystem `#{subsystem['subsystem_id']}` has an empty `owned_modules` list.", "#{location}.owned_modules", 'List at least one owned module for the subsystem.')
      end

      owned_modules.each do |module_id|
        if owned_by.key?(module_id)
          fail_check('MC-8', 'Architecture Boundary Structure', "Module `#{module_id}` is owned by both `#{owned_by[module_id]}` and `#{subsystem['subsystem_id']}`.", "#{location}.owned_modules", 'Assign each owned module to exactly one subsystem.')
        else
          owned_by[module_id] = subsystem['subsystem_id']
        end
      end

      exported = array_or_empty(subsystem['exported'])
      exported.each do |module_id|
        next if owned_modules.include?(module_id)

        fail_check('MC-8', 'Architecture Boundary Structure', "Subsystem `#{subsystem['subsystem_id']}` exports `#{module_id}` but does not own it.", "#{location}.exported", 'Only export modules that appear in the subsystem\'s `owned_modules` list.')
      end
    end

    subsystem_by_id = @subsystems.each_with_object({}) do |subsystem, result|
      next unless subsystem.is_a?(Hash) && subsystem['subsystem_id']
      result[subsystem['subsystem_id']] = subsystem
    end

    @modules.each_with_index do |mod, index|
      next unless mod.is_a?(Hash)

      source_module = mod['module_id']
      source_subsystem_id = owned_by[source_module]
      array_or_empty(mod['dependencies']).each do |target_module|
        next unless @module_ids.include?(target_module)

        target_subsystem_id = owned_by[target_module]
        if source_subsystem_id.nil? || target_subsystem_id.nil?
          fail_check('MC-8', 'Architecture Boundary Structure', "Cross-module dependency `#{source_module} -> #{target_module}` cannot be checked because one of the modules is not assigned to a subsystem.", "root.modularity_design.modules[#{index}].dependencies", 'Assign the participating modules to `system_architecture.subsystems[].owned_modules`.')
          next
        end

        next if source_subsystem_id == target_subsystem_id

        source_subsystem = subsystem_by_id[source_subsystem_id]
        target_subsystem = subsystem_by_id[target_subsystem_id]
        unless array_or_empty(source_subsystem['dependencies']).include?(target_subsystem_id)
          fail_check('MC-8', 'Architecture Boundary Structure', "Cross-subsystem dependency `#{source_module} -> #{target_module}` is not permitted because subsystem `#{source_subsystem_id}` does not depend on `#{target_subsystem_id}`.", "root.modularity_design.modules[#{index}].dependencies", 'Add the target subsystem to the caller subsystem\'s `dependencies` list or remove the cross-subsystem dependency.')
        end

        unless array_or_empty(target_subsystem['exported']).include?(target_module)
          fail_check('MC-8', 'Architecture Boundary Structure', "Cross-subsystem dependency `#{source_module} -> #{target_module}` targets a non-exported module in subsystem `#{target_subsystem_id}`.", "root.modularity_design.modules[#{index}].dependencies", 'Export the target module from the callee subsystem or change the dependency to an exported module.')
        end
      end
    end

    @composition_roots.each_with_index do |root, index|
      next unless root.is_a?(Hash)

      location = "root.system_architecture.composition_roots[#{index}].bootstrapped_modules"
      array_or_empty(root['bootstrapped_modules']).each do |module_id|
        next if owned_by.key?(module_id)

        fail_check('MC-8', 'Architecture Boundary Structure', "Composition root `#{root['root_id']}` bootstraps module `#{module_id}` that is not owned by any declared subsystem.", location, 'Assign the bootstrapped module to a subsystem in `system_architecture.subsystems[].owned_modules`.')
      end
    end
  end

  def collect_ui_logic_entries
    entries = []
    @api_specs.each_with_index do |api, index|
      next unless api.is_a?(Hash)
      array_or_empty(api['ui_logic_native_pseudocode']).each_with_index do |line, line_index|
        entries << ["root.behavioral_contracts.api_specs[#{index}].ui_logic_native_pseudocode[#{line_index}]", line.to_s]
      end
    end
    @use_case_specs.each_with_index do |use_case, index|
      next unless use_case.is_a?(Hash)
      array_or_empty(use_case['ui_logic_native_pseudocode']).each_with_index do |line, line_index|
        entries << ["root.behavioral_contracts.use_case_specs[#{index}].ui_logic_native_pseudocode[#{line_index}]", line.to_s]
      end
      array_or_empty(use_case['branch_scenarios']).each_with_index do |branch, branch_index|
        next unless branch.is_a?(Hash)

        array_or_empty(branch['ui_logic_native_pseudocode']).each_with_index do |line, line_index|
          entries << ["root.behavioral_contracts.use_case_specs[#{index}].branch_scenarios[#{branch_index}].ui_logic_native_pseudocode[#{line_index}]", line.to_s]
        end
      end
    end
    entries
  end

  def collect_use_case_chain_indexes
    @use_case_specs.each_with_index do |use_case, use_case_index|
      next unless use_case.is_a?(Hash)
      next unless use_case['status'] == 'active'

      use_case_id = use_case['contract_id']
      location = "root.behavioral_contracts.use_case_specs[#{use_case_index}]"

      array_or_empty(use_case['ordered_implementation_chain']).each_with_index do |step, step_index|
        node_id = chain_node_id(use_case_id, nil, step_index)
        @active_chain_nodes[node_id] = {
          node_id: node_id,
          step: step,
          location: "#{location}.ordered_implementation_chain[#{step_index}]"
        }
      end

      array_or_empty(use_case['branch_scenarios']).each_with_index do |branch, branch_index|
        next unless branch.is_a?(Hash)

        branch_id = branch['branch_id']
        branch_location = "#{location}.branch_scenarios[#{branch_index}]"
        array_or_empty(branch['ordered_implementation_chain']).each_with_index do |step, step_index|
          node_id = chain_node_id(use_case_id, branch_id, step_index)
          @active_chain_nodes[node_id] = {
            node_id: node_id,
            step: step,
            location: "#{branch_location}.ordered_implementation_chain[#{step_index}]"
          }
        end
      end
    end
  end

  def extract_ui_ids_from_pseudocode(line)
    ids = []
    [
      /id=([A-Za-z0-9_-]+)/,
      /\b(?:Tap|Show|Hide|Focus|Select|Transition|Open|Close)\(([A-Za-z0-9_-]+)/,
      /\bUI-[A-Za-z0-9_-]+\b/
    ].each do |pattern|
      line.scan(pattern) do |match|
        ids << (match.is_a?(Array) ? match.first : match)
      end
    end
    ids.compact.uniq
  end

  def traverse_ui_node(node, location)
    unless node.is_a?(Hash)
      fail_check('MC-4', 'UI Tree Structural Validity', 'Each UI node must be a mapping/object.', location, 'Rewrite the UI node as a mapping with at least `kind` and optional structural fields.')
      return
    end

    kind = node['kind']
    unless present_scalar?(kind)
      fail_check('MC-4', 'UI Tree Structural Validity', 'UI node is missing `kind`.', "#{location}.kind", 'Add a `kind` value for the UI node.')
      return
    end

    if @ui_registry_loaded && !@ui_registry_kinds.key?(kind)
      fail_check('MC-4', 'UI Tree Structural Validity', "UI node kind `#{kind}` is not registered in ui-component-registry.", "#{location}.kind", 'Use a kind from `.github/skills/ui-component-registry/assets/kinds-catalog.yaml` or add the kind to the registry first.')
    end

    ui_id = node['ui_element_id']
    repeating_type = node.key?('repeating_type') ? node['repeating_type'] : nil

    if repeating_type && !VALID_REPEATING_TYPES.include?(repeating_type)
      fail_check('MC-4', 'UI Tree Structural Validity', "Invalid `repeating_type` `#{repeating_type}`.", "#{location}.repeating_type", 'Use one of `one`, `optional`, or `any`.')
    end

    if repeating_type && ui_id.nil?
      fail_check('MC-4', 'UI Tree Structural Validity', '`repeating_type` is present on a node without `ui_element_id`.', location, 'Only declare `repeating_type` on nodes that also declare `ui_element_id`.')
    end

    if ui_id
      @ui_occurrences[ui_id] ||= []
      @ui_occurrences[ui_id] << { location: location, repeating_type: repeating_type || 'one', kind: kind }
    end

    return unless node.key?('children')

    children = node['children']
    unless children.is_a?(Array)
      fail_check('MC-4', 'UI Tree Structural Validity', '`children` must be a list.', "#{location}.children", 'Rewrite `children` as an ordered list of child nodes.')
      return
    end

    children.each_with_index do |child, index|
      traverse_ui_node(child, "#{location}.children[#{index}]")
    end
  end

  def validate_ui_logic_operations(line, location)
    return unless @ui_registry_loaded

    line.scan(/([A-Za-z][A-Za-z0-9]+)\(id=([A-Za-z0-9_-]+)\)\.([A-Za-z][A-Za-z0-9]+)/) do |kind, ui_id, operation|
      registered_operations = @ui_registry_kinds[kind]
      unless registered_operations
        fail_check('MC-4', 'UI Tree Structural Validity', "Pseudocode uses unregistered UI kind `#{kind}`.", location, 'Use a kind from ui-component-registry or add the kind to the registry first.')
        next
      end

      unless registered_operations.include?(operation)
        fail_check('MC-4', 'UI Tree Structural Validity', "Pseudocode uses operation `#{operation}` that is not registered for kind `#{kind}`.", location, 'Use an operation listed under that kind in ui-component-registry/assets/kinds-catalog.yaml.')
      end

      occurrences = @ui_occurrences[ui_id] || []
      next if occurrences.empty?
      next if occurrences.any? { |occurrence| occurrence[:kind] == kind }

      declared_kinds = occurrences.map { |occurrence| occurrence[:kind] }.uniq.join(', ')
      fail_check('MC-4', 'UI Tree Structural Validity', "Pseudocode references `#{kind}(id=#{ui_id})`, but `#{ui_id}` is declared as kind `#{declared_kinds}` in `ui_layout`.", location, 'Make the pseudocode kind match the declared layout node kind.')
    end
  end

  def resolve_chain_step(step)
    return @active_api_by_contract[step] if @active_api_by_contract.key?(step)
    return @active_api_by_signature[step] if @active_api_by_signature.key?(step)

    nil
  end

  def resolve_step_signature(step)
    resolved_api = resolve_chain_step(step)
    resolved_api && canonical_api_signature(resolved_api)
  end

  def chain_step_requires_use_case_step_dependency?(step)
    qualified_signature?(step)
  end

  def validate_chain_steps(use_case_id, involved_modules, steps, location_prefix)
    steps.each_with_index do |step, step_index|
      resolved_api = resolve_chain_step(step)
      step_location = "#{location_prefix}[#{step_index}]"
      unless resolved_api
        fail_check('MC-3', 'Reference Resolution', "Use case `#{use_case_id}` references unresolved chain step `#{step}`.", step_location, 'Use an active api spec `contract_id` or an active qualified api signature.')
        next
      end

      resolved_module = resolved_api['module_belonging']
      next if resolved_module.nil? || involved_modules.include?(resolved_module)

      fail_check('MC-3', 'Reference Resolution', "Use case `#{use_case_id}` resolves chain step `#{step}` to module `#{resolved_module}`, but that module is missing from `involved_modules`.", step_location, 'Add the resolved module to `involved_modules` or change the chain step.')
    end
  end

  def chain_node_id(use_case_id, branch_id, step_index)
    return "#{use_case_id}#MAIN[#{step_index}]" if branch_id.nil? || branch_id.to_s.empty?

    "#{use_case_id}##{branch_id}[#{step_index}]"
  end

  def canonical_api_signature(api)
    return nil unless api.is_a?(Hash) && present_scalar?(api['signature'])
    return api['signature'] if qualified_signature?(api['signature'])
    return nil unless present_scalar?(api['module_belonging'])

    "#{api['module_belonging']}.#{api['signature']}"
  end

  def check_source_event_ids(source_event_ids, location)
    array_or_empty(source_event_ids).each do |event_id|
      next if @pm_trace_ids.include?(event_id)
      next if @nl_trace_texts.any? { |entry| entry.include?(event_id.to_s) }

      fail_check('MC-3', 'Reference Resolution', "Source event ID `#{event_id}` is missing from `pm_to_spec_trace` and `nl_to_intent_trace`.", location, 'Add the event ID to `pm_to_spec_trace` or mention it explicitly in `nl_to_intent_trace`.')
    end
  end

  def check_self_and_cycles(entries, id_key, dep_key, check_id, check_name, location, action)
    adjacency = {}
    ids = []

    entries.each_with_index do |entry, index|
      next unless entry.is_a?(Hash)

      node_id = entry[id_key]
      next unless node_id

      ids << node_id
      dependencies = array_or_empty(entry[dep_key])
      adjacency[node_id] = dependencies
      if dependencies.include?(node_id)
        fail_check(check_id, check_name, "`#{node_id}` depends on itself.", "#{location}[#{index}].#{dep_key}", action)
      end
    end

    cycle = find_cycle(ids.uniq, adjacency)
    return unless cycle

    fail_check(check_id, check_name, "Dependency cycle detected: #{cycle.join(' -> ')}.", location, action)
  end

  def find_cycle(nodes, adjacency)
    visited = {}
    stack = {}
    path = []
    cycle = nil

    visit = lambda do |node|
      visited[node] = true
      stack[node] = true
      path << node

      array_or_empty(adjacency[node]).each do |neighbor|
        next unless nodes.include?(neighbor)

        if !visited[neighbor]
          visit.call(neighbor)
          return if cycle
        elsif stack[neighbor]
          start_index = path.index(neighbor) || 0
          cycle = path[start_index..] + [neighbor]
          return
        end
      end

      stack.delete(node)
      path.pop
    end

    nodes.each do |node|
      next if visited[node] || cycle

      visit.call(node)
    end

    cycle
  end

  def parse_arrow_trace_ids(entries, location)
    ids = []
    entries.each_with_index do |entry, index|
      unless entry.is_a?(String)
        fail_check('MC-3', 'Reference Resolution', 'Trace entries must be strings of the form `ID -> target`.', "#{location}[#{index}]", 'Rewrite the trace entry as a string in `ID -> target` form.')
        next
      end

      parts = entry.split('->', 2).map(&:strip)
      if parts.length != 2 || parts.any?(&:empty?)
        fail_check('MC-3', 'Reference Resolution', "Trace entry `#{entry}` is not in `ID -> target` form.", "#{location}[#{index}]", 'Rewrite the trace entry as `ID -> target`.')
        next
      end

      ids << parts.first
    end
    ids
  end

  def check_duplicates(values, check_id, check_name, location, action)
    counts = Hash.new(0)
    values.compact.each { |value| counts[value] += 1 }
    counts.each do |value, count|
      next if count == 1

      fail_check(check_id, check_name, "Identifier `#{value}` appears #{count} times.", location, action)
    end
  end

  def require_keys(object, keys, location)
    keys.each do |key|
      next if object.key?(key)

      fail_check('MC-1', 'Required Sections', "Missing required field `#{key}`.", "#{location}.#{key}", "Add `#{key}` to this object.")
    end
  end

  def require_hash(parent, key, location)
    return nil unless parent.is_a?(Hash)

    value = parent[key]
    unless value.is_a?(Hash)
      fail_check('MC-1', 'Required Sections', "`#{location}` must be a mapping/object.", location, 'Rewrite this section as a mapping/object.')
      return nil
    end
    value
  end

  def require_array(parent, key, location)
    return nil unless parent.is_a?(Hash)

    value = parent[key]
    unless value.is_a?(Array)
      fail_check('MC-1', 'Required Sections', "`#{location}` must be a list.", location, 'Rewrite this field as a YAML list.')
      return nil
    end
    value
  end

  def validate_enum(value, expected, location, check_id, check_name)
    return if value == expected

    fail_check(check_id, check_name, "Expected `#{location}` to equal `#{expected}`, got `#{value}`.", location, "Set this field to `#{expected}`.")
  end

  def validate_status(value, location)
    return if VALID_STATUSES.include?(value)

    fail_check('MC-1', 'Required Sections', "Status `#{value}` is invalid.", location, 'Use either `active` or `superseded`.')
  end

  def validate_design_source(value, location)
    stripped = value.strip
    if stripped.empty? || stripped.include?("\n")
      fail_check('MC-1', 'Required Sections', '`design_source` must be a non-empty single-line scalar reference.', location, 'Use either `<local-file-path>` or `<http-or-https-url>`.')
      return
    end

    if stripped.include?(' | ')
      fail_check('MC-1', 'Required Sections', '`design_source` must be a single source reference, not a combined source/snapshot reference.', location, 'Use either a single local file path or a single `http`/`https` URL.')
      return
    end

    return if web_url?(stripped)

    if stripped.match?(/\s/)
      fail_check('MC-1', 'Required Sections', '`design_source` local file paths must not contain whitespace or prose.', location, 'Use a single local file path or a single `http`/`https` URL without free-form description.')
      return
    end
  end

  def web_url?(value)
    value.match?(/\Ahttps?:\/\/\S+\z/)
  end

  def array_or_empty(value)
    value.is_a?(Array) ? value : []
  end

  def collect_scalar_ids(entries, key)
    entries.each_with_object([]) do |entry, result|
      next unless entry.is_a?(Hash) && present_scalar?(entry[key])

      result << entry[key]
    end
  end

  def qualified_signature?(value)
    value.is_a?(String) && value.match?(/\A[[:alnum:]_-]+\.[^(]+\(.*/)
  end

  def boolean?(value)
    value == true || value == false
  end

  def present_scalar?(value)
    value.is_a?(String) ? !value.strip.empty? : !value.nil?
  end

  def fail_check(check_id, check_name, finding, location, action)
    @failures << Finding.new(
      check_id: check_id,
      check_name: check_name,
      status: 'FAIL',
      finding: finding,
      location: location,
      action: action
    )
  end

  def warn_check(check_id, check_name, finding, location, action)
    @warnings << Finding.new(
      check_id: check_id,
      check_name: check_name,
      status: 'WARN',
      finding: finding,
      location: location,
      action: action
    )
  end

  def report
    @failures.each do |failure|
      puts "CHECK [#{failure.check_id}]: #{failure.check_name}"
      puts "STATUS: #{failure.status}"
      puts "FINDING: #{failure.finding}"
      puts "LOCATION: #{failure.location}"
      puts "ACTION REQUIRED: #{failure.action}"
      puts
    end

    if @failures.empty?
      puts 'SUMMARY: 0 failures, 0 warnings. [PROCEED: deterministic checks passed]'
      return 0
    end

    puts "SUMMARY: #{@failures.length} failures, #{@warnings.length} warnings. [BLOCK: fix mechanical violations before AI review]"
    1
  end
end

if __FILE__ == $PROGRAM_NAME
  if ARGV.length != 1
    warn 'Usage: ruby .github/skills/speclang-waterfall/assets/validate_speclang_mechanical.rb path/to/spec.yaml'
    exit 64
  end

  exit MechanicalValidator.new(ARGV.first).run
end
