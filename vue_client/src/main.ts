// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { createApp } from 'vue';
import { createPinia } from 'pinia';
import App from './App.vue';
import router from './router.js';
import '@fortawesome/fontawesome-free/css/fontawesome.min.css';
import '@fortawesome/fontawesome-free/css/solid.min.css';
import '@fortawesome/fontawesome-free/css/regular.min.css';
import './assets/main.css';
import { installVisualViewport } from './composables/useVisualViewport.js';

installVisualViewport();

const app = createApp(App);
app.use(createPinia());
app.use(router);
app.mount('#app');
