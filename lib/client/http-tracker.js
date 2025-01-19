import arrayRemove from 'unordered-array-remove'
import bencode from 'bencode'
import Debug from 'debug'
import fetch from 'cross-fetch-ponyfill'
import { bin2hex, hex2bin, arr2text, text2arr, arr2hex } from 'uint8-util'

import common from '../common.js'
import Tracker from './tracker.js'
import compact2string from 'compact2string'

const debug = Debug('bittorrent-tracker:http-tracker')
const HTTP_SCRAPE_SUPPORT = /\/(announce)[^/]*$/

function abortTimeout (ms) {
  const controller = new AbortController()
  setTimeout(() => {
    controller.abort()
  }, ms).unref?.()
  return controller
}

/**
 * HTTP torrent tracker client (for an individual tracker)
 *
 * @param {Client} client       parent bittorrent tracker client
 * @param {string} announceUrl  announce url of tracker
 * @param {Object} opts         options object
 */
class HTTPTracker extends Tracker {
  constructor (client, announceUrl) {
    super(client, announceUrl)

    debug('new http tracker %s', announceUrl)

    // Determine scrape url (if http tracker supports it)
    this.scrapeUrl = null

    const match = this.announceUrl.match(HTTP_SCRAPE_SUPPORT)
    if (match) {
      const pre = this.announceUrl.slice(0, match.index)
      const post = this.announceUrl.slice(match.index + 9)
      this.scrapeUrl = `${pre}/scrape${post}`
    }

    this.cleanupFns = []
    this.maybeDestroyCleanup = null
  }

  announce (opts) {
    if (this.destroyed) return

    const params = Object.assign({}, opts, {
      compact: (opts.compact == null) ? 1 : opts.compact,
      info_hash: this.client._infoHashBinary,
      peer_id: this.client._peerIdBinary,
      port: this.client._port
    })

    if (params.left !== 0 && !params.left) params.left = 16384
    if (this._trackerId) params.trackerid = this._trackerId

    this._request(this.announceUrl, params, (err, data) => {
      if (err) return this.client.emit('warning', err)
      this._onAnnounceResponse(data)
    })
  }

  scrape (opts) {
    if (this.destroyed) return

    if (!this.scrapeUrl) {
      this.client.emit('error', new Error(`scrape not supported ${this.announceUrl}`))
      return
    }

    const infoHashes = (Array.isArray(opts.infoHash) && opts.infoHash.length > 0)
      ? opts.infoHash.map(infoHash => hex2bin(infoHash))
      : (opts.infoHash && hex2bin(opts.infoHash)) || this.client._infoHashBinary
    const params = {
      info_hash: infoHashes
    }
    this._request(this.scrapeUrl, params, (err, data) => {
      if (err) return this.client.emit('warning', err)
      this._onScrapeResponse(data)
    })
  }

  destroy (cb) {
    const self = this
    if (this.destroyed) return cb(null)
    this.destroyed = true
    clearInterval(this.interval)

    let timeout

    // If there are no pending requests, destroy immediately.
    if (this.cleanupFns.length === 0) return destroyCleanup()

    // Otherwise, wait a short time for pending requests to complete, then force
    // destroy them.
    timeout = setTimeout(destroyCleanup, common.DESTROY_TIMEOUT)

    // But, if all pending requests complete before the timeout fires, do cleanup
    // right away.
    this.maybeDestroyCleanup = () => {
      if (this.cleanupFns.length === 0) destroyCleanup()
    }

    function destroyCleanup () {
      if (timeout) {
        clearTimeout(timeout)
        timeout = null
      }
      self.maybeDestroyCleanup = null
      self.cleanupFns.slice(0).forEach(cleanup => {
        cleanup()
      })
      self.cleanupFns = []
      cb(null)
    }
  }

  async _request (requestUrl, params, cb) {
    const parsedUrl = new URL(requestUrl + (requestUrl.indexOf('?') === -1 ? '?' : '&') + common.querystringStringify(params))
    let agent
    if (this.client._proxyOpts) {
      agent = parsedUrl.protocol === 'https:' ? this.client._proxyOpts.httpsAgent : this.client._proxyOpts.httpAgent
      if (!agent && this.client._proxyOpts.socksProxy) {
        agent = this.client._proxyOpts.socksProxy
      }
    }

    const cleanup = () => {
      if (!controller.signal.aborted) {
        arrayRemove(this.cleanupFns, this.cleanupFns.indexOf(cleanup))
        controller.abort()
        controller = null
      }
      if (this.maybeDestroyCleanup) this.maybeDestroyCleanup()
    }

    this.cleanupFns.push(cleanup)

    let res
    let controller = abortTimeout(common.REQUEST_TIMEOUT)
    try {
      res = await fetch(parsedUrl.toString(), {
        agent,
        signal: controller.signal,
        dispatcher: agent,
        headers: {
          'user-agent': this.client._userAgent || ''
        }
      })
      if (res.body.on) res.body.on('error', cb)
    } catch (err) {
      if (err) return cb(err)
    }
    let data = new Uint8Array(await res.arrayBuffer())
    cleanup()
    if (this.destroyed) return

    if (res.status !== 200) {
      return cb(new Error(`Non-200 response code ${res.status} from ${this.announceUrl}`))
    }
    if (!data || data.length === 0) {
      return cb(new Error(`Invalid tracker response from${this.announceUrl}`))
    }

    try {
      data = bencode.decode(data)
    } catch (err) {
      return cb(new Error(`Error decoding tracker response: ${err.message}`))
    }
    const failure = data['failure reason'] && arr2text(data['failure reason'])
    if (failure) {
      debug(`failure from ${requestUrl} (${failure})`)
      return cb(new Error(failure))
    }

    const warning = data['warning message'] && arr2text(data['warning message'])
    if (warning) {
      debug(`warning from ${requestUrl} (${warning})`)
      this.client.emit('warning', new Error(warning))
    }

    debug(`response from ${requestUrl}`)

    cb(null, data)
  }

  _onAnnounceResponse (data) {
    const interval = data.interval || data['min interval']
    if (interval) this.setInterval(interval * 1000)

    const trackerId = data['tracker id']
    if (trackerId) {
      // If absent, do not discard previous trackerId value
      this._trackerId = trackerId
    }

    const response = Object.assign({}, data, {
      announce: this.announceUrl,
      infoHash: bin2hex(data.info_hash || String(data.info_hash))
    })
    this.client.emit('update', response)

    let addrs
    if (ArrayBuffer.isView(data.peers)) {
      // tracker returned compact response
      try {
        addrs = compact2string.multi(Buffer.from(data.peers))
      } catch (err) {
        return this.client.emit('warning', err)
      }
      addrs.forEach(addr => {
        this.client.emit('peer', addr)
      })
    } else if (Array.isArray(data.peers)) {
      // tracker returned normal response
      data.peers.forEach(peer => {
        this.client.emit('peer', `${peer.ip}:${peer.port}`)
      })
    }

    if (ArrayBuffer.isView(data.peers6)) {
      // tracker returned compact response
      try {
        addrs = compact2string.multi6(Buffer.from(data.peers6))
      } catch (err) {
        return this.client.emit('warning', err)
      }
      addrs.forEach(addr => {
        this.client.emit('peer', addr)
      })
    } else if (Array.isArray(data.peers6)) {
      // tracker returned normal response
      data.peers6.forEach(peer => {
        const ip = /^\[/.test(peer.ip) || !/:/.test(peer.ip)
          ? peer.ip /* ipv6 w/ brackets or domain name */
          : `[${peer.ip}]` /* ipv6 without brackets */
        this.client.emit('peer', `${ip}:${peer.port}`)
      })
    }
  }

  _onScrapeResponse (data) {
    // NOTE: the unofficial spec says to use the 'files' key, 'host' has been
    // seen in practice
    data = data.files || data.host || {}

    const keys = Object.keys(data)
    if (keys.length === 0) {
      this.client.emit('warning', new Error('invalid scrape response'))
      return
    }

    keys.forEach(_infoHash => {
      // TODO: optionally handle data.flags.min_request_interval
      // (separate from announce interval)
      const infoHash = _infoHash.length !== 20 ? arr2hex(text2arr(_infoHash)) : bin2hex(_infoHash)

      const response = Object.assign(data[_infoHash], {
        announce: this.announceUrl,
        infoHash
      })
      this.client.emit('scrape', response)
    })
  }
}

HTTPTracker.prototype.DEFAULT_ANNOUNCE_INTERVAL = 30 * 60 * 1000 // 30 minutes

export default HTTPTracker
