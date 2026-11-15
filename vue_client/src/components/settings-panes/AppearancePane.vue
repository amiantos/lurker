<!--
  Copyright (c) 2026 Brad Root
  SPDX-License-Identifier: MPL-2.0

  Appearance: bespoke for the leading sections (Themes, Message layout,
  Avatars) — every other appearance option below them is still ordinary
  registry rows, rendered by the embedded RegistryPane (the UploadsPane
  pattern). The embedded pane keeps emitting the [data-setting-group] headings
  Settings.vue's scroll-spy and subsection sidebar depend on; each bespoke
  section contributes its own heading, mirrored by an extra subsection entry
  in Settings.vue.
-->

<template>
  <section id="appearance" class="settings-pane">
    <h2>Appearance</h2>
    <ThemesSection />
    <LayoutSection />
    <AvatarsSection />
    <RegistryPane category-id="appearance" embedded />
  </section>
</template>

<script setup lang="ts">
import RegistryPane from './RegistryPane.vue';
import ThemesSection from './ThemesSection.vue';
import LayoutSection from './LayoutSection.vue';
import AvatarsSection from './AvatarsSection.vue';
</script>

<style src="./panes.css"></style>
