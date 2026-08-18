/**
 * HMAC-SHA256 request signing for the WeCom gateway, ported 1:1 from the Go
 * `wx-cli` client (`bin/internal/client/hmac.go`).
 *
 * Signature: Base64( HMAC-SHA256( sharedKey, account + ":" + timestamp + ":" + nonce ) )
 */

import { createHash, createHmac, randomBytes } from 'node:crypto'

/** Compute the gateway signature string for one request. */
export function hmacSignature(account: string, timestamp: string, nonce: string, sharedKey: string): string {
  const data = `${account}:${timestamp}:${nonce}`
  return createHmac('sha256', sharedKey).update(data, 'utf8').digest('base64')
}

/** Generate a random 16-byte hex nonce (parallel to Go `newNonce`). */
export function newNonce(): string {
  return randomBytes(16).toString('hex')
}

/** Headers the gateway verifies (X-Account/X-Timestamp/X-Nonce/X-Signature + account). */
export interface HmacHeaders {
  account: string
  'X-Account': string
  'X-Timestamp': string
  'X-Nonce': string
  'X-Signature': string
  'Content-Type': string
}

/** Build signing headers for a request. Throws when the timestamp is empty. */
export function buildHmacHeaders(account: string, sharedKey: string, nowUnix: string): HmacHeaders {
  if (!nowUnix) {
    throw new Error('timestamp 为空')
  }
  const nonce = newNonce()
  const sig = hmacSignature(account, nowUnix, nonce, sharedKey)
  return {
    account,
    'X-Account': account,
    'X-Timestamp': nowUnix,
    'X-Nonce': nonce,
    'X-Signature': sig,
    'Content-Type': 'application/json',
  }
}

/** Unix seconds as a string (used for X-Timestamp). */
export function nowUnixSeconds(): string {
  return String(Math.floor(Date.now() / 1000))
}
