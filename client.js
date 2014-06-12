module.exports = Client

var BN = require('bn.js')
var bencode = require('bencode')
var common = require('./lib/common')
var compact2string = require('compact2string')
var concat = require('concat-stream')
var debug = require('debug')('bittorrent-tracker:client')
var dgram = require('dgram')
var EventEmitter = require('events').EventEmitter
var extend = require('extend.js')
var hat = require('hat')
var http = require('http')
var inherits = require('inherits')
var querystring = require('querystring')
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
    : new Buffer(peerId, 'utf8')
  self._port = port
  self._infoHash = Buffer.isBuffer(torrent.infoHash)
    ? torrent.infoHash
    : new Buffer(torrent.infoHash, 'hex')
  self.torrentLength = torrent.length

  // optional
  self._numWant = self._opts.numWant || 80
  self._intervalMs = self._opts.interval || (30 * 60 * 1000) // default: 30 minutes

  debug('new tracker client for ' + self._infoHash.toString('hex'))

  if (typeof torrent.announce === 'string') {
    // magnet-uri returns a string if the magnet uri only contains one 'tr' parameter
    torrent.announce = [torrent.announce]
  }
  self._trackers = torrent.announce.map(function (announceUrl) {
    return new Tracker(self, announceUrl, self._opts)
  })
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

  debug('new tracker for ' + announceUrl)

  self._announceUrl = announceUrl
  self._intervalMs = self.client._intervalMs // use client interval initially
  self._interval = null

  if (self._announceUrl.indexOf('udp:') === 0) {
    self._requestImpl = self._requestUdp
  } else {
    self._requestImpl = self._requestHttp
  }

}

Tracker.prototype.start = function (opts) {
  var self = this
  opts = opts || {}
  opts.event = 'started'

  debug('sent `start` to ' + self._announceUrl)
  self._request(opts)
  self.setInterval(self._intervalMs) // start announcing on intervals
}

Tracker.prototype.stop = function (opts) {
  var self = this
  opts = opts || {}
  opts.event = 'stopped'

  debug('sent `stop` to ' + self._announceUrl)
  self._request(opts)
  self.setInterval(0) // stop announcing on intervals
}

Tracker.prototype.complete = function (opts) {
  var self = this
  opts = opts || {}
  opts.event = 'completed'
  opts.downloaded = opts.downloaded || self.torrentLength || 0

  debug('sent `complete` to ' + self._announceUrl)
  self._request(opts)
}

Tracker.prototype.update = function (opts) {
  var self = this
  opts = opts || {}

  debug('sent `update` to ' + self._announceUrl)
  self._request(opts)
}

Tracker.prototype.scrape = function (opts) {
  var self = this

  if (!self._scrapeUrl) {
    var announce = 'announce'
    var i = self._announceUrl.lastIndexOf('/') + 1

    if (i >= 1 && self._announceUrl.slice(i, i + announce.length) === announce) {
      self._scrapeUrl = self._announceUrl.slice(0, i) + 'scrape' + self._announceUrl.slice(i + announce.length)
    }
  }

  if (!self._scrapeUrl) {
    debug('scrape not supported by ' + self._announceUrl)
    self.client.emit('error', new Error('scrape not supported for announceUrl ' + self._announceUrl))
    return
  }

  debug('sent `scrape` to ' + self._announceUrl)

  opts = extend({
    info_hash: bytewiseEncodeURIComponent(self.client._infoHash)
  }, opts)

  self._requestImpl(self._scrapeUrl, opts)
}

Tracker.prototype.setInterval = function (intervalMs) {
  var self = this
  clearInterval(self._interval)

  self._intervalMs = intervalMs
  if (intervalMs) {
    self._interval = setInterval(self.update.bind(self), self._intervalMs)
  }
}

/**
 * Send an announce request to the tracker
 */
Tracker.prototype._request = function (opts) {
  var self = this
  opts = extend({
    info_hash: bytewiseEncodeURIComponent(self.client._infoHash),
    peer_id: bytewiseEncodeURIComponent(self.client._peerId),
    port: self.client._port,
    compact: 1,
    numwant: self.client._numWant,
    uploaded: 0, // default, user should provide real value
    downloaded: 0 // default, user should provide real value
  }, opts)

  if (self.client.torrentLength !== undefined) {
    opts.left = self.client.torrentLength - (opts.downloaded || 0)
  }

  if (self._trackerId) {
    opts.trackerid = self._trackerId
  }

  self._requestImpl(self._announceUrl, opts)
}

Tracker.prototype._requestHttp = function (requestUrl, opts) {
  var self = this
  var fullUrl = requestUrl + '?' + querystring.stringify(opts)

  var req = http.get(fullUrl, function (res) {
    if (res.statusCode !== 200) {
      res.resume() // consume the whole stream
      self.client.emit('error', new Error('Invalid response code ' + res.statusCode + ' from tracker ' + requestUrl))
      return
    }
    res.pipe(concat(function (data) {
      if (data && data.length) self._handleResponse(requestUrl, data)
    }))
  })

  req.on('error', function (err) {
    self.client.emit('error', err)
  })
}

Tracker.prototype._requestUdp = function (requestUrl, opts) {
  var self = this
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

  socket.on('message', function (msg, rinfo) {
    if (msg.length < 8 || msg.readUInt32BE(4) !== transactionId.readUInt32BE(0)) {
      return error('tracker sent back invalid transaction id')
    }

    var action = msg.readUInt32BE(0)
    switch (action) {
      case 0: // handshake
        if (msg.length < 16) {
          return error('invalid udp handshake')
        }

        var scrapeStr = 'scrape'
        if (requestUrl.substr(requestUrl.lastIndexOf('/') + 1, scrapeStr.length) === scrapeStr) {
          scrape(msg.slice(8, 16), opts)
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

        compact2string.multi(msg.slice(20)).forEach(function (addr) {
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
        self.client.emit('error', new Error(msg.slice(8).toString()))
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
    self.client.emit('error', new Error(message + ' (connecting to tracker ' + requestUrl + ')'))
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

  function scrape (connectionId, opts) {
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
    return self.client.emit('error', new Error('Error decoding tracker response: ' + err.message))
  }
  var failure = data['failure reason']
  if (failure) {
    return self.client.emit('error', new Error(failure))
  }

  var warning = data['warning message']
  if (warning) {
    self.client.emit('warning', warning)
  }

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

    if (Buffer.isBuffer(data.peers)) {
      // tracker returned compact response
      compact2string.multi(data.peers).forEach(function (addr) {
        self.client.emit('peer', addr)
      })
    } else if (Array.isArray(data.peers)) {
      // tracker returned normal response
      data.peers.forEach(function (peer) {
        var ip = peer.ip
        self.client.emit('peer', ip[0] + '.' + ip[1] + '.' + ip[2] + '.' + ip[3] + ':' + peer.port)
      })
    }
  } else if (requestUrl === self._scrapeUrl) {
    // NOTE: the unofficial spec says to use the 'files' key but i've seen 'host' in practice
    data = data.files || data.host || {}
    data = data[bytewiseEncodeURIComponent(self.client._infoHash)]

    if (!data) {
      self.client.emit('error', new Error('invalid scrape response'))
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

//
// HELPERS
//

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

function bytewiseEncodeURIComponent (buf) {
  return encodeURIComponent(buf.toString('binary'))
}
