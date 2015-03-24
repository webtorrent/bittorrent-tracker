module.exports = UDPTracker

var BN = require('bn.js')
var compact2string = require('compact2string')
var debug = require('debug')('bittorrent-tracker:http-tracker')
var dgram = require('dgram')
var EventEmitter = require('events').EventEmitter
var hat = require('hat')
var inherits = require('inherits')
var url = require('url')

var common = require('./common')

inherits(UDPTracker, EventEmitter)

/**
 * UDP torrent tracker client (for an individual tracker)
 *
 * @param {Client} client       parent bittorrent tracker client
 * @param {string} announceUrl  announce url of tracker
 * @param {Object} opts         options object
 */
function UDPTracker (client, announceUrl, opts) {
  var self = this
  EventEmitter.call(self)
  debug('new udp tracker %s', announceUrl)

  self.client = client

  self._opts = opts
  self._announceUrl = announceUrl
  self._intervalMs = self.client._intervalMs // use client interval initially
  self._interval = null
}

UDPTracker.prototype.announce = function (opts) {
  var self = this
  self._request(self._announceUrl, opts)
}

UDPTracker.prototype.scrape = function (opts) {
  var self = this
  opts._scrape = true
  self._request(self._announceUrl, opts) // udp scrape uses same announce url
}

UDPTracker.prototype._request = function (requestUrl, opts) {
  var self = this
  if (!opts) opts = {}
  var parsedUrl = url.parse(requestUrl)
  var socket = dgram.createSocket('udp4')
  var transactionId = genTransactionId()

  // does not matter if `stopped` event arrives, so supress errors & cleanup after timeout
  var timeout = setTimeout(function () {
    timeout = null
    cleanup()
    if (opts.event !== 'stopped') {
      error('tracker request timed out')
    }
  }, opts.event === 'stopped' ? 1500 : 15000)

  if (timeout && timeout.unref) {
    timeout.unref()
  }

  send(Buffer.concat([
    common.CONNECTION_ID,
    common.toUInt32(common.ACTIONS.CONNECT),
    transactionId
  ]))

  socket.on('error', error)

  socket.on('message', function (msg) {
    if (msg.length < 8 || msg.readUInt32BE(4) !== transactionId.readUInt32BE(0)) {
      return error('tracker sent invalid transaction id')
    }

    var action = msg.readUInt32BE(0)
    debug(requestUrl + ' UDP response, action ' + action)
    switch (action) {
      case 0: // handshake
        if (msg.length < 16) {
          return error('invalid udp handshake')
        }

        if (opts._scrape) {
          scrape(msg.slice(8, 16))
        } else {
          announce(msg.slice(8, 16), opts)
        }

        return

      case 1: // announce
        cleanup()
        if (msg.length < 20) {
          return error('invalid announce message')
        }

        var interval = msg.readUInt32BE(8)
        if (interval && !self._opts.interval && self._intervalMs !== 0) {
          // use the interval the tracker recommends, UNLESS the user manually specifies an
          // interval they want to use
          self.setInterval(interval * 1000)
        }

        self.client.emit('update', {
          announce: self._announceUrl,
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
        if (msg.length < 20) {
          return error('invalid scrape message')
        }
        self.client.emit('scrape', {
          announce: self._announceUrl,
          complete: msg.readUInt32BE(8),
          downloaded: msg.readUInt32BE(12),
          incomplete: msg.readUInt32BE(16)
        })
        break

      case 3: // error
        cleanup()
        if (msg.length < 8) {
          return error('invalid error message')
        }
        self.client.emit('warning', new Error(msg.slice(8).toString()))
        break

      default:
        error('tracker sent invalid action')
        break
    }
  })

  function send (message) {
    if (!parsedUrl.port) {
      parsedUrl.port = 80
    }
    socket.send(message, 0, message.length, parsedUrl.port, parsedUrl.hostname)
  }

  function error (message) {
    // errors will often happen if a tracker is offline, so don't treat it as fatal
    self.client.emit('warning', new Error(message + ' (' + requestUrl + ')'))
    cleanup()
  }

  function cleanup () {
    if (timeout) {
      clearTimeout(timeout)
      timeout = null
    }
    try { socket.close() } catch (err) {}
  }

  function announce (connectionId, opts) {
    opts = opts || {}
    transactionId = genTransactionId()

    send(Buffer.concat([
      connectionId,
      common.toUInt32(common.ACTIONS.ANNOUNCE),
      transactionId,
      self.client._infoHash,
      self.client._peerId,
      toUInt64(opts.downloaded || 0),
      opts.left != null ? toUInt64(opts.left) : new Buffer('FFFFFFFFFFFFFFFF', 'hex'),
      toUInt64(opts.uploaded || 0),
      common.toUInt32(common.EVENTS[opts.event] || 0),
      common.toUInt32(0), // ip address (optional)
      common.toUInt32(0), // key (optional)
      common.toUInt32(opts.numWant || common.DEFAULT_ANNOUNCE_PEERS),
      toUInt16(self.client._port || 0)
    ]))
  }

  function scrape (connectionId) {
    transactionId = genTransactionId()

    send(Buffer.concat([
      connectionId,
      common.toUInt32(common.ACTIONS.SCRAPE),
      transactionId,
      self.client._infoHash
    ]))
  }
}

// TODO: Improve this interface
UDPTracker.prototype.setInterval = function (intervalMs) {
  var self = this
  clearInterval(self._interval)

  self._intervalMs = intervalMs
  if (intervalMs) {
    // HACK
    var update = self.announce.bind(self, self.client._defaultAnnounceOpts())
    self._interval = setInterval(update, self._intervalMs)
  }
}

function genTransactionId () {
  return new Buffer(hat(32), 'hex')
}

function toUInt16 (n) {
  var buf = new Buffer(2)
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
    return new Buffer(bytes)
  }
  return Buffer.concat([common.toUInt32(0), common.toUInt32(n)])
}
