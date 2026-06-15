// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Side-effect aggregator. Importing this module registers every verb with the
// shared registry. server.js imports it once at startup so both the WS
// delegators and the MCP server see the full surface.
import './listNetworks.js';
import './listBuffers.js';
import './recentMessages.js';
import './searchMessages.js';
import './getNickNote.js';
import './setNickNote.js';
import './setContact.js';
import './deleteContact.js';
import './sendMessage.js';
import './sendAction.js';
import './sendNotice.js';
