<!--
  Copyright (c) 2026 Brad Root
  SPDX-License-Identifier: MPL-2.0
-->

<template>
  <!-- First run (#300). Mounted above the shell rather than inside either one so
       the flow survives the Desktop<->Mobile swap, and so it doesn't need
       duplicating in both. useChatBootstrap decides when it opens. -->
  <OnboardingFlow v-if="onboarding.isOpen" />
  <MobileChat v-if="isMobile" />
  <DesktopChat v-else />
</template>

<script setup lang="ts">
import { reactive } from 'vue';
import { useViewport } from '../composables/useViewport.js';
import { useOnboarding } from '../composables/useOnboarding.js';
import DesktopChat from './DesktopChat.vue';
import MobileChat from './MobileChat.vue';
import OnboardingFlow from '../components/OnboardingFlow.vue';

const { isMobile } = useViewport();
// reactive() so the composable's refs unwrap in the template, matching how the
// shells consume useNetworkEditor.
const onboarding = reactive(useOnboarding());
</script>
