/**
 * Functions/constants needed by both the client and server (but only in node).
 * These are separate from common.js so they can be skipped when bundling for the browser.
 */

import querystring from 'querystring'
import { concat } from 'uint8-util'

export const IPV4_RE = /^[\d.]+$/
export const IPV6_RE = /^[\da-fA-F:]+$/
export const REMOVE_IPV4_MAPPED_IPV6_RE = /^::ffff:/

export const CONNECTION_ID = concat([toUInt32(0x417), toUInt32(0x27101980)])
export const ACTIONS = { CONNECT: 0, ANNOUNCE: 1, SCRAPE: 2, ERROR: 3 }
export const EVENTS = { update: 0, completed: 1, started: 2, stopped: 3, paused: 4 }
export const EVENT_IDS = {
  0: 'update',
  1: 'completed',
  2: 'started',
  3: 'stopped',
  4: 'paused'
}
export const EVENT_NAMES = {
  update: 'update',
  completed: 'complete',
  started: 'start',
  stopped: 'stop',
  paused: 'pause'
}

/**
 * Client request timeout. How long to wait before considering a request to a
 * tracker server to have timed out.
 */
export const REQUEST_TIMEOUT = 15000

/**
 * Client destroy timeout. How long to wait before forcibly cleaning up all
 * pending requests, open sockets, etc.
 */
export const DESTROY_TIMEOUT = 1000

export function toUInt32 (n) {
  const buf = new Uint8Array(4)
  const view = new DataView(buf.buffer)
  view.setUint32(0, n)
  return buf
}

/**
 * `querystring.parse` using `unescape` instead of decodeURIComponent, since bittorrent
 * clients send non-UTF8 querystrings
 * @param  {string} q
 * @return {Object}
 */
export const querystringParse = q => querystring.parse(q, null, null, { decodeURIComponent: unescape })

/**
 * `querystring.stringify` using `escape` instead of encodeURIComponent, since bittorrent
 * clients send non-UTF8 querystrings
 * @param  {Object} obj
 * @return {string}
 */
export const querystringStringify = obj => {
  let ret = querystring.stringify(obj, null, null, { encodeURIComponent: escape })
  ret = ret.replace(/[@*/+]/g, char => // `escape` doesn't encode the characters @*/+ so we do it manually
  `%${char.charCodeAt(0).toString(16).toUpperCase()}`)
  return ret
}
