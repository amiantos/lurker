<!--
  Copyright (c) 2026 Brad Root
  SPDX-License-Identifier: MPL-2.0
-->

<template>
  <section id="about" class="settings-pane">
    <h2>about</h2>
    <p class="section-desc">
      Lurker is a self-hosted IRC bouncer and web client — your networks stay connected on the
      server, and every device picks up where you left off.
    </p>
    <p class="muted small">version {{ appVersion }}</p>
    <ul class="about-links">
      <li>
        <span class="about-label">source</span>
        <a href="https://github.com/amiantos/lurker" target="_blank" rel="noopener noreferrer"
          >github.com/amiantos/lurker</a
        >
      </li>
      <li>
        <span class="about-label">discuss</span>
        <a
          href="https://discuss.bradroot.me/tags/c/projects/13/lurker/39"
          target="_blank"
          rel="noopener noreferrer"
          >discuss.bradroot.me</a
        >
      </li>
      <li>
        <span class="about-label">chat</span>
        <a href="ircs://irc.libera.chat/lurker" target="_blank" rel="noopener noreferrer"
          >#lurker on Libera.Chat</a
        >
      </li>
    </ul>
    <p class="about-warning">
      Lurker is free and source-available — anyone can host it themselves at no cost. If you're
      paying for it, be sure you know why.
    </p>
  </section>
</template>

<script setup lang="ts">
// Build-time constant injected by vite.config.js (define).
const appVersion = APP_VERSION;
</script>

<style src="./panes.css"></style>
<style scoped>
.about-warning {
  margin: var(--space-8) 0 0;
  padding: var(--space-4) var(--space-5);
  border: 1px solid var(--warn, var(--accent));
  color: var(--warn, var(--accent));
  background: transparent;
}
.about-links {
  list-style: none;
  margin: var(--space-4) 0 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}
.about-links li {
  display: flex;
  align-items: baseline;
  gap: var(--space-5);
}
.about-links .about-label {
  color: var(--fg-muted);
  text-transform: uppercase;
  letter-spacing: 0.04em;
  min-width: 60px;
}
.about-links a {
  color: var(--accent);
}
.about-links a:hover {
  color: var(--fg);
}
</style>
