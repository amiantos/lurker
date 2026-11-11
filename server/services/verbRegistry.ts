// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { ownsNetwork } from '../db/networks.js';

// Single registry of transport-agnostic verbs the MCP server and (where it
// makes sense) the WS hub both call into. Each verb declares a name, a
// human-readable description, a scope ('read' or 'read-write'), a JSON
// Schema describing its inputs (published verbatim through MCP tools/list),
// and a handler.
//
// Registration happens at module import time inside each verb file under
// services/verbs/. The aggregator services/verbs/index.js imports all of them
// so a single side-effecting import wires up the full surface.

/** The context object passed to every verb handler. */
export interface VerbContext {
  userId: number;
  scope: string;
  transport: string;
  /** Aborted when the caller stopped waiting (an HTTP request that closed). A
   *  verb whose work can be abandoned stops it; the rest ignore it. */
  signal?: AbortSignal;
}

/** JSON Schema fragment used to describe verb inputs. */
export interface VerbInputSchema {
  type: string;
  properties?: Record<string, unknown>;
  additionalProperties?: boolean;
  required?: string[];
  [key: string]: unknown;
}

type VerbHandler = (ctx: VerbContext, input: Record<string, unknown>) => unknown;

interface VerbEntry {
  name: string;
  description: string;
  scope: string;
  input: VerbInputSchema;
  handler: VerbHandler;
}

export interface VerbRegistration {
  name: string;
  description?: string;
  scope: string;
  input?: VerbInputSchema;
  handler: VerbHandler;
}

const verbs = new Map<string, VerbEntry>();

const VALID_SCOPES = new Set(['read', 'read-write']);

export function registerVerb({ name, description, scope, input, handler }: VerbRegistration): void {
  if (typeof name !== 'string' || !name) throw new Error('verb name required');
  if (verbs.has(name)) throw new Error(`duplicate verb: ${name}`);
  if (!VALID_SCOPES.has(scope)) throw new Error(`invalid scope for ${name}: ${scope}`);
  if (typeof handler !== 'function') throw new Error(`handler required for ${name}`);
  verbs.set(name, {
    name,
    description: description || '',
    scope,
    input: input || { type: 'object', properties: {}, additionalProperties: false },
    handler,
  });
}

export function getVerb(name: string): VerbEntry | null {
  return verbs.get(name) || null;
}

// Lists verbs the caller can actually invoke. A read-only token sees only
// read verbs in tools/list — there's no point advertising a tool the agent
// will be 403'd on.
export function listVerbs(
  callerScope: string,
): Array<{ name: string; description: string; inputSchema: VerbInputSchema }> {
  const out: Array<{ name: string; description: string; inputSchema: VerbInputSchema }> = [];
  for (const verb of verbs.values()) {
    if (verb.scope === 'read-write' && callerScope !== 'read-write') continue;
    out.push({ name: verb.name, description: verb.description, inputSchema: verb.input });
  }
  return out;
}

interface CodeError extends Error {
  code: string;
}

function codeError(message: string, code: string): CodeError {
  const err = new Error(message) as CodeError;
  err.code = code;
  return err;
}

// Universal boundary: scope check + required-field check + network-ownership
// check. Verbs trust ctx to carry an authenticated userId and the granted
// scope. Anything with a numeric networkId in the input gets ownership-checked
// here rather than at each call site; verbs are still free to do additional
// structural validation in their handlers (e.g. rejecting empty-after-trim
// strings that the JSON Schema can't express).
export function callVerb(
  name: string,
  ctx: VerbContext,
  input: Record<string, unknown> | null | undefined,
): unknown {
  const verb = verbs.get(name);
  if (!verb) {
    throw codeError(`unknown verb: ${name}`, 'unknown_verb');
  }
  if (verb.scope === 'read-write' && ctx.scope !== 'read-write') {
    throw codeError(`scope insufficient: ${name} requires read-write`, 'forbidden');
  }
  // Required-field check from the verb's declared JSON Schema. Without this
  // the ownership check below could be bypassed simply by omitting networkId,
  // and the handler would coerce undefined to NaN and surface a confusing
  // downstream error instead of a clean invalid_input.
  const required = Array.isArray(verb.input?.required) ? verb.input.required : null;
  if (required) {
    const payload = input || {};
    for (const field of required) {
      if (payload[field] == null) {
        throw codeError(`missing required field: ${field}`, 'invalid_input');
      }
    }
  }
  if (input && input.networkId != null) {
    const networkId = Number(input.networkId);
    if (!Number.isInteger(networkId) || networkId <= 0 || !ownsNetwork(ctx.userId, networkId)) {
      throw codeError('unknown network', 'unknown_network');
    }
  }
  return verb.handler(ctx, input || {});
}

// Test-only: wipe the registry between cases. Real code should never call
// this; the registry is intended to be populated once at process start.
export function resetForTests(): void {
  verbs.clear();
}
