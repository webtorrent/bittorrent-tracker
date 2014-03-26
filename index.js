exports.Client = Client
// TODO: exports.Server = Server
// TODO: support connecting to UDP trackers (http://www.bittorrent.org/beps/bep_0015.html)

var bncode = require('bncode')
var compact2string = require('compact2string')
var EventEmitter = require('events').EventEmitter
var extend = require('extend.js')
var http = require('http')
var inherits = require('inherits')
var querystring = require('querystring')

inherits(Client, EventEmitter)

function Client (peerId, port, torrent, opts) {
  var self = this
  if (!(self instanceof Client)) return new Client(peerId, port, torrent)
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
    self.setInterval(interval)
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

function bytewiseEncodeURIComponent (buf) {
  if (!Buffer.isBuffer(buf)) {
    buf = new Buffer(buf, 'hex')
  }
  return escape(buf.toString('binary'))
}