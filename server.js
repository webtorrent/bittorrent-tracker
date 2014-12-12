module.exports = Server

var bencode = require('bencode')
var debug = require('debug')('bittorrent-tracker')
var dgram = require('dgram')
var EventEmitter = require('events').EventEmitter
var http = require('http')
var inherits = require('inherits')
var portfinder = require('portfinder')
var series = require('run-series')
var string2compact = require('string2compact')

var common = require('./lib/common')
var Swarm = require('./lib/swarm')
var parseHttpRequest = require('./lib/parse_http')
var parseUdpRequest = require('./lib/parse_udp')

// Use random port above 1024
portfinder.basePort = Math.floor(Math.random() * 60000) + 1025


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

  self.listening = false
  self.port = null
  self.torrents = {}

  // default to starting an http server unless the user explictly says no
  if (opts.http !== false) {
    self._httpServer = http.createServer()
    self._httpServer.on('request', self._onHttpRequest.bind(self))
    self._httpServer.on('error', self._onError.bind(self))
    self._httpServer.on('listening', onListening)
  }

  // default to starting a udp server unless the user explicitly says no
  if (opts.udp !== false) {
    self._udpServer = dgram.createSocket('udp4')
    self._udpServer.on('message', self._onUdpRequest.bind(self))
    self._udpServer.on('error', self._onError.bind(self))
    self._udpServer.on('listening', onListening)
  }

  var num = !!self._httpServer + !!self._udpServer
  function onListening () {
    num -= 1
    if (num === 0) {
      self.listening = true
      self.emit('listening', self.port)
    }
  }
}

Server.prototype._onError = function (err) {
  var self = this
  self.emit('error', err)
}

Server.prototype.listen = function (port, onlistening) {
  var self = this
  if (typeof port === 'function') {
    onlistening = port
    port = undefined
  }
  if (self.listening) throw new Error('server already listening')
  if (onlistening) self.once('listening', onlistening)

  function onPort (err, port) {
    if (err) return self.emit('error', err)
    self.port = port
    self._httpServer && self._httpServer.listen(port.http || port)
    self._udpServer && self._udpServer.bind(port.udp || port)
  }

  if (port) onPort(null, port)
  else portfinder.getPort(onPort)
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

Server.prototype.getSwarm = function (binaryInfoHash) {
  var self = this
  if (Buffer.isBuffer(binaryInfoHash)) binaryInfoHash = binaryInfoHash.toString('binary')
  var swarm = self.torrents[binaryInfoHash]
  if (!swarm) {
    swarm = self.torrents[binaryInfoHash] = new Swarm(binaryInfoHash, this)
  }
  return swarm
}

Server.prototype._onHttpRequest = function (req, res) {
  var self = this
  var error
  var params
  try {
    params = parseHttpRequest(req, {
      trustProxy: self._trustProxy
    })
  } catch (err) {
    error = err
  }

  if (!error && !params) error = new Error('Empty HTTP parameters')
  if (error) {
    debug('sent error %s', error.message)
    res.end(bencode.encode({
      'failure reason': error.message
    }))

    // even though it's an error for the client, it's just a warning for the server.
    // don't crash the server because a client sent bad data :)
    self.emit('warning', error)

    return
  }

  this._onRequest(params, function (err, response) {
    if (err) {
      self.emit('warning', err)
      response = {
        'failure reason': err.message
      }
    }

    delete response.action  // only needed for UDP encoding
    res.end(bencode.encode(response))
  })
}

Server.prototype._onUdpRequest = function (msg, rinfo) {
  var self = this

  var params
  try {
    params = parseUdpRequest(msg, rinfo)
  } catch (err) {
    self.emit('warning', err)
    // Do not reply for parsing errors
    return
  }

  // Handle
  this._onRequest(params, function (err, response) {
    if (err) {
      self.emit('warning', err)
      response = {
        action: common.ACTIONS.ERRROR,
        'failure reason': err.message
      }
    }

    var socket = dgram.createSocket('udp4')
    response.transactionId = params.transactionId
    response.connectionId = params.connectionId
    var buf = makeUdpPacket(response)
    socket.send(buf, 0, buf.length, rinfo.port, rinfo.address, function () {
      try {
        socket.close()
      } catch (err) {}
    })
  })
}

Server.prototype._onRequest = function (params, cb) {
  if (params && params.action === common.ACTIONS.CONNECT) {
    cb(null, { action: common.ACTIONS.CONNECT })
  } else if (params && params.action === common.ACTIONS.ANNOUNCE) {
    this._onAnnounce(params, cb)
  } else if (params && params.action === common.ACTIONS.SCRAPE) {
    this._onScrape(params, cb)
  } else {
    cb(new Error('Invalid action'))
  }
}

Server.prototype._onAnnounce = function (params, cb) {
  var self = this
  var swarm = self.getSwarm(params.info_hash)
  swarm.announce(params, function (err, response) {
    if (response) {
      if (!response.action) response.action = common.ACTIONS.ANNOUNCE
      if (!response.intervalMs) response.intervalMs = self._intervalMs
      if (params.compact === 1) {
        response.peers = string2compact(response.peers.map(function (peer) {
          return peer.ip + ':' + peer.port // TODO: ipv6 brackets
        }))
      }
    }
    cb(err, response)
  })
}

Server.prototype._onScrape = function (params, cb) {
  var self = this

  if (typeof params.info_hash === 'string') {
    params.info_hash = [ params.info_hash ]
  } else if (params.info_hash == null) {
    // if info_hash param is omitted, stats for all torrents are returned
    // TODO: make this configurable!
    params.info_hash = Object.keys(self.torrents)
  }

  if (!Array.isArray(params.info_hash)) {
    var err = new Error('invalid info_hash')
    self.emit('warning', err)
    return cb(err)
  }

  var response = {
    action: common.ACTIONS.SCRAPE,
    files: {},
    flags: {
      min_request_interval: self._intervalMs
    }
  }

  series(params.info_hash.map(function (infoHash) {
    var swarm = self.getSwarm(infoHash)
    return function (cb) {
      swarm.scrape(params, function (err, scrapeInfo) {
        cb(err, scrapeInfo && {
          infoHash: infoHash,
          complete: scrapeInfo.complete || 0,
          incomplete: scrapeInfo.incomplete || 0
        })
      })
    }
  }), function (err, results) {
    if (err) return cb(err)

    results.forEach(function (result) {
      response.files[result.infoHash] = {
        complete: result.complete,
        incomplete: result.incomplete,
        downloaded: result.complete // TODO: this only provides a lower-bound
      }
    })

    cb(null, response)
  })
}


function makeUdpPacket (params) {
  switch (params.action) {
    case common.ACTIONS.CONNECT:
      return Buffer.concat([
        common.toUInt32(common.ACTIONS.CONNECT),
        common.toUInt32(params.transactionId),
        params.connectionId
      ])
    case common.ACTIONS.ANNOUNCE:
      return Buffer.concat([
        common.toUInt32(common.ACTIONS.ANNOUNCE),
        common.toUInt32(params.transactionId),
        common.toUInt32(params.intervalMs),
        common.toUInt32(params.incomplete),
        common.toUInt32(params.complete),
        params.peers
      ])
    case common.ACTIONS.SCRAPE:
      var firstInfoHash = Object.keys(params.files)[0]
      var scrapeInfo = firstInfoHash ? {
        complete: params.files[firstInfoHash].complete,
        incomplete: params.files[firstInfoHash].incomplete,
        completed: params.files[firstInfoHash].complete // TODO: this only provides a lower-bound
      } : {}
      return Buffer.concat([
        common.toUInt32(common.ACTIONS.SCRAPE),
        common.toUInt32(params.transactionId),
        common.toUInt32(scrapeInfo.complete),
        common.toUInt32(scrapeInfo.completed),
        common.toUInt32(scrapeInfo.incomplete)
      ])
    case common.ACTIONS.ERROR:
      return Buffer.concat([
        common.toUInt32(common.ACTIONS.ERROR),
        common.toUInt32(params.transactionId || 0),
        new Buffer(params.message, 'utf8')
      ])
  default:
    throw new Error('Action not implemented: ' + params.action)
  }
}
