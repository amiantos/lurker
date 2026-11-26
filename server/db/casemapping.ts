// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// The fold itself lives in shared/ so the web client folds by the same rule
// (#1425). Re-exported here for the server's callers, which reach it as part
// of the db layer: the mapping is a column on the network's row.
export * from '../../shared/casemapping.js';
