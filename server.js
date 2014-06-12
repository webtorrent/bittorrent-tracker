module.exports = Server

var bencode = require('bencode')
var bufferEqual = require('buffer-equal')
var common = require('./lib/common')
var dgram = require('dgram')
var EventEmitter = require('events').EventEmitter
var http = require('http')
var inherits = require('inherits')
var ipLib = require('ip')
var parallel = require('run-parallel')
var querystring = require('querystring')
var string2compact = require('string2compact')


var REMOVE_IPV6_RE = /^::ffff:/

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

  self._intervalMs = opts.interval
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

Server.prototype.listen = function (port, onlistening) {
  var self = this
  var tasks = []

  if (onlistening) {
    self.once('listening', onlistening)
  }

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
  cb = cb || function () {}
  if (self._udpServer) {
    self._udpServer.close()
  }
  if (self._httpServer) {
    self._httpServer.close(cb)
  } else {
    cb(null)
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

Server.prototype._onHttpRequest = function (req, res) {
  var self = this
  var warning
  var s = req.url.split('?')
  var params = querystring.parse(s[1])

  // TODO: detect when required params are missing
  // TODO: support multiple info_hash parameters as a concatenation of individual requests
  var infoHash = bytewiseDecodeURIComponent(params.info_hash).toString('hex')

  if (!infoHash) {
    return error('bittorrent-tracker server only supports announcing one torrent at a time')
  }

  if (s[0] === '/announce' || s[0] === '/') {
    var ip = self._trustProxy
      ? req.headers['x-forwarded-for'] || req.connection.remoteAddress
      : req.connection.remoteAddress.replace(REMOVE_IPV6_RE, '') // force ipv4
    var port = Number(params.port)
    var addr = ip + ':' + port
    var peerId = bytewiseDecodeURIComponent(params.peer_id).toString('utf8')

    var swarm = self._getSwarm(infoHash)
    var peer = swarm.peers[addr]

    switch (params.event) {
      case 'started':
        if (peer) {
          warning = 'unexpected `started` event from peer that is already in swarm'
        } else {
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
          self.emit('start', addr)
        }

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

        swarm.peers[addr] = null

        self.emit('stop', addr)
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

        self.emit('complete', addr)
        break

      case '': // update
      case undefined:
        if (!peer) {
          return error('unexpected `update` event from peer that is not in swarm')
        }

        self.emit('update', addr)
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
      interval: self._intervalMs
    }

    if (warning) {
      response['warning message'] = warning
    }
    res.end(bencode.encode(response))

  } else if (s[0] === '/scrape') { // unofficial scrape message
    var swarm = self._getSwarm(infoHash)
    var response = { files : { } }

    response.files[params.info_hash] = {
      complete: swarm.complete,
      incomplete: swarm.incomplete,
      downloaded: swarm.complete, // TODO: this only provides a lower-bound
      flags: {
        min_request_interval: self._intervalMs
      }
    }

    res.end(bencode.encode(response))
  }

  function error (message) {
    res.end(bencode.encode({
      'failure reason': message
    }))

    // even though it's an error for the client, it's just a warning for the server.
    // don't crash the server because a client sent bad data :)
    self.emit('warning', new Error(message))
  }
}

Server.prototype._onUdpRequest = function (msg, rinfo) {
  var self = this

  if (msg.length < 16) {
    return error('received packet is too short')
  }

  if (rinfo.family !== 'IPv4') {
    return error('udp tracker does not support IPv6')
  }

  var connectionId = msg.slice(0, 8) // 64-bit
  var action = msg.readUInt32BE(8)
  var transactionId = msg.readUInt32BE(12)

  if (!bufferEqual(connectionId, common.CONNECTION_ID)) {
    return error('received packet with invalid connection id')
  }

  var socket = dgram.createSocket('udp4')

  if (action === common.ACTIONS.CONNECT) {
    send(Buffer.concat([
      common.toUInt32(common.ACTIONS.CONNECT),
      common.toUInt32(transactionId),
      connectionId
    ]))
  } else if (action === common.ACTIONS.ANNOUNCE) {
    var infoHash = msg.slice(16, 36).toString('hex') // 20 bytes
    var peerId = msg.slice(36, 56).toString('utf8') // 20 bytes
    var downloaded = fromUInt64(msg.slice(56, 64))
    var left = fromUInt64(msg.slice(64, 72))
    var uploaded = fromUInt64(msg.slice(72, 80))
    var event = msg.readUInt32BE(80)
    var ip = msg.readUInt32BE(84) // optional
    var key = msg.readUInt32BE(88)
    var numWant = msg.readUInt32BE(92) // optional
    var port = msg.readUInt16BE(96) // optional

    if (ip) {
      ip = ipLib.toString(ip)
    } else {
      ip = rinfo.address
    }

    if (!port) {
      port = rinfo.port
    }

    var addr = ip + ':' + port

    var swarm = self._getSwarm(infoHash)
    var peer = swarm.peers[addr]

    switch (event) {
      case common.EVENTS.started:
        if (peer) {
          return error('unexpected `started` event from peer that is already in swarm')
        }

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
        self.emit('start', addr)

        break

      case common.EVENTS.stopped:
        if (!peer) {
          return error('unexpected `stopped` event from peer that is not in swarm')
        }

        if (peer.complete) {
          swarm.complete -= 1
        } else {
          swarm.incomplete -= 1
        }

        swarm.peers[addr] = null

        self.emit('stop', addr)
        break

      case common.EVENTS.completed:
        if (!peer) {
          return error('unexpected `completed` event from peer that is not in swarm')
        }
        if (peer.complete) {
          warning = 'unexpected `completed` event from peer that is already marked as completed'
        }
        peer.complete = true

        swarm.complete += 1
        swarm.incomplete -= 1

        self.emit('complete', addr)
        break

      case common.EVENTS.update: // update
        if (!peer) {
          return error('unexpected `update` event from peer that is not in swarm')
        }

        self.emit('update', addr)
        break

      default:
        return error('unexpected event: ' + event) // early return
    }

    // send peers
    var peers = self._getPeersCompact(swarm)

    // never send more than 70 peers or else the UDP packet will get too big
    if (peers.length >= 70 * 6) {
      peers = peers.slice(0, 70 * 6)
    }

    send(Buffer.concat([
      common.toUInt32(common.ACTIONS.ANNOUNCE),
      common.toUInt32(transactionId),
      common.toUInt32(self._intervalMs),
      common.toUInt32(swarm.incomplete),
      common.toUInt32(swarm.complete),
      peers
    ]))

  } else if (action === common.ACTIONS.SCRAPE) { // scrape message
    var infoHash = msg.slice(16, 36).toString('hex') // 20 bytes

    // TODO: support multiple info_hash scrape
    if (msg.length > 36) {
      error('multiple info_hash scrape not supported')
    }

    var swarm = self._getSwarm(infoHash)

    send(Buffer.concat([
      common.toUInt32(common.ACTIONS.SCRAPE),
      common.toUInt32(transactionId),
      common.toUInt32(swarm.complete),
      common.toUInt32(swarm.complete), // TODO: this only provides a lower-bound
      common.toUInt32(swarm.incomplete)
    ]))
  }

  function send (buf) {
    socket.send(buf, 0, buf.length, rinfo.port, rinfo.address, function () {
      try { socket.close() } catch (err) {}
    })
  }

  function error (message) {
    send(Buffer.concat([
      common.toUInt32(common.ACTIONS.ERROR),
      common.toUInt32(transactionId || 0),
      new Buffer(message, 'utf8')
    ]))
    self.emit('warning', new Error(message))
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
  var addrs = []

  Object.keys(swarm.peers).forEach(function (peerId) {
    var peer = swarm.peers[peerId]
    if (peer) {
      addrs.push(peer.ip + ':' + peer.port)
    }
  })

  return string2compact(addrs)
}

// HELPER FUNCTIONS

var TWO_PWR_32 = (1 << 16) * 2

/**
 * Return the closest floating-point representation to the buffer value. Precision will be
 * lost for big numbers.
 */
function fromUInt64 (buf) {
  var high = buf.readUInt32BE(0) | 0 // force
  var low = buf.readUInt32BE(4) | 0
  var lowUnsigned = (low >= 0) ? low : TWO_PWR_32 + low

  return high * TWO_PWR_32 + lowUnsigned
}

function bytewiseDecodeURIComponent (str) {
  return new Buffer(decodeURIComponent(str), 'binary')
}
