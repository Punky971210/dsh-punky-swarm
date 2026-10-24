---
name: ui-component-registry
description: "MUST USE when writing SpecLang ui_layout/ui_logic sections or implementing any UI code. Consult before writing UI rendering code to ensure correct kind usage and framework API mapping."
---

# UI Component Registry Skill (v2.1)

## Purpose

Defines the authoritative catalog of UI element kinds and their bound operations, with cross-framework implementation mappings. This skill serves as the **single source of truth** for:

- Which `kind` values are legal in `ui_layout` trees
- Which operations each kind supports
- Cross-framework implementation mappings (SwiftUI, UIKit, Flutter, Jetpack Compose, React Native, HTML/CSS, HarmonyOS ArkUI for ArkTS and Cangjie)
- Platform-specific constraints and best practices

## Architecture Overview

```
assets/
├── kinds-catalog.yaml          # Core: all UI kinds and their operations
├── constraints/                # Advanced constraints (loaded progressively)
│   ├── ios-pod-constraints.yaml    # Pod compilation scope constraints
│   ├── accessibility-rules.yaml    # A11y compliance requirements
│   └── performance-guidelines.yaml # Performance best practices
└── guides/                     # Target-runtime context and translation guides
    ├── pseudocode-to-uikit.yaml
    ├── pseudocode-to-swiftui.yaml
    ├── pseudocode-to-compose.yaml
    ├── pseudocode-to-flutter.yaml
    ├── pseudocode-to-react-native.yaml
    ├── pseudocode-to-arkui-arkts.yaml
    ├── pseudocode-to-arkui-cangjie.yaml
    └── pseudocode-to-web.yaml
```

**Loading Strategy:** Start with `kinds-catalog.yaml`. Load the matching guide in `assets/guides/` when implementing or translating UI for a target runtime. Load constraints only when relevant scenarios arise (e.g., Pod development, accessibility audit).

## When to Use

| Scenario | Asset to Load |
|----------|---------------|
| Defining or reviewing UI element kinds | `kinds-catalog.yaml` |
| Writing `ui_layout` sections | `kinds-catalog.yaml` |
| Writing `ui_logic_native_pseudocode` | `kinds-catalog.yaml` |
| Translating pseudocode operations into UI code | `kinds-catalog.yaml` + matching `guides/*.yaml` |
| Working under platform-specific packaging or runtime constraints | Relevant `constraints/*.yaml` |
| Accessibility review | `constraints/accessibility-rules.yaml` |
| Performance optimization | `constraints/performance-guidelines.yaml` |

## Core Rules

### R1: Kind Must Be Registered
Every `kind` value in `ui_layout` must exist in `assets/kinds-catalog.yaml`. Unregistered kinds are illegal.

### R2: Operations Must Be Bound to a Kind
Every operation used on a `ui_element_id` in `ui_logic_native_pseudocode` must be listed in that element's kind's `operations` list.

### R3: Root Node Kind Must Be a Full-Surface Container
`screens[].root.kind` must be one of: `Page`, `Screen`, `Modal`, `Drawer`, `Sheet`, `FullscreenOverlay`.

> **Note on `Sheet` as root:** A `Sheet` root is valid only when the entire screen surface is a bottom sheet (e.g. a half-modal action sheet). For inline sheet presentation within a page, use `Page` as root and present the sheet via `ui_logic_native_pseudocode`.

**Page vs. Screen disambiguation:** Use `Page` for a standalone navigable screen (the default choice). Use `Screen` only when the surface is one of several peer screens within a multi-screen container (e.g. a TabBar tab, a ViewPager page). If unsure, default to `Page`.

### R4: Layout Kinds Primarily Organize Child Structure
Layout container kinds (`VerticalStack`, `HorizontalStack`, `HorizontalPair`, `Grid`, `Overlay`, `Frame`, `ScrollContainer`) exist primarily to organize child node structure. They should not carry a `ui_element_id` **unless** at least one of their operations is referenced in `ui_logic_native_pseudocode` (e.g. `ScrollContainer(id=UI-SCROLL).scrollToTop`, `Overlay(id=UI-BADGE).show()`). In that case, a `ui_element_id` is required and the element must follow R2 (only bound operations may be used).

### R5: Interactive Kinds Must Carry ui_element_id
Any node whose kind is an interactive component (`Button`, `TextField`, `Switch`, etc.) and that participates in any contract's `ui_logic_native_pseudocode` must carry a `ui_element_id`.

### R6: Target-Runtime Guides
When implementing UI code for a target runtime, load the corresponding guide in `assets/guides/`. Guides contain target-runtime context plus translation examples, but the legal kind and operation vocabulary still comes only from `assets/kinds-catalog.yaml`.

### R7: Advanced Constraints (Progressive Loading)
Additional constraint files are loaded when specific scenarios arise:
- **Pod Development (iOS)**: Load `assets/constraints/ios-pod-constraints.yaml`
- **Accessibility Requirements**: Load `assets/constraints/accessibility-rules.yaml`
- **Performance Optimization**: Load `assets/constraints/performance-guidelines.yaml`

## Catalog Structure

The authoritative catalog is `assets/kinds-catalog.yaml`, organized into categories:

| Category | Description | Examples |
|----------|-------------|----------|
| `full_surface_containers` | Top-level containers | Page, Screen, Modal, Drawer, Sheet |
| `layout_containers` | Structural containers | VerticalStack, HorizontalStack, Grid, Overlay |
| `semantic_state_containers` | Framework-neutral state and behavior wrappers | Form, AsyncContent, GestureRegion |
| `interactive_components` | User-interactive elements | Button, TextField, Switch, Slider |
| `static_elements` | Display-only elements | Text, Icon, Image, Divider, Badge |
| `navigation_elements` | Navigation components | TabBar, BottomNavigationBar, Breadcrumb |
| `feedback_elements` | Temporary overlays | Dialog, Snackbar, Toast, BottomSheet |

### Semantic State Containers

`semantic_state_containers` is a registry category, not a standard UI framework term. These kinds describe UI regions whose main purpose is to coordinate state, behavior, or interaction around child elements rather than render a specific visual control.

Use a semantic state container when the spec needs to name a reusable UI state machine or behavior boundary:
- `Form` coordinates field validation, dirty/touched state, submit lifecycle, and form-level errors.
- `AsyncContent` switches a content region between loading, content, empty, error, partial, refreshing, and stale states.
- `GestureRegion` binds gestures such as tap, long press, swipe, pan, pinch, or hover to arbitrary child content.
- `AnimatedVisibility` describes enter/exit/show/hide transitions without choosing a framework-specific animation API.

Do not use these kinds as replacements for concrete visual elements. A `Form` still contains fields and buttons; an `AsyncContent` still contains loading, content, empty, or error views; a `GestureRegion` still wraps visible child content. In implementation, these kinds usually compile to state variables, conditional rendering, event handlers, or wrapper views rather than to one universal native widget.

Each kind entry contains:
- `kind`: String value used in SpecLang
- `description`: Natural language description
- `operations`: Legal operations this kind supports
- `framework_mapping`: Corresponding implementation per framework
- `pod_scope` *(optional)*: Pod compilation scope annotation — `both` (safe in Pod and host), `host_only` (unavailable in Pod), or `pod_only` (Pod-internal). Only present for kinds with Pod-scope implications.

Additionally, the catalog may contain these special sections:
- `business_components`: Host-app-only UI components that are NOT available in Pod compilation. Documented to prevent Pod compilation errors.
- `host_app_apis`: Commonly-used host-app-only APIs that cause compilation errors when called from Pod code, along with Pod-safe alternatives.

## Operation Reference

Operations are verbs used in `ui_logic_native_pseudocode`. The table below shows the **conceptual patterns**; see [ui_logic_native_pseudocode Format](#ui_logic_native_pseudocode-format) for the exact syntax used in SpecLang documents.

| Pattern | Example | Meaning |
|---------|---------|---------|
| `Kind(id=UI-ID).operation → module.func()` | `Button(id=UI-BTN).tap → module.submit()` | User triggers event |
| `OnSuccess → Kind(id=UI-ID).show()` | `OnSuccess → Dialog(id=UI-DIALOG).show()` | Make element visible |
| `OnSuccess → Kind(id=UI-ID).hide()` | `OnSuccess → Text(id=UI-ERROR).hide()` | Make element invisible |
| `OnSuccess → Kind(id=UI-ID).setText("value")` | `OnSuccess → Text(id=UI-LABEL).setText("Hello")` | Set property value |
| `OnSuccess → Kind(id=UI-ID).transition(state)` | `OnSuccess → Card(id=UI-CARD).transition(hidden)` | Switch visual state |

## ui_logic_native_pseudocode Format

### Trigger Statement
```
Kind(id=UI-ID).operation → module.function(args)
```

**Examples:**
```
Button(id=UI-ACCEPT-BUTTON).tap → accept_widget_panel.submitAccept(taskId)
TextField(id=UI-SEARCH-INPUT).onSubmit → search_coordinator.search(query)
Switch(id=UI-NOTIFY-TOGGLE).toggle → settings_panel.setNotification(enabled)
```

### Reaction Statement
```
[Branch Marker] Kind(id=UI-ID).operation(value)
```

**Branch Markers:**
| Marker | Meaning |
|--------|---------|
| `OnSuccess` | Function returned successfully |
| `OnFailure(error.code == XXX)` | Specific error code match |
| `OnFailure(otherwise)` | Catch-all error handling |

**Example:**
```yaml
ui_logic_native_pseudocode:
  - "Button(id=UI-ACCEPT-BUTTON).tap → accept_widget_panel.submitAccept(taskId)"
  - "OnSuccess → Card(id=UI-TASK-CARD).hide()"
  - "OnFailure(error.code == LIMIT_REACHED) → Dialog(id=UI-LIMIT-DIALOG).show()"
  - "OnFailure(otherwise) → Text(id=UI-ERROR).show()"
```

## Implementation Guide

### Step 1: Load the Target Guide
Read the appropriate guide from `assets/guides/pseudocode-to-{target}.yaml`.

For HarmonyOS targets, use:
- `pseudocode-to-arkui-arkts.yaml` when the UI layer is authored in ArkTS.
- `pseudocode-to-arkui-cangjie.yaml` when the UI layer is authored in Cangjie or through a project-local Cangjie ArkUI binding.

### Step 2: Look Up Framework Mapping
For each kind in your `ui_layout`, find its `framework_mapping` entry in `kinds-catalog.yaml`.

### Step 3: Apply Translation Guide
Use only operation names registered for that kind in `kinds-catalog.yaml`; do not introduce guide-local aliases.

### Step 4: Check Constraints
If applicable (e.g., Pod development), load and apply constraint files.

## Adding a New Kind

1. Add entry to `assets/kinds-catalog.yaml` under correct category
2. List all legal operations
3. Add framework mappings for all supported platforms
4. If the kind has Pod-scope implications, add a `pod_scope` annotation
5. Update relevant translation guides if the kind should have implementation examples
6. Update constraints only if the kind has packaging, accessibility, or performance implications
7. Verify: ensure the new `kind` name does not conflict with existing kinds; run `validate_speclang_mechanical.rb` to confirm R1/R2 compliance

## Asset Reference

| Asset | Purpose | When to Load |
|-------|---------|--------------|
| `kinds-catalog.yaml` | Core kind definitions | Always |
| `constraints/*.yaml` | Advanced constraints | Specific scenarios |
| `guides/*.yaml` | Target-runtime context and translation guides | Pseudocode-to-code translation |
