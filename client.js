module.exports = Client

var bencode = require('bencode')
var BN = require('bn.js')
var common = require('./lib/common')
var compact2string = require('compact2string')
var debug = require('debug')('bittorrent-tracker')
var dgram = require('dgram')
var EventEmitter = require('events').EventEmitter
var get = require('simple-get')
var hat = require('hat')
var inherits = require('inherits')
var once = require('once')
var url = require('url')

inherits(Client, EventEmitter)

/**
 * A Client manages tracker connections for a torrent.
 *
 * @param {string} peerId  this peer's id
 * @param {Number} port    port number that the client is listening on
 * @param {Object} torrent parsed torrent
 * @param {Object} opts    optional options
 * @param {Number} opts.numWant    number of peers to request
 * @param {Number} opts.interval   interval in ms to send announce requests to the tracker
 */
function Client (peerId, port, torrent, opts) {
  var self = this
  if (!(self instanceof Client)) return new Client(peerId, port, torrent, opts)
  EventEmitter.call(self)
  self._opts = opts || {}

  // required
  self._peerId = Buffer.isBuffer(peerId)
    ? peerId
    : new Buffer(peerId, 'hex')
  self._port = port
  self._infoHash = Buffer.isBuffer(torrent.infoHash)
    ? torrent.infoHash
    : new Buffer(torrent.infoHash, 'hex')
  self.torrentLength = torrent.length

  // optional
  self._numWant = self._opts.numWant || 50
  self._intervalMs = self._opts.interval || (30 * 60 * 1000) // default: 30 minutes

  debug('new client %s', self._infoHash.toString('hex'))

  if (typeof torrent.announce === 'string') torrent.announce = [ torrent.announce ]
  self._trackers = (torrent.announce || [])
    .filter(function (announceUrl) {
      var protocol = url.parse(announceUrl).protocol
      return protocol === 'udp:' || protocol === 'http:' || protocol === 'https:'
    })
    .map(function (announceUrl) {
      return new Tracker(self, announceUrl, self._opts)
    })
}

/**
 * Simple convenience function to scrape a tracker for an infoHash without
 * needing to create a Client, pass it a parsed torrent, etc.
 * @param  {string}   announceUrl
 * @param  {string}   infoHash
 * @param  {function} cb
 */
Client.scrape = function (announceUrl, infoHash, cb) {
  cb = once(cb)
  var dummy = {
    peerId: new Buffer('01234567890123456789'),
    port: 6881,
    torrent: {
      infoHash: infoHash,
      announce: [ announceUrl ]
    }
  }
  var client = new Client(dummy.peerId, dummy.port, dummy.torrent)
  client.once('error', cb)
  client.once('scrape', function (data) {
    cb(null, data)
  })
  client.scrape()
}

Client.prototype.start = function (opts) {
  var self = this
  self._trackers.forEach(function (tracker) {
    tracker.start(opts)
  })
}

Client.prototype.stop = function (opts) {
  var self = this
  self._trackers.forEach(function (tracker) {
    tracker.stop(opts)
  })
}

Client.prototype.complete = function (opts) {
  var self = this
  self._trackers.forEach(function (tracker) {
    tracker.complete(opts)
  })
}

Client.prototype.update = function (opts) {
  var self = this
  self._trackers.forEach(function (tracker) {
    tracker.update(opts)
  })
}

Client.prototype.scrape = function (opts) {
  var self = this
  self._trackers.forEach(function (tracker) {
    tracker.scrape(opts)
  })
}

Client.prototype.setInterval = function (intervalMs) {
  var self = this
  self._intervalMs = intervalMs

  self._trackers.forEach(function (tracker) {
    tracker.setInterval(intervalMs)
  })
}

Client.prototype.destroy = function () {
  var self = this
  self._trackers.forEach(function (tracker) {
    tracker.destroy()
  })
}

inherits(Tracker, EventEmitter)

/**
 * An individual torrent tracker (used by Client)
 *
 * @param {Client} client       parent bittorrent tracker client
 * @param {string} announceUrl  announce url of tracker
 * @param {Object} opts         optional options
 */
function Tracker (client, announceUrl, opts) {
  var self = this
  EventEmitter.call(self)
  self._opts = opts || {}

  self.client = client

  debug('new tracker %s', announceUrl)

  self._announceUrl = announceUrl
  self._intervalMs = self.client._intervalMs // use client interval initially
  self._interval = null

  var protocol = url.parse(self._announceUrl).protocol
  if (protocol === 'udp:') {
    self._requestImpl = self._requestUdp
  } else if (protocol === 'http:' || protocol === 'https:') {
    self._requestImpl = self._requestHttp
  }
}

Tracker.prototype.start = function (opts) {
  var self = this
  opts = opts || {}
  opts.event = 'started'

  debug('sent `start` %s', self._announceUrl)
  self._announce(opts)
  self.setInterval(self._intervalMs) // start announcing on intervals
}

Tracker.prototype.stop = function (opts) {
  var self = this
  opts = opts || {}
  opts.event = 'stopped'

  debug('sent `stop` %s', self._announceUrl)
  self._announce(opts)
  self.destroy()
}

Tracker.prototype.complete = function (opts) {
  var self = this
  opts = opts || {}
  opts.event = 'completed'
  opts.downloaded = opts.downloaded || self.torrentLength || 0

  debug('sent `complete` %s', self._announceUrl)
  self._announce(opts)
}

Tracker.prototype.update = function (opts) {
  var self = this
  opts = opts || {}

  debug('sent `update` %s', self._announceUrl)
  self._announce(opts)
}

Tracker.prototype.destroy = function () {
  var self = this
  debug('destroy', self._announceUrl)
  self.setInterval(0) // stop announcing on intervals
}

/**
 * Send an announce request to the tracker.
 * @param {Object} opts
 * @param {number=} opts.uploaded
 * @param {number=} opts.downloaded
 * @param {number=} opts.left (if not set, calculated automatically)
 */
Tracker.prototype._announce = function (opts) {
  var self = this

  // defaults, user should provide real values
  if (opts.uploaded == null) opts.uploaded = 0
  if (opts.downloaded == null) opts.downloaded = 0

  if (self.client.torrentLength != null && opts.left == null) {
    opts.left = self.client.torrentLength - (opts.downloaded || 0)
  }

  self._requestImpl(self._announceUrl, opts)
}

/**
 * Send a scrape request to the tracker.
 */
Tracker.prototype.scrape = function () {
  var self = this

  self._scrapeUrl = self._scrapeUrl || getScrapeUrl(self._announceUrl)

  if (!self._scrapeUrl) {
    debug('scrape not supported %s', self._announceUrl)
    self.client.emit('error', new Error('scrape not supported for announceUrl ' + self._announceUrl))
    return
  }

  debug('sent `scrape` %s', self._announceUrl)
  self._requestImpl(self._scrapeUrl, { _scrape: true })
}

Tracker.prototype.setInterval = function (intervalMs) {
  var self = this
  clearInterval(self._interval)

  self._intervalMs = intervalMs
  if (intervalMs) {
    self._interval = setInterval(self.update.bind(self), self._intervalMs)
  }
}

Tracker.prototype._requestHttp = function (requestUrl, opts) {
  var self = this

  if (opts._scrape) {
    if (opts.info_hash == null) opts.info_hash = self.client._infoHash.toString('binary')
  } else {
    if (opts.info_hash == null) opts.info_hash = self.client._infoHash.toString('binary')
    if (opts.peer_id == null) opts.peer_id = self.client._peerId.toString('binary')
    if (opts.port == null) opts.port = self.client._port
    if (opts.compact == null) opts.compact = 1
    if (opts.numwant == null) opts.numwant = self.client._numWant

    if (self._trackerId) {
      opts.trackerid = self._trackerId
    }
  }

  get.concat(requestUrl + '?' + common.querystringStringify(opts), function (err, data, res) {
    if (err) return self.client.emit('warning', err)
    if (res.statusCode !== 200) return self.client.emit('warning', new Error('Non-200 response code ' + res.statusCode + ' from ' + requestUrl))
    if (data && data.length) self._handleResponse(requestUrl, data)
  })
}

Tracker.prototype._requestUdp = function (requestUrl, opts) {
  var self = this
  opts = opts || {}
  var parsedUrl = url.parse(requestUrl)
  var socket = dgram.createSocket('udp4')
  var transactionId = new Buffer(hat(32), 'hex')

  var stopped = opts.event === 'stopped'
  // if we're sending a stopped message, we don't really care if it arrives, so set
  // a short timer and don't call error
  var timeout = setTimeout(function () {
    timeout = null
    cleanup()
    if (!stopped) {
      error('tracker request timed out')
    }
  }, stopped ? 1500 : 15000)

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

  function genTransactionId () {
    transactionId = new Buffer(hat(32), 'hex')
  }

  function announce (connectionId, opts) {
    opts = opts || {}
    genTransactionId()

    send(Buffer.concat([
      connectionId,
      common.toUInt32(common.ACTIONS.ANNOUNCE),
      transactionId,
      self.client._infoHash,
      self.client._peerId,
      toUInt64(opts.downloaded || 0),
      opts.left ? toUInt64(opts.left) : new Buffer('FFFFFFFFFFFFFFFF', 'hex'),
      toUInt64(opts.uploaded || 0),
      common.toUInt32(common.EVENTS[opts.event] || 0),
      common.toUInt32(0), // ip address (optional)
      common.toUInt32(0), // key (optional)
      common.toUInt32(self.client._numWant),
      toUInt16(self.client._port || 0)
    ]))
  }

  function scrape (connectionId) {
    genTransactionId()

    send(Buffer.concat([
      connectionId,
      common.toUInt32(common.ACTIONS.SCRAPE),
      transactionId,
      self.client._infoHash
    ]))
  }
}

Tracker.prototype._handleResponse = function (requestUrl, data) {
  var self = this

  try {
    data = bencode.decode(data)
  } catch (err) {
    return self.client.emit('warning', new Error('Error decoding tracker response: ' + err.message))
  }
  var failure = data['failure reason']
  if (failure) {
    debug('failure from ' + requestUrl + ' (' + failure + ')')
    return self.client.emit('warning', new Error(failure))
  }

  var warning = data['warning message']
  if (warning) {
    debug('warning from ' + requestUrl + ' (' + warning + ')')
    self.client.emit('warning', new Error(warning))
  }

  debug('response from ' + requestUrl)

  if (requestUrl === self._announceUrl) {
    var interval = data.interval || data['min interval']
    if (interval && !self._opts.interval && self._intervalMs !== 0) {
      // use the interval the tracker recommends, UNLESS the user manually specifies an
      // interval they want to use
      self.setInterval(interval * 1000)
    }

    var trackerId = data['tracker id']
    if (trackerId) {
      // If absent, do not discard previous trackerId value
      self._trackerId = trackerId
    }

    self.client.emit('update', {
      announce: self._announceUrl,
      complete: data.complete,
      incomplete: data.incomplete
    })

    var addrs
    if (Buffer.isBuffer(data.peers)) {
      // tracker returned compact response
      try {
        addrs = compact2string.multi(data.peers)
      } catch (err) {
        return self.client.emit('warning', err)
      }
      addrs.forEach(function (addr) {
        self.client.emit('peer', addr)
      })
    } else if (Array.isArray(data.peers)) {
      // tracker returned normal response
      data.peers.forEach(function (peer) {
        self.client.emit('peer', peer.ip + ':' + peer.port)
      })
    }

    if (Buffer.isBuffer(data.peers6)) {
      // tracker returned compact response
      try {
        addrs = compact2string.multi6(data.peers6)
      } catch (err) {
        return self.client.emit('warning', err)
      }
      addrs.forEach(function (addr) {
        self.client.emit('peer', addr)
      })
    } else if (Array.isArray(data.peers6)) {
      // tracker returned normal response
      data.peers6.forEach(function (peer) {
        var ip = /^\[/.test(peer.ip) || !/:/.test(peer.ip)
          ? peer.ip /* ipv6 w/ brackets or domain name */
          : '[' + peer.ip + ']' /* ipv6 without brackets */
        self.client.emit('peer', ip + ':' + peer.port)
      })
    }
  } else if (requestUrl === self._scrapeUrl) {
    // NOTE: the unofficial spec says to use the 'files' key but i've seen 'host' in practice
    data = data.files || data.host || {}
    data = data[self.client._infoHash.toString('binary')]

    if (!data) {
      self.client.emit('warning', new Error('invalid scrape response'))
    } else {
      // TODO: optionally handle data.flags.min_request_interval (separate from announce interval)
      self.client.emit('scrape', {
        announce: self._announceUrl,
        complete: data.complete,
        incomplete: data.incomplete,
        downloaded: data.downloaded
      })
    }
  }
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

var UDP_TRACKER = /^udp:\/\//
var HTTP_SCRAPE_SUPPORT = /\/(announce)[^\/]*$/

function getScrapeUrl (announceUrl) {
  if (announceUrl.match(UDP_TRACKER)) return announceUrl
  var match = announceUrl.match(HTTP_SCRAPE_SUPPORT)
  if (match) {
    var i = match.index
    return announceUrl.slice(0, i) + '/scrape' + announceUrl.slice(i + 9)
  }
  return null
}
