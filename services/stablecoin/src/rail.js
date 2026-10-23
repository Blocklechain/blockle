// Rail selector for USDB fiat on/off-ramps.
//
// The service is rail-agnostic: every rail module exports the same interface
// (configured, env, ping, createCounterparty, createCounterpartyFromPlaid,
// createPaymentOrder, getPaymentOrder). server.js imports THIS file as `mt`, so
// swapping rails is a single env var — no code change:
//
//     USDB_RAIL=modern_treasury   (default)
//     USDB_RAIL=arival
//
// Both modules read their own env at load; importing both is harmless.
import * as modern_treasury from './modern_treasury.js';
import * as arival from './arival.js';

const RAIL = (process.env.USDB_RAIL || 'modern_treasury').trim().toLowerCase();
const impl = RAIL === 'arival' ? arival : modern_treasury;

export const name = RAIL === 'arival' ? 'arival' : 'modern_treasury';
export const {
  configured, env, ping,
  createCounterparty, createCounterpartyFromPlaid,
  createPaymentOrder, getPaymentOrder,
} = impl;
