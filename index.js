exports.Client = Client
exports.Server = Server

var BN = require('bn.js')
var bncode = require('bncode')
var compact2string = require('compact2string')
var concat = require('concat-stream')
var dgram = require('dgram')
var EventEmitter = require('events').EventEmitter
var extend = require('extend.js')
var hat = require('hat')
var http = require('http')
var inherits = require('inherits')
var parallel = require('run-parallel')
var querystring = require('querystring')
var string2compact = require('string2compact')
var url = require('url')

var CONNECTION_ID = Buffer.concat([ toUInt32(0x417), toUInt32(0x27101980) ])
var ACTIONS = { CONNECT: 0, ANNOUNCE: 1, SCRAPE: 2 }
var EVENTS = { completed: 1, started: 2, stopped: 3 }
var MAX_UINT = 4294967295

inherits(Tracker, EventEmitter)

/**
 * An individual torrent tracker
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
  self._request(opts)

  self.setInterval(self._intervalMs) // start announcing on intervals
}

Tracker.prototype.stop = function (opts) {
  var self = this
  opts = opts || {}
  opts.event = 'stopped'
  self._request(opts)

  self.setInterval(0) // stop announcing on intervals
}

Tracker.prototype.complete = function (opts) {
  var self = this
  opts = opts || {}
  opts.event = 'completed'
  opts.downloaded = opts.downloaded || self.torrentLength || 0
  self._request(opts)
}

Tracker.prototype.update = function (opts) {
  var self = this
  opts = opts || {}
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
    self.client.emit('error', new Error('scrape not supported for announceUrl ' + self._announceUrl))
    return
  }

  opts = extend({
    info_hash: bytewiseEncodeURIComponent(self.client._infoHash)
  }, opts)

  self._requestImpl(self._scrapeUrl, opts)
}

Tracker.prototype.setInterval = function (intervalMs) {
  var self = this
  if (self._interval) {
    clearInterval(self._interval)
  }

  self._intervalMs = intervalMs
  if (self._intervalMs) {
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

  var timeout = setTimeout(function () {
    error('tracker request timed out')
  }, 15000)

  if (timeout.unref) {
    timeout.unref()
  }

  function error (message) {
    self.client.emit('error', new Error(message + ' (connecting to tracker ' + requestUrl + ')'))
    try { socket.close() } catch (e) { }
    clearTimeout(timeout)
  }

  socket.on('error', error)

  socket.on('message', function (message, rinfo) {

    if (message.length < 8 || message.readUInt32BE(4) !== transactionId.readUInt32BE(0)) {
      return error('tracker sent back invalid transaction id')
    }

    var action = message.readUInt32BE(0)
    switch (action) {
      case 0: // handshake
        if (message.length < 16) {
          return error('invalid udp handshake')
        }
        announce(message.slice(8, 16), opts)
        return

      case 1: // announce
        if (message.length < 20) {
          return error('invalid announce message')
        }

        var interval = message.readUInt32BE(8)
        if (interval && !self._opts.interval && self._intervalMs !== 0) {
          // use the interval the tracker recommends, UNLESS the user manually specifies an
          // interval they want to use
          self.setInterval(interval * 1000)
        }

        self.client.emit('update', {
          announce: self._announceUrl,
          complete: message.readUInt32BE(16),
          incomplete: message.readUInt32BE(12)
        })

        compact2string.multi(message.slice(20)).forEach(function (addr) {
          self.client.emit('peer', addr)
        })

        clearTimeout(timeout)
        socket.close()
        return

      case 2: // scrape
        if (message.length < 20) {
          return error('invalid scrape message')
        }

        self.client.emit('scrape', {
          announce: self._announceUrl,
          complete: message.readUInt32BE(8),
          downloaded: message.readUInt32BE(12),
          incomplete: message.readUInt32BE(16)
        })

        clearTimeout(timeout)
        socket.close()
        return
    }
  })

  function send (message) {
    if (!parsedUrl.port) {
      parsedUrl.port = 80;
    }
    socket.send(message, 0, message.length, parsedUrl.port, parsedUrl.hostname)
  }

  function genTransactionId () {
    transactionId = new Buffer(hat(32), 'hex')
  }

  function announce (connectionId, opts) {
    opts = opts || {}
    genTransactionId()

    send(Buffer.concat([
      connectionId,
      toUInt32(ACTIONS.ANNOUNCE),
      transactionId,
      self.client._infoHash,
      self.client._peerId,
      toUInt64(opts.downloaded || 0),
      opts.left ? toUInt64(opts.left) : new Buffer('FFFFFFFFFFFFFFFF', 'hex'),
      toUInt64(opts.uploaded || 0),
      toUInt32(EVENTS[opts.event] || 0),
      toUInt32(0), // ip address (optional)
      toUInt32(0), // key (optional)
      toUInt32(self.client._numWant),
      toUInt16(self.client._port || 0)
    ]))
  }

  function scrape (connectionId, opts) {
    genTransactionId()

    send(Buffer.concat([
      connectionId,
      toUInt32(ACTIONS.SCRAPE),
      transactionId,
      self.client._infoHash
    ]))
  }

  send(Buffer.concat([
    CONNECTION_ID,
    toUInt32(ACTIONS.CONNECT),
    transactionId
  ]))
}

Tracker.prototype._handleResponse = function (requestUrl, data) {
  var self = this

  try {
    data = bncode.decode(data)
  } catch (err) {
    return self.client.emit('error', new Error('Error decoding tracker response: ' + err.message))
  }
  var failure = data['failure reason']
  if (failure) {
    return self.client.emit('error', new Error(failure))
  }

  var warning = data['warning message']
  if (warning) {
    self.client.emit('warning', warning);
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
  self._announce = torrent.announce

  // optional
  self._numWant = self._opts.numWant || 80
  self._intervalMs = self._opts.interval || (30 * 60 * 1000) // default: 30 minutes

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

inherits(Server, EventEmitter)

/**
 * A BitTorrent tracker server.
 *
 * A "BitTorrent tracker" is an HTTP service which responds to GET requests from
 * BitTorrent clients. The requests include metrics from clients that help the tracker
 * keep overall statistics about the torrent. The response includes a peer list that
 * helps the client participate in the torrent.
 *
 * @param {Object}  opts            options
 * @param {Number}  opts.interval   interval in ms that clients should announce on
 * @param {Number}  opts.trustProxy Trust 'x-forwarded-for' header from reverse proxy
 * @param {boolean} opts.http       Start an http server? (default: true)
 * @param {boolean} opts.udp        Start a udp server? (default: true)
 */
function Server (opts) {
  var self = this
  if (!(self instanceof Server)) return new Server(opts)
  EventEmitter.call(self)
  opts = opts || {}

  self._interval = opts.interval
    ? opts.interval / 1000
    : 10 * 60 // 10 min (in secs)

  self._trustProxy = !!opts.trustProxy

  self.torrents = {}

  // default to starting an http server unless the user explictly says no
  if (opts.http !== false) {
    self._httpServer = http.createServer()
    self._httpServer.on('request', self._onHttpRequest.bind(self))
    self._httpServer.on('error', function (err) {
      self.emit('error', err)
    })
  }

  // default to starting a udp server unless the user explicitly says no
  if (opts.udp !== false) {
    self._udpServer = dgram.createSocket('udp4')
    self._udpServer.on('message', self._onUdpRequest.bind(self))
  }
}

Server.prototype.listen = function (port) {
  var self = this
  var tasks = []

  self._httpServer && tasks.push(function (cb) {
    self._httpServer.listen(port, cb)
  })
  self._udpServer && tasks.push(function (cb) {
    self._udpServer.bind(port, cb)
  })

  parallel(tasks, function (err) {
    if (err) return self.emit('error', err)
    self.emit('listening')
  })
}

Server.prototype.close = function (cb) {
  var self = this
  if (self._udpServer) {
    self._udpServer.close()
  }
  if (self._httpServer) {
    self._httpServer.close(cb)
  } else {
    cb(null)
  }
}

Server.prototype._onHttpRequest = function (req, res) {
  var self = this

  function error (message) {
    res.end(bncode.encode({
      'failure reason': message
    }))
    self.emit('error', new Error(message))
  }

  var warning
  var s = req.url.split('?')
  var params = querystring.parse(s[1])

  // TODO: detect when required params are missing
  // TODO: support multiple info_hash parameters as a concatenation of individual requests
  var infoHash = bytewiseDecodeURIComponent(params.info_hash).toString('hex')

  if (!infoHash) {
    return error('bittorrent-tracker server only supports announcing one torrent at a time')
  }

  if (s[0] === '/announce') {
    var ip = self._trustProxy
      ? req.headers['x-forwarded-for'] || req.connection.remoteAddress
      : req.connection.remoteAddress
    var port = Number(params.port)
    var addr = ip + ':' + port
    var peerId = bytewiseDecodeURIComponent(params.peer_id).toString('utf8')

    var swarm = self._getSwarm(infoHash)
    var peer = swarm.peers[addr]

    switch (params.event) {
      case 'started':
        if (peer) {
          warning = 'unexpected `started` event from peer that is already in swarm'
        }

        var left = Number(params.left)

        if (left === 0) {
          swarm.complete += 1
        } else {
          swarm.incomplete += 1
        }

        peer = swarm.peers[addr] = {
          ip: ip,
          port: port,
          peerId: peerId
        }
        self.emit('start', addr, params)
        break

      case 'stopped':
        if (!peer) {
          return error('unexpected `stopped` event from peer that is not in swarm')
        }

        if (peer.complete) {
          swarm.complete -= 1
        } else {
          swarm.incomplete -= 1
        }

        delete swarm.peers[addr]

        self.emit('stop', addr, params)
        break

      case 'completed':
        if (!peer) {
          return error('unexpected `completed` event from peer that is not in swarm')
        }
        if (peer.complete) {
          warning = 'unexpected `completed` event from peer that is already marked as completed'
        }
        peer.complete = true

        swarm.complete += 1
        swarm.incomplete -= 1

        self.emit('complete', addr, params)
        break

      case '': // update
      case undefined:
        if (!peer) {
          return error('unexpected `update` event from peer that is not in swarm')
        }

        self.client.emit('update', addr, params)
        break

      default:
        return error('unexpected event: ' + params.event) // early return
    }

    // send peers
    var peers = Number(params.compact) === 1
      ? self._getPeersCompact(swarm)
      : self._getPeers(swarm)

    var response = {
      complete: swarm.complete,
      incomplete: swarm.incomplete,
      peers: peers,
      interval: self._interval
    }

    if (warning) {
      response['warning message'] = warning
    }
    res.end(bncode.encode(response))

  } else if (s[0] === '/scrape') { // unofficial scrape message
    var swarm = self._getSwarm(infoHash)
    var response = { files : { } }

    response.files[params.info_hash] = {
      complete: swarm.complete,
      incomplete: swarm.incomplete,
      downloaded: swarm.complete, // TODO: this only provides a lower-bound
      flags: {
        min_request_interval: self._interval
      }
    }

    res.end(bncode.encode(response))
  }
}

Server.prototype._getSwarm = function (infoHash) {
  var self = this
  var swarm = self.torrents[infoHash]
  if (!swarm) {
    swarm = self.torrents[infoHash] = {
      complete: 0,
      incomplete: 0,
      peers: {}
    }
  }

  return swarm
}

Server.prototype._onUdpRequest = function (req, res) {
  // TODO: implement UDP server
}

Server.prototype._getPeers = function (swarm) {
  var self = this
  var peers = []
  for (var peerId in swarm.peers) {
    var peer = swarm.peers[peerId]
    peers.push({
      'peer id': peer.peerId,
      ip: peer.ip,
      port: peer.port
    })
  }
  return peers
}

Server.prototype._getPeersCompact = function (swarm) {
  var self = this
  var addrs = Object.keys(swarm.peers).map(function (peerId) {
    var peer = swarm.peers[peerId]
    return peer.ip + ':' + peer.port
  })

  return string2compact(addrs)
}

//
// HELPERS
//

function toUInt16 (n) {
  var buf = new Buffer(2)
  buf.writeUInt16BE(n, 0)
  return buf
}

function toUInt32 (n) {
  var buf = new Buffer(4)
  buf.writeUInt32BE(n, 0)
  return buf
}

function toUInt64 (n) {
  if (n > MAX_UINT || typeof n === 'string') {
    var bytes = new BN(n).toArray()
    while (bytes.length < 8) {
      bytes.unshift(0)
    }
    return new Buffer(bytes)
  }
  return Buffer.concat([toUInt32(0), toUInt32(n)])
}

function bytewiseEncodeURIComponent (buf) {
  return encodeURIComponent(buf.toString('binary'))
}

function bytewiseDecodeURIComponent (str) {
  return new Buffer(decodeURIComponent(str), 'binary')
}
