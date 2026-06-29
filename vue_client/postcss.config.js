// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Gate every `:hover` rule behind `@media (hover: hover)` at build time (#115).
//
// iOS Safari has no real hover, so for any element that carries `:hover` styles
// it *simulates* one: the first tap applies `:hover` and only the second tap
// fires the click, and that hover sticks until you tap elsewhere (so scrolling
// past a row leaves it highlighted). Wrapping hover styles in `@media (hover:
// hover)` means they simply don't exist on touch devices — every tap is a
// single tap and nothing sticks. Doing it here, at build time, gates all
// current AND future `:hover` rules across `assets/main.css` and every SFC
// `<style>` block without per-rule churn or relying on contributor discipline.
//
// The plugin splits mixed selector lists, so non-:hover selectors sharing a rule
// (`.active`, `:focus`, `:focus-visible`) stay ungated and keep working on
// touch. Rules already inside a hover media query are left untouched.
export default {
  plugins: {
    'postcss-hover-media-feature': {},
  },
};
