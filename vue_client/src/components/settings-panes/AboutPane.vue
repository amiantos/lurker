<!--
  Copyright (c) 2026 Brad Root
  SPDX-License-Identifier: Elastic-2.0
-->

<template>
  <section id="about" class="settings-pane">
    <h2>about</h2>
    <p class="section-desc">
      Lurker is a self-hosted IRC bouncer and web client — your networks stay
      connected on the server, and every device picks up where you left off.
    </p>
    <p class="muted small">version {{ appVersion }}</p>
    <ul class="about-links">
      <li>
        <span class="about-label">source</span>
        <a href="https://github.com/amiantos/lurker" target="_blank" rel="noopener noreferrer">github.com/amiantos/lurker</a>
      </li>
      <li>
        <span class="about-label">discuss</span>
        <a href="https://discuss.bradroot.me/tags/c/projects/13/lurker/39" target="_blank" rel="noopener noreferrer">discuss.bradroot.me</a>
      </li>
      <li>
        <span class="about-label">chat</span>
        <a href="ircs://irc.libera.chat/lurker" target="_blank" rel="noopener noreferrer">#lurker on Libera.Chat</a>
      </li>
    </ul>
    <p class="about-warning">
      Lurker is free and source-available — anyone can host it themselves at
      no cost. If you're paying for it, be sure you know why.
    </p>
  </section>
</template>

<script setup>
// Build-time constant injected by vite.config.js (define).
const appVersion = __APP_VERSION__;
</script>

<style src="./panes.css"></style>
<style scoped>
.about-warning {
  margin: 20px 0 0;
  padding: 8px 10px;
  border: 1px solid var(--warn, var(--accent));
  color: var(--warn, var(--accent));
  background: transparent;
}
.about-links {
  list-style: none;
  margin: 8px 0 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.about-links li {
  display: flex;
  align-items: baseline;
  gap: 10px;
}
.about-links .about-label {
  color: var(--fg-muted);
  text-transform: uppercase;
  font-size: 0.8em;
  letter-spacing: 0.04em;
  min-width: 60px;
}
.about-links a { color: var(--accent); }
.about-links a:hover { color: var(--fg); }
</style>
