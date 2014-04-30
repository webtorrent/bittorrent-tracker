exports.Client = Client
exports.Server = Server

var bn = require('bn.js')
var bncode = require('bncode')
var compact2string = require('compact2string')
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
var ACTIONS = { CONNECT: 0, ANNOUNCE: 1 }
var EVENTS = { completed: 1, started: 2, stopped: 3 }
var MAX_UINT = 4294967295

inherits(Client, EventEmitter)

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

  self._announce.forEach(function (announceUrl) {
    if (announceUrl.indexOf('udp:') === 0) {
      self._requestUdp(announceUrl, opts)
    } else {
      self._requestHttp(announceUrl, opts)
    }
  })
}

Client.prototype._requestHttp = function (announceUrl, opts) {
  var self = this
  var fullUrl = announceUrl + '?' + querystring.stringify(opts)

  var req = http.get(fullUrl, function (res) {
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
      self._handleResponse(data, announceUrl)
    })
  })

  req.on('error', function (err) {
    self.emit('error', err)
  })
}

Client.prototype._requestUdp = function (announceUrl, opts) {
  var self = this
  var parsedUrl = url.parse(announceUrl)
  var socket = dgram.createSocket('udp4')
  var transactionId = new Buffer(hat(32), 'hex')

  var timeout = setTimeout(function () {
    error('tracker request timed out')
  }, 15000)

  if (timeout.unref) {
    timeout.unref()
  }

  function error (message) {
    self.emit('error', new Error(message))
    socket.close()
    clearTimeout(timeout)
  }

  socket.on('error', function (err) {
    error(err)
  })

  socket.on('message', function (message, rinfo) {

    if (message.length < 8 || message.readUInt32BE(4) !== transactionId.readUInt32BE(0)) {
      return error(new Error('tracker sent back invalid transaction id'))
    }

    var action = message.readUInt32BE(0)
    switch (action) {
      case 0:
        if (message.length < 16) {
          return error(new Error('invalid udp handshake'))
        }
        announce(message.slice(8, 16), opts)
        return

      case 1:
        if (message.length < 20) {
          return error(new Error('invalid announce message'))
        }

        // TODO: this should be stored per tracker, not globally for all trackers
        var interval = message.readUInt32BE(8)
        if (interval && !self._opts.interval && self._intervalMs !== 0) {
          // use the interval the tracker recommends, UNLESS the user manually specifies an
          // interval they want to use
          self.setInterval(interval * 1000)
        }

        self.emit('update', {
          announce: announceUrl,
          complete: message.readUInt32BE(16),
          incomplete: message.readUInt32BE(12)
        })

        compact2string.multi(message.slice(20)).forEach(function (addr) {
          self.emit('peer', addr)
        })

        clearTimeout(timeout)
        socket.close()
    }
  })

  function send (message) {
    if (!parsedUrl.port) {
      parsedUrl.port = 80;
    }
    socket.send(message, 0, message.length, parsedUrl.port, parsedUrl.hostname)
  }

  function announce (connectionId, opts) {
    opts = opts || {}
    transactionId = new Buffer(hat(32), 'hex')

    send(Buffer.concat([
      connectionId,
      toUInt32(ACTIONS.ANNOUNCE),
      transactionId,
      self._infoHash,
      self._peerId,
      toUInt64(opts.downloaded || 0),
      toUInt64(opts.left || 0),
      toUInt64(opts.uploaded || 0),
      toUInt32(EVENTS[opts.event] || 0),
      toUInt32(0), // ip address (optional)
      toUInt32(0), // key (optional)
      toUInt32(self._numWant),
      toUInt16(self._port || 0)
    ]))
  }

  send(Buffer.concat([
    CONNECTION_ID,
    toUInt32(ACTIONS.CONNECT),
    transactionId
  ]))
}

Client.prototype._handleResponse = function (data, announceUrl) {
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
    self.emit('warning', warning);
  }

  // TODO: this should be stored per tracker, not globally for all trackers
  var interval = data.interval || data['min interval']
  if (interval && !self._opts.interval && self._intervalMs !== 0) {
    // use the interval the tracker recommends, UNLESS the user manually specifies an
    // interval they want to use
    self.setInterval(interval * 1000)
  }

  // TODO: this should be stored per tracker, not globally for all trackers
  var trackerId = data['tracker id']
  if (trackerId) {
    // If absent, do not discard previous trackerId value
    self._trackerId = trackerId
  }

  self.emit('update', {
    announce: announceUrl,
    complete: data.complete,
    incomplete: data.incomplete
  })

  if (Buffer.isBuffer(data.peers)) {
    // tracker returned compact response
    compact2string.multi(data.peers).forEach(function (addr) {
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

  if (s[0] === '/announce') {
    var params = querystring.parse(s[1])

    var ip = self._trustProxy
      ? req.headers['x-forwarded-for'] || req.connection.remoteAddress
      : req.connection.remoteAddress
    var port = Number(params.port)
    var addr = ip + ':' + port

    var infoHash = bytewiseDecodeURIComponent(params.info_hash).toString('hex')
    var peerId = bytewiseDecodeURIComponent(params.peer_id).toString('utf8')

    var swarm = self.torrents[infoHash]
    if (!swarm) {
      swarm = self.torrents[infoHash] = {
        complete: 0,
        incomplete: 0,
        peers: {}
      }
    }
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

        self.emit('update', addr, params)
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
  }
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
    var bytes = bn(n).toArray()
    while (bytes.length < 8) bytes.unshift(0)
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
