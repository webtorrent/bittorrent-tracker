exports.Client = Client
exports.Server = Server

var bncode = require('bncode')
var compact2string = require('compact2string')
var EventEmitter = require('events').EventEmitter
var extend = require('extend.js')
var hat = require('hat')
var http = require('http')
var inherits = require('inherits')
var querystring = require('querystring')
var string2compact = require('string2compact')

inherits(Client, EventEmitter)

function Client (peerId, port, torrent, opts) {
  var self = this
  if (!(self instanceof Client)) return new Client(peerId, port, torrent, opts)
  EventEmitter.call(self)
  self._opts = opts || {}

  // required
  self._peerId = peerId
  self._port = port
  self._infoHash = torrent.infoHash
  self._torrentLength = torrent.length
  self._announce = torrent.announce

  // optional
  self._numWant = self._opts.numWant || 80
  self._intervalMs = self._opts.interval || (30 * 60 * 1000) // default: 30 minutes

  self._interval = null
}

Client.prototype.start = function (opts) {
  var self = this
  opts = opts || {}
  opts.event = 'started'
  self._request(opts)

  self.setInterval(self._intervalMs) // start announcing on intervals
}

Client.prototype.stop = function (opts) {
  var self = this
  opts = opts || {}
  opts.event = 'stopped'
  self._request(opts)

  self.setInterval(0) // stop announcing on intervals
}

Client.prototype.complete = function (opts) {
  var self = this
  opts = opts || {}
  opts.event = 'completed'
  opts.downloaded = self._torrentLength
  self._request(opts)
}

Client.prototype.update = function (opts) {
  var self = this
  opts = opts || {}
  self._request(opts)
}

Client.prototype.setInterval = function (intervalMs) {
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
 * Send a request to the tracker
 */
Client.prototype._request = function (opts) {
  var self = this
  opts = extend({
    info_hash: bytewiseEncodeURIComponent(self._infoHash),
    peer_id: bytewiseEncodeURIComponent(self._peerId),
    port: self._port,
    left: self._torrentLength - (opts.downloaded || 0),
    compact: 1,
    numwant: self._numWant,
    uploaded: 0, // default, user should provide real value
    downloaded: 0 // default, user should provide real value
  }, opts)

  if (self._trackerId) {
    opts.trackerid = self._trackerId
  }

  var q = querystring.stringify(opts)

  self._announce.forEach(function (announce) {
    var url = announce + '?' + q
    var req = http.get(url, function (res) {
      var data = ''
      if (res.statusCode !== 200) {
        res.resume() // consume the whole stream
        self.emit('error', new Error('Invalid response code ' + res.statusCode + ' from tracker'))
        return
      }
      res.on('data', function (chunk) {
        data += chunk
      })
      res.on('end', function () {
        self._handleResponse(data, announce)
      })
    })

    req.on('error', function (err) {
      self.emit('error', req)
    })
  })
}

Client.prototype._handleResponse = function (data, announce) {
  var self = this

  try {
    data = bncode.decode(data)
  } catch (err) {
    return self.emit('error', new Error('Error decoding tracker response: ' + err.message))
  }
  var failure = data['failure reason']
  if (failure) {
    return self.emit('error', new Error(failure))
  }

  var warning = data['warning message']
  if (warning) {
    console.warn(warning)
  }

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

  self.emit('update', {
    announce: announce,
    complete: data.complete,
    incomplete: data.incomplete
  })

  if (Buffer.isBuffer(data.peers)) {
    // tracker returned compact response
    var addrs = compact2string.multi(data.peers)
    addrs.forEach(function (addr) {
      self.emit('peer', addr)
    })
  } else if (Array.isArray(data.peers)) {
    // tracker returned normal response
    data.peers.forEach(function (peer) {
      var ip = peer.ip
      self.emit('peer', ip[0] + '.' + ip[1] + '.' + ip[2] + '.' + ip[3] + ':' + peer.port)
    })
  }
}

inherits(Server, EventEmitter)

function Server (opts) {
  var self = this
  if (!(self instanceof Server)) return new Server(opts)
  EventEmitter.call(self)
  opts = opts || {}

  self._interval = opts.interval
    ? opts.interval / 1000
    : 10 * 60 // 10 min (in secs)

  self._trustProxy = !!opts.trustProxy

  self._swarms = {}

  self._server = http.createServer()
  self._server.on('request', self._onRequest.bind(self))
}

Server.prototype.listen = function (port) {
  var self = this
  self._server.listen(port, function () {
    self.emit('listening')
  })
}

Server.prototype.close = function (cb) {
  var self = this
  self._server.close(cb)
}

Server.prototype._onRequest = function (req, res) {
  var self = this
  var s = req.url.split('?')
  if (s[0] === '/announce') {
    var params = querystring.parse(s[1])

    var ip = self._trustProxy
      ? req.headers['x-forwarded-for'] || req.connection.remoteAddress
      : req.connection.remoteAddress
    var port = Number(params.port)
    var addr = ip + ':' + port

    var infoHash = bytewiseDecodeURIComponent(params.info_hash)
    var peerId = bytewiseDecodeURIComponent(params.peer_id)

    var swarm = self._swarms[infoHash]
    if (!swarm) {
      swarm = self._swarms[infoHash] = {
        complete: 0,
        incomplete: 0,
        peers: {}
      }
    }
    var peer = swarm.peers[addr]
    switch (params.event) {
      case 'started':
        if (peer) {
          return
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
          return
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
        if (!peer || peer.complete) {
          return
        }
        peer.complete = true

        swarm.complete += 1
        swarm.incomplete -= 1

        self.emit('complete', addr, params)
        break

      case '': // update
      case undefined:
        if (!peer) {
          return
        }

        self.emit('update', addr, params)
        break

      default:
        res.end(bncode.encode({
          'failure reason': 'unexpected event: ' + params.event
        }))
        self.emit('error', new Error('unexpected event: ' + params.event))
        return // early return
    }

    // send peers
    var peers = Number(params.compact) === 1
      ? self._getPeersCompact(swarm)
      : self._getPeers(swarm)

    res.end(bncode.encode({
      complete: swarm.complete,
      incomplete: swarm.incomplete,
      peers: peers,
      interval: self._interval
    }))
  }
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

function bytewiseEncodeURIComponent (buf) {
  if (!Buffer.isBuffer(buf)) {
    buf = new Buffer(buf, 'hex')
  }
  return encodeURIComponent(buf.toString('binary'))
}

function bytewiseDecodeURIComponent (str) {
  if (Buffer.isBuffer(str)) {
    str = str.toString('utf8')
  }
  return (new Buffer(decodeURIComponent(str), 'binary').toString('hex'))
}
