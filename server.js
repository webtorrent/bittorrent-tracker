module.exports = Server

var bencode = require('bencode')
var debug = require('debug')('bittorrent-tracker')
var dgram = require('dgram')
var EventEmitter = require('events').EventEmitter
var http = require('http')
var inherits = require('inherits')
var series = require('run-series')
var string2compact = require('string2compact')

var common = require('./lib/common')
var Swarm = require('./lib/swarm')
var parseHttpRequest = require('./lib/parse_http')
var parseUdpRequest = require('./lib/parse_udp')

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
    ? opts.interval
    : 10 * 60 * 1000 // 10 min

  self._trustProxy = !!opts.trustProxy
  if (typeof opts.filter === 'function') self._filter = opts.filter

  self.listening = false
  self.torrents = {}

  // default to starting an http server unless the user explictly says no
  if (opts.http !== false) {
    self.http = http.createServer()
    self.http.on('request', self.onHttpRequest.bind(self))
    self.http.on('error', self._onError.bind(self))
    self.http.on('listening', onListening)
  }

  // default to starting a udp server unless the user explicitly says no
  if (opts.udp !== false) {
    self.udp = dgram.createSocket('udp4')
    self.udp.on('message', self.onUdpRequest.bind(self))
    self.udp.on('error', self._onError.bind(self))
    self.udp.on('listening', onListening)
  }

  var num = !!self.http + !!self.udp
  function onListening () {
    num -= 1
    if (num === 0) {
      self.listening = true
      self.emit('listening')
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

  if (!port) port = 0

  // ATTENTION:
  // binding to :: only receives IPv4 connections if the bindv6only
  // sysctl is set 0, which is the default on many operating systems.
  self.http && self.http.listen(port.http || port, '::')
  self.udp && self.udp.bind(port.udp || port)
}

Server.prototype.close = function (cb) {
  var self = this
  self.listening = false
  cb = cb || function () {}
  if (self.udp) {
    self.udp.close()
  }
  if (self.http) {
    self.http.close(cb)
  } else {
    cb(null)
  }
}

Server.prototype.getSwarm = function (infoHash, params) {
  var self = this
  if (!params) params = {}
  if (Buffer.isBuffer(infoHash)) infoHash = infoHash.toString('hex')
  if (self._filter && !self._filter(infoHash, params)) return null
  var swarm = self.torrents[infoHash]
  if (!swarm) swarm = self.torrents[infoHash] = new Swarm(infoHash, this)
  return swarm
}

Server.prototype.onHttpRequest = function (req, res, options) {
  var self = this
  options = options || {}
  options.trustProxy = options.trustProxy || self._trustProxy

  var params
  try {
    params = parseHttpRequest(req, options)
    params.httpReq = req
    params.httpRes = res
  } catch (err) {
    debug('sent error %s', err.message)
    res.end(bencode.encode({
      'failure reason': err.message
    }))

    // even though it's an error for the client, it's just a warning for the server.
    // don't crash the server because a client sent bad data :)
    self.emit('warning', err)

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

    if (params.action === common.ACTIONS.ANNOUNCE) {
      self.emit(common.EVENT_NAMES[params.event], params.addr)
    }
  })
}

Server.prototype.onUdpRequest = function (msg, rinfo) {
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
        action: common.ACTIONS.ERROR,
        'failure reason': err.message
      }
    }
    if (!self.listening) return

    response.transactionId = params.transactionId
    response.connectionId = params.connectionId

    var buf = makeUdpPacket(response)
    self.udp.send(buf, 0, buf.length, rinfo.port, rinfo.address)

    if (params.action === common.ACTIONS.ANNOUNCE) {
      self.emit(common.EVENT_NAMES[params.event], params.addr)
    }
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
  var swarm = self.getSwarm(params.info_hash, params)
  if (swarm === null) return cb(new Error('disallowed info_hash'))
  if (!params.event || params.event === 'empty') params.event = 'update'
  swarm.announce(params, function (err, response) {
    if (response) {
      if (!response.action) response.action = common.ACTIONS.ANNOUNCE
      if (!response.interval) response.interval = Math.ceil(self._intervalMs / 1000)

      if (params.compact === 1) {
        var peers = response.peers
        // Find IPv4 peers
        response.peers = string2compact(peers.filter(function (peer) {
          return common.IPV4_RE.test(peer.ip)
        }).map(function (peer) {
          return peer.ip + ':' + peer.port
        }))
        // Find IPv6 peers
        response.peers6 = string2compact(peers.filter(function (peer) {
          return common.IPV6_RE.test(peer.ip)
        }).map(function (peer) {
          return '[' + peer.ip + ']:' + peer.port
        }))
      }
      // IPv6 peers are not separate for non-compact responses
    }
    cb(err, response)
  })
}

Server.prototype._onScrape = function (params, cb) {
  var self = this

  if (params.info_hash == null) {
    // if info_hash param is omitted, stats for all torrents are returned
    // TODO: make this configurable!
    params.info_hash = Object.keys(self.torrents)
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

    var response = {
      action: common.ACTIONS.SCRAPE,
      files: {},
      flags: { min_request_interval: Math.ceil(self._intervalMs / 1000) }
    }

    results.forEach(function (result) {
      response.files[common.hexToBinary(result.infoHash)] = {
        complete: result.complete,
        incomplete: result.incomplete,
        downloaded: result.complete // TODO: this only provides a lower-bound
      }
    })

    cb(null, response)
  })
}

function makeUdpPacket (params) {
  var packet
  switch (params.action) {
    case common.ACTIONS.CONNECT:
      packet = Buffer.concat([
        common.toUInt32(common.ACTIONS.CONNECT),
        common.toUInt32(params.transactionId),
        params.connectionId
      ])
      break
    case common.ACTIONS.ANNOUNCE:
      packet = Buffer.concat([
        common.toUInt32(common.ACTIONS.ANNOUNCE),
        common.toUInt32(params.transactionId),
        common.toUInt32(params.interval),
        common.toUInt32(params.incomplete),
        common.toUInt32(params.complete),
        params.peers
      ])
      break
    case common.ACTIONS.SCRAPE:
      var firstInfoHash = Object.keys(params.files)[0]
      var scrapeInfo = firstInfoHash ? {
        complete: params.files[firstInfoHash].complete,
        incomplete: params.files[firstInfoHash].incomplete,
        completed: params.files[firstInfoHash].complete // TODO: this only provides a lower-bound
      } : {}
      packet = Buffer.concat([
        common.toUInt32(common.ACTIONS.SCRAPE),
        common.toUInt32(params.transactionId),
        common.toUInt32(scrapeInfo.complete),
        common.toUInt32(scrapeInfo.completed),
        common.toUInt32(scrapeInfo.incomplete)
      ])
      break
    case common.ACTIONS.ERROR:
      packet = Buffer.concat([
        common.toUInt32(common.ACTIONS.ERROR),
        common.toUInt32(params.transactionId || 0),
        new Buffer(params['failure reason'], 'utf8')
      ])
      break
    default:
      throw new Error('Action not implemented: ' + params.action)
  }
  return packet
}
