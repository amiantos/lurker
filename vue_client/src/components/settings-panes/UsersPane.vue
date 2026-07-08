<!--
  Copyright (c) 2026 Brad Root
  SPDX-License-Identifier: MPL-2.0

  Legacy Settings → Users pane, shown only when the dedicated admin panel is
  OFF (LURKER_NEW_ADMIN_PANEL unset). It stacks the two admin panes — members
  and invites — so admins keep the exact same in-Settings experience as before.
  When the flag is on, the "users" category is hidden here (categoryVisible) and
  these panes render in the /admin panel with their own tabs instead. Once the
  flag graduates, this shim and the category go away.
-->

<template>
  <AdminUsersPane />
  <AdminInvitesPane />
</template>

<script setup lang="ts">
// This shim renders two root panes (a fragment), so the `category-id` attr the
// Settings shell passes every pane has nowhere to auto-land — opt out of attr
// inheritance to avoid the extraneous-attribute warning. The child panes don't
// need it (Users/Invites aren't registry-driven).
import AdminUsersPane from '../admin-panes/UsersPane.vue';
import AdminInvitesPane from '../admin-panes/InvitesPane.vue';

defineOptions({ inheritAttrs: false });
</script>
