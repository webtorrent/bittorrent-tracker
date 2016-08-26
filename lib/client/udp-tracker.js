module.exports = UDPTracker

var BN = require('bn.js')
var Buffer = require('safe-buffer').Buffer
var clone = require('clone')
var compact2string = require('compact2string')
var debug = require('debug')('bittorrent-tracker:udp-tracker')
var dgram = require('dgram')
var inherits = require('inherits')
var randombytes = require('randombytes')
var Socks = require('socks')
var url = require('url')

var common = require('../common')
var Tracker = require('./tracker')

var TIMEOUT = 15000

inherits(UDPTracker, Tracker)

/**
 * UDP torrent tracker client (for an individual tracker)
 *
 * @param {Client} client       parent bittorrent tracker client
 * @param {string} announceUrl  announce url of tracker
 * @param {Object} opts         options object
 */
function UDPTracker (client, announceUrl, opts) {
  var self = this
  Tracker.call(self, client, announceUrl)
  debug('new udp tracker %s', announceUrl)

  self.cleanupFns = []
}

UDPTracker.prototype.DEFAULT_ANNOUNCE_INTERVAL = 30 * 60 * 1000 // 30 minutes

UDPTracker.prototype.announce = function (opts) {
  var self = this
  if (self.destroyed) return
  self._request(opts)
}

UDPTracker.prototype.scrape = function (opts) {
  var self = this
  if (self.destroyed) return
  opts._scrape = true
  self._request(opts) // udp scrape uses same announce url
}

UDPTracker.prototype.destroy = function (cb) {
  var self = this
  if (self.destroyed) return cb(null)
  self.destroyed = true
  clearInterval(self.interval)

  self.cleanupFns.slice(0).forEach(function (cleanup) {
    cleanup()
  })
  self.cleanupFns = []
  cb(null)
}

UDPTracker.prototype._request = function (opts) {
  var self = this
  if (!opts) opts = {}
  var parsedUrl = url.parse(self.announceUrl)
  if (!parsedUrl.port) {
    parsedUrl.port = 80
  }
  var timeout
  // Socket used to connect to the socks server to create a relay, null if socks is disabled
  var proxySocket
  // Socket used to connect to the tracker or to the socks relay if socks is enabled
  var socket
  // Contains the host/port of the socks relay
  var relay
  var transactionId = genTransactionId()

  var proxyOpts = self.client._proxyOpts && clone(self.client._proxyOpts.socksProxy)
  if (proxyOpts) {
    if (!proxyOpts.proxy) {
      proxyOpts.proxy = {}
    }
    // UDP requests uses the associate command
    proxyOpts.proxy.command = 'associate'
    if (!proxyOpts.target) {
      // This should contain client IP and port but can be set to 0 if we don't have this information
      proxyOpts.target = {
        host: '0.0.0.0',
        port: 0
      }
    }

    if (proxyOpts.proxy.type === 5) {
      Socks.createConnection(proxyOpts, onGotConnection)
    } else {
      debug('Ignoring Socks proxy for UDP request because type 5 is required')
      onGotConnection(null)
    }
  } else {
    onGotConnection(null)
  }

  var cleanup = function () {
    if (!socket) return
    self.cleanupFns.splice(self.cleanupFns.indexOf(cleanup), 1)
    if (timeout) {
      clearTimeout(timeout)
      timeout = null
    }
    socket.removeListener('error', onError)
    socket.removeListener('message', onSocketMessage)
    socket.on('error', noop) // ignore all future errors
    try { socket.close() } catch (err) {}
    socket = null
    if (proxySocket) {
      try { proxySocket.close() } catch (err) {}
      proxySocket = null
    }
  }
  self.cleanupFns.push(cleanup)

  function onGotConnection (err, s, info) {
    if (err) return onError(err)

    proxySocket = s
    socket = dgram.createSocket('udp4')
    relay = info

    // does not matter if `stopped` event arrives, so supress errors & cleanup after timeout
    var ms = opts.event === 'stopped' ? TIMEOUT / 10 : TIMEOUT
    timeout = setTimeout(function () {
      timeout = null
      if (opts.event === 'stopped') cleanup()
      else onError(new Error('tracker request timed out (' + opts.event + ')'))
    }, ms)
    if (timeout.unref) timeout.unref()

    send(Buffer.concat([
      common.CONNECTION_ID,
      common.toUInt32(common.ACTIONS.CONNECT),
      transactionId
    ]), relay)

    socket.on('error', onError)
    socket.on('message', onSocketMessage)
  }

  function onSocketMessage (msg) {
    if (self.destroyed) return
    if (proxySocket) msg = msg.slice(10)
    if (msg.length < 8 || msg.readUInt32BE(4) !== transactionId.readUInt32BE(0)) {
      return onError(new Error('tracker sent invalid transaction id'))
    }

    var action = msg.readUInt32BE(0)
    debug('UDP response %s, action %s', self.announceUrl, action)
    switch (action) {
      case 0: // handshake
        if (msg.length < 16) return onError(new Error('invalid udp handshake'))

        if (opts._scrape) scrape(msg.slice(8, 16))
        else announce(msg.slice(8, 16), opts)

        return

      case 1: // announce
        cleanup()
        if (msg.length < 20) return onError(new Error('invalid announce message'))

        var interval = msg.readUInt32BE(8)
        if (interval) self.setInterval(interval * 1000)

        self.client.emit('update', {
          announce: self.announceUrl,
          complete: msg.readUInt32BE(16),
          incomplete: msg.readUInt32BE(12)
        })

        var addrs
        try {
          addrs = compact2string.multi(msg.slice(20))
        } catch (err) {
          return self.client.emit('warning', err)
        }
        addrs.forEach(function (addr) {
          self.client.emit('peer', addr)
        })
        break

      case 2: // scrape
        cleanup()
        if (msg.length < 20 || (msg.length - 8) % 12 !== 0) {
          return onError(new Error('invalid scrape message'))
        }
        var infoHashes = (Array.isArray(opts.infoHash) && opts.infoHash.length > 0)
          ? opts.infoHash.map(function (infoHash) { return infoHash.toString('hex') })
          : [ (opts.infoHash && opts.infoHash.toString('hex')) || self.client.infoHash ]

        for (var i = 0, len = (msg.length - 8) / 12; i < len; i += 1) {
          self.client.emit('scrape', {
            announce: self.announceUrl,
            infoHash: infoHashes[i],
            complete: msg.readUInt32BE(8 + (i * 12)),
            downloaded: msg.readUInt32BE(12 + (i * 12)),
            incomplete: msg.readUInt32BE(16 + (i * 12))
          })
        }
        break

      case 3: // error
        cleanup()
        if (msg.length < 8) return onError(new Error('invalid error message'))
        self.client.emit('warning', new Error(msg.slice(8).toString()))
        break

      default:
        onError(new Error('tracker sent invalid action'))
        break
    }
  }

  function onError (err) {
    if (self.destroyed) return
    cleanup()
    if (err.message) err.message += ' (' + self.announceUrl + ')'
    // errors will often happen if a tracker is offline, so don't treat it as fatal
    self.client.emit('warning', err)
  }

  function send (message, proxyInfo) {
    if (proxyInfo) {
      var pack = Socks.createUDPFrame({ host: parsedUrl.hostname, port: parsedUrl.port }, message)
      socket.send(pack, 0, pack.length, proxyInfo.port, proxyInfo.host)
    } else {
      socket.send(message, 0, message.length, parsedUrl.port, parsedUrl.hostname)
    }
  }

  function announce (connectionId, opts) {
    transactionId = genTransactionId()

    send(Buffer.concat([
      connectionId,
      common.toUInt32(common.ACTIONS.ANNOUNCE),
      transactionId,
      self.client._infoHashBuffer,
      self.client._peerIdBuffer,
      toUInt64(opts.downloaded),
      opts.left != null ? toUInt64(opts.left) : Buffer.from('FFFFFFFFFFFFFFFF', 'hex'),
      toUInt64(opts.uploaded),
      common.toUInt32(common.EVENTS[opts.event] || 0),
      common.toUInt32(0), // ip address (optional)
      common.toUInt32(0), // key (optional)
      common.toUInt32(opts.numwant),
      toUInt16(self.client._port)
    ]), relay)
  }

  function scrape (connectionId) {
    transactionId = genTransactionId()

    var infoHash = (Array.isArray(opts.infoHash) && opts.infoHash.length > 0)
      ? Buffer.concat(opts.infoHash)
      : (opts.infoHash || self.client._infoHashBuffer)

    send(Buffer.concat([
      connectionId,
      common.toUInt32(common.ACTIONS.SCRAPE),
      transactionId,
      infoHash
    ]), relay)
  }
}

function genTransactionId () {
  return randombytes(4)
}

function toUInt16 (n) {
  var buf = Buffer.allocUnsafe(2)
  buf.writeUInt16BE(n, 0)
  return buf
}

var MAX_UINT = 4294967295

function toUInt64 (n) {
  if (n > MAX_UINT || typeof n === 'string') {
    var bytes = new BN(n).toArray()
    while (bytes.length < 8) {
      bytes.unshift(0)
    }
    return Buffer.from(bytes)
  }
  return Buffer.concat([common.toUInt32(0), common.toUInt32(n)])
}

function noop () {}
