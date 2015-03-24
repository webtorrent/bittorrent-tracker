// TODO: destroy the websocket

module.exports = WebSocketTracker

var debug = require('debug')('bittorrent-tracker:http-tracker')
var EventEmitter = require('events').EventEmitter
var hat = require('hat')
var inherits = require('inherits')
var Peer = require('simple-peer')
var Socket = require('simple-websocket')

var common = require('./common')

// It turns out that you can't open multiple websockets to the same server within one
// browser tab, so let's reuse them.
var socketPool = {}

inherits(WebSocketTracker, EventEmitter)

function WebSocketTracker (client, announceUrl, opts) {
  var self = this
  EventEmitter.call(self)
  debug('new websocket tracker %s', announceUrl)

  self.client = client

  self._announceUrl = announceUrl
  self._peers = {} // peers (offer id -> peer)
  self._ready = false
  self._socket = null
  self._intervalMs = self.client._intervalMs // use client interval initially
  self._interval = null

  if (socketPool[announceUrl]) self._socket = socketPool[announceUrl]
  else self._socket = socketPool[announceUrl] = new Socket(announceUrl)

  self._socket.on('warning', self._onSocketWarning.bind(self))
  self._socket.on('error', self._onSocketWarning.bind(self)) // TODO: handle error
  self._socket.on('message', self._onSocketMessage.bind(self))
}

WebSocketTracker.prototype.announce = function (opts) {
  var self = this
  if (!self._socket.ready) return self._socket.on('ready', self.announce.bind(self, opts))

  opts.info_hash = self.client._infoHash.toString('binary')
  opts.peer_id = self.client._peerId.toString('binary')

  self._generateOffers(opts.numWant, function (offers) {
    opts.offers = offers

    if (self._trackerId) {
      opts.trackerid = self._trackerId
    }
    self._send(opts)
  })
}

WebSocketTracker.prototype.scrape = function (opts) {
  var self = this
  self.client.emit('error', new Error('scrape not supported ' + self._announceUrl))
  return
}

// TODO: Improve this interface
WebSocketTracker.prototype.setInterval = function (intervalMs) {
  var self = this
  clearInterval(self._interval)

  self._intervalMs = intervalMs
  if (intervalMs) {
    // HACK
    var update = self.announce.bind(self, self.client._defaultAnnounceOpts())
    self._interval = setInterval(update, self._intervalMs)
  }
}

WebSocketTracker.prototype._onSocketWarning = function (err) {
  debug('tracker warning %s', err.message)
}

WebSocketTracker.prototype._onSocketMessage = function (data) {
  var self = this

  if (!(typeof data === 'object' && data !== null)) {
    return self.client.emit('warning', new Error('Invalid tracker response'))
  }

  if (data.info_hash !== self.client._infoHash.toString('binary')) return

  debug('received %s from %s', JSON.stringify(data), self._announceUrl)

  var failure = data['failure reason']
  if (failure) return self.client.emit('warning', new Error(failure))

  var warning = data['warning message']
  if (warning) self.client.emit('warning', new Error(warning))

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

  if (data.complete) {
    self.client.emit('update', {
      announce: self._announceUrl,
      complete: data.complete,
      incomplete: data.incomplete
    })
  }

  var peer
  if (data.offer) {
    peer = new Peer({ trickle: false, config: self._opts.rtcConfig })
    peer.id = common.binaryToHex(data.peer_id)
    peer.once('signal', function (answer) {
      var opts = {
        info_hash: self.client._infoHash.toString('binary'),
        peer_id: self.client._peerId.toString('binary'),
        to_peer_id: data.peer_id,
        answer: answer,
        offer_id: data.offer_id
      }
      if (self._trackerId) opts.trackerid = self._trackerId
      self._send(opts)
    })
    peer.signal(data.offer)
    self.client.emit('peer', peer)
  }

  if (data.answer) {
    peer = self._peers[data.offer_id]
    if (peer) {
      peer.id = common.binaryToHex(data.peer_id)
      peer.signal(data.answer)
      self.client.emit('peer', peer)
    } else {
      debug('got unexpected answer: ' + JSON.stringify(data.answer))
    }
  }
}

WebSocketTracker.prototype._send = function (opts) {
  var self = this
  debug('send %s', JSON.stringify(opts))
  self._socket.send(opts)
}

WebSocketTracker.prototype._generateOffers = function (numWant, cb) {
  var self = this
  var offers = []
  debug('generating %s offers', numWant)

  // TODO: cleanup dead peers and peers that never get a return offer, from self._peers
  for (var i = 0; i < numWant; ++i) {
    generateOffer()
  }

  function generateOffer () {
    var offerId = hat(160)
    var peer = self._peers[offerId] = new Peer({
      initiator: true,
      trickle: false,
      config: self._opts.rtcConfig
    })
    peer.once('signal', function (offer) {
      offers.push({
        offer: offer,
        offer_id: offerId
      })
      checkDone()
    })
  }

  function checkDone () {
    if (offers.length === numWant) {
      debug('generated %s offers', numWant)
      cb(offers)
    }
  }
}
