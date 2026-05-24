# Settings Appearance Subsection Navigation

## Summary

Add a nested subsection navigation under the existing `Appearance` item in the Settings sidebar. This first PR should make the long Appearance pane easier to scan without redesigning the broader settings system.

When `Appearance` is selected, the sidebar should show quiet, indented links for each Appearance subsection, such as Fonts, Colors, Message rows, and Layout. Clicking a subsection link should update the URL hash and smoothly scroll the settings content to that subsection. As the user scrolls through Appearance manually, the matching subsection link should become active.

## Goals

- Add desktop/tablet subsection navigation for `Appearance`.
- Source subsection labels and order from the existing settings registry instead of hardcoding labels in the sidebar.
- Support direct links like `/settings/appearance#fonts`.
- Keep the existing search-result behavior working for individual setting rows like `/settings/appearance#look.font.size`.
- Keep mobile behavior unchanged for this PR.

## Non-Goals

- Do not add nested navigation for every settings category yet.
- Do not redesign the Settings page layout.
- Do not change how settings are stored, validated, fetched, or saved.
- Do not change the mobile category picker.
- Do not add new registry data unless the existing `category`, `group`, and `GROUPS` data is not enough.

## Current Architecture

The Settings page already has most of the data needed for this feature.

- `vue_client/src/views/Settings.vue` owns the settings shell, active category route, scroll container, and current hash scrolling.
- `vue_client/src/components/SettingsSidebar.vue` renders the left sidebar categories and search results.
- `vue_client/src/components/settings-panes/RegistryPane.vue` renders registry-driven settings categories and their group headings.
- `shared/settingsRegistry.ts` is the source of truth for setting categories, setting groups, and group display labels.
- `vue_client/src/utils/settingsRegistry.ts` re-exports the shared registry for client code.

Appearance is a registry-driven category. Its subsections already come from the `group` field on each setting option:

- `fonts` -> Fonts
- `palette` -> Colors
- `messages` -> Message rows
- `members` -> Member prefixes
- `buffer-list` -> Buffer list
- `nicks` -> Nick coloring
- `misc` -> Misc
- `layout` -> Layout

## Desired UX

### Desktop and Tablet

In browse mode, the sidebar should continue to show the existing top-level categories. When `Appearance` is the active category, render a nested list directly below the Appearance link.

Visual direction:

- Smaller or quieter text than top-level category links.
- Indented under Appearance.
- Subtle active state using the existing settings visual language.
- No connector/tree-line treatment for this first pass.

Example structure:

```text
Appearance
  Fonts
  Colors
  Message rows
  Member prefixes
  Buffer list
  Nick coloring
  Misc
  Layout
Chat
Input bar
Uploads
...
```

### Mobile

Mobile should remain unchanged. The current mobile category picker should still show only top-level settings categories. Appearance subsection navigation can be revisited later after the desktop pattern is proven.

### Search Mode

Search mode should remain unchanged. When the user types in the settings search field, the sidebar should keep showing flat search results. Nested Appearance subsection links should only appear in normal browse mode.

## Routing and Hash Behavior

The URL hash should support two target types:

1. Individual settings rows, using the existing `data-setting-key` behavior.
2. Appearance subsection headings, using a new stable group target.

Examples:

- `/settings/appearance#look.font.size` scrolls to the Font size setting row.
- `/settings/appearance#fonts` scrolls to the Fonts subsection heading.
- `/settings/appearance#palette` scrolls to the Colors subsection heading.

This does not add a new route or change how settings are loaded. The route remains `/settings/:category`; the hash is just an in-page pointer after the `#`.

Today, the hash is already used by settings search results. For example, clicking a search result can route to `/settings/appearance#look.font.size`, and `Settings.vue` looks for a row with `data-setting-key="look.font.size"`. This feature keeps that behavior and adds one more thing the same hash watcher can find: a group heading with `data-setting-group="fonts"`.

The reason to update the hash for subsection clicks is that it makes the navigation state visible and durable. A user can copy the URL, reload the page, or use browser back/forward and land on the same subsection. The main compatibility risk is accidentally changing the existing setting-row hash behavior, so the implementation should try `data-setting-key` first and only fall back to `data-setting-group` if no row target exists.

## Implementation Plan

### 1. Derive Appearance Subsections

Add a small client-side helper or computed value that derives Appearance subsections from the registry:

- Filter `REGISTRY` to settings where `category === 'appearance'`.
- Preserve first-seen group order.
- De-duplicate groups.
- Resolve display labels from `GROUPS[groupId]`, falling back to the raw group id.

Recommended shape:

```ts
interface SettingsSubsection {
  id: string;
  label: string;
}
```

Keep this local to the settings view/sidebar unless another nearby file already has a natural utility home. Since this PR is scoped to Appearance only, avoid creating a broad nested-navigation abstraction too early.

### 2. Add Stable Group Targets in `RegistryPane.vue`

Update the rendered subsection heading so it can be targeted by hash scrolling and scrollspy logic.

In the current markup, groups are not wrapped in a parent element. `RegistryPane.vue` renders this repeating pattern:

```vue
<h3 class="subhead">{{ grp.title }}</h3>
<ul class="rows">...</ul>
```

That means the smallest useful change is to make the `h3.subhead` itself the target for each subsection. We do not need to wrap each group in a new parent `div` just to support navigation.

Recommended attributes:

```vue
<h3 v-if="groups.length > 1" class="subhead" :id="grp.id" :data-setting-group="grp.id">
  {{ grp.title }}
</h3>
```

The `data-setting-group` attribute is the important part because it avoids confusing group targets with setting row targets. The `id` helps native anchor behavior and makes the markup easier to inspect. If a future implementation finds that native `id` behavior fights with the custom scroll container, keeping only `data-setting-group` is acceptable; the scroll code should use the data attribute as the source of truth.

### 3. Extend Hash Scrolling in `Settings.vue`

The existing hash watcher looks for `[data-setting-key="<hash>"]`. Extend it to also look for `[data-setting-group="<hash>"]`.

Suggested target priority:

1. Try `data-setting-key` first, preserving existing search-result behavior.
2. Fall back to `data-setting-group`.

For setting rows, keep the current centered scroll and flash behavior. For group headings, scroll the heading near the top of the content area. A heading target should not need the row flash treatment.

### 4. Track Active Appearance Subsection

Add scrollspy behavior in `Settings.vue` while `appearance` is active:

- Listen to scroll events on the existing `.content` element.
- Query visible group headings using `[data-setting-group]`.
- Determine the active group based on the heading closest to the top of the scroll container, with a small offset so the active state changes at a natural point.
- Pass the active group id to `SettingsSidebar.vue`.

Keep this logic scoped and easy to read. A simple scroll handler is acceptable because the number of Appearance groups is small. If the codebase already prefers observers for similar UI, `IntersectionObserver` is also acceptable, but it should be configured against the settings content scroll container rather than the window.

Important behavior:

- If the user lands directly on `/settings/appearance#layout`, the active nested link should become Layout after the page scrolls.
- If the user switches away from Appearance, clear or ignore the active subsection.
- If the hash points at an individual setting row, the scroll position should still cause the nearest subsection to become active.

### 5. Render Nested Links in `SettingsSidebar.vue`

Update the sidebar API so it can receive:

- The Appearance subsection list.
- The currently active Appearance subsection id.

Render nested links only when:

- The sidebar is in browse mode.
- The current top-level category being rendered is `appearance`.
- `Appearance` is the active category.
- There is more than one subsection.

Each nested link should route to the existing settings route with the Appearance category and group hash:

```vue
<RouterLink
  :to="{ name: 'settings', params: { category: 'appearance' }, hash: `#${subsection.id}` }"
>
  {{ subsection.label }}
</RouterLink>
```

The active nested link should be based on the scrollspy state, not only the current route hash. This makes the UI respond when the user scrolls manually.

### 6. Style Nested Links

Add styles in `SettingsSidebar.vue` near the existing `.sidebar-link` styles.

Use all three class names together, each with a different job:

- `.sidebar-subnav`
- `.sidebar-sublink`
- `.sidebar-sublink.active`

Recommended usage:

```vue
<div class="sidebar-subnav" aria-label="appearance subsections">
  <RouterLink
    v-for="subsection in appearanceSubsections"
    :key="subsection.id"
    class="sidebar-sublink"
    :class="{ active: subsection.id === activeAppearanceSubsectionId }"
    :to="{ name: 'settings', params: { category: 'appearance' }, hash: `#${subsection.id}` }"
  >
    {{ subsection.label }}
  </RouterLink>
</div>
```

In that structure, `.sidebar-subnav` styles the nested container, `.sidebar-sublink` styles every nested link, and `.sidebar-sublink.active` styles the currently active subsection.

Style direction:

- Indent under the active Appearance link.
- Use `var(--fg-muted)` for default text, but make nested links visually distinct from the parent with smaller type, extra left padding, and no top-level accent border.
- Use `var(--fg)` and `var(--bg-soft)` for hover/active states so the active subsection is clear without competing with the parent Appearance item.
- Keep the top-level active Appearance border as-is.
- Hide nested links on mobile with the existing `@media (max-width: 720px)` block.

Suggested starting CSS:

```css
.sidebar-subnav {
  display: flex;
  flex-direction: column;
  gap: 1px;
  margin: 1px 0 4px;
}

.sidebar-sublink {
  color: var(--fg-muted);
  text-decoration: none;
  padding: 3px 16px 3px 32px;
  font-size: 0.9em;
  line-height: 1.35;
  text-transform: lowercase;
  letter-spacing: 0.03em;
}

.sidebar-sublink:hover,
.sidebar-sublink.active {
  color: var(--fg);
  background: var(--bg-soft);
}
```

This keeps the parent `Appearance` row as the strongest navigation item through its existing accent border, while the nested links still have enough indentation, scale difference, and active background to read as clickable subsection targets.

## Acceptance Criteria

- When `Appearance` is selected on desktop/tablet, nested subsection links appear under it.
- Nested links do not appear under other categories.
- Nested links do not appear on mobile.
- Clicking a nested link updates the URL hash and scrolls to the matching Appearance subsection.
- Opening `/settings/appearance#fonts` directly scrolls to Fonts.
- Opening `/settings/appearance#palette` directly scrolls to Colors.
- Existing search result links to individual setting rows still scroll to and flash the row.
- The active nested link updates as the user scrolls through the Appearance pane.
- Switching to another top-level settings category scrolls that pane to the top when there is no hash, as it does today.

## Manual QA Checklist

1. Open `/settings/appearance` on desktop width.
2. Confirm the nested Appearance links are visible and visually quieter than top-level categories.
3. Click each nested link and confirm the content scrolls to the expected subsection.
4. Confirm the URL hash changes for each nested link.
5. Scroll manually through Appearance and confirm the active nested link updates.
6. Search for a setting like `font size`; click the search result and confirm the existing row scroll and flash still work.
7. Switch from Appearance to Chat, then back to Appearance, and confirm the scroll behavior still feels predictable.
8. Resize to mobile width and confirm only the existing mobile category picker appears.

## Implementation Notes For A First PR

This is a good first PR because it touches the Settings UI without changing backend behavior or setting persistence. The most important concept is that this codebase uses the registry as data for the UI. In other words, the subsection navigation should come from the same `group` data that already renders the headings, rather than a separate hand-written list.

Keep the implementation small and readable. If a future PR wants nested navigation for every registry category, the Appearance-only helper can be generalized after the pattern has been reviewed.
