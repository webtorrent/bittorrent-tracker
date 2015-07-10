module.exports = Swarm

var debug = require('debug')('bittorrent-tracker')
var randomIterate = require('random-iterate')

var NodeCache = require('node-cache')

// Regard this as the default implementation of an interface that you
// need to support when overriding Server.getSwarm()
function Swarm (infoHash, server) {
  var self = this
  // 900 seconds === 15 minutes
  this.cache = new NodeCache({checkperiod: 0, stdTTL: 900, useClones: false})
  this.peers = {
    get: function (key) {
      return self.cache.get(key)
    },
    set: function (key, value) {
      return self.cache.set(key, value)
    },
    del: function (key) {
      return self.cache.del(key)
    },
    keys: function () {
      return self.cache.keys()
    }
  }
  this.complete = 0
  this.incomplete = 0
}

Swarm.prototype.announce = function (params, cb) {
  var self = this
  var peer = self.peers.get(params.addr || params.peer_id)

  // Dispatch announce event
  var fn = '_onAnnounce_' + params.event
  if (self[fn]) {
    self[fn](params, peer) // process event

    var peerType = params.compact === undefined ? 'webrtc' : 'addr'
    cb(null, {
      complete: self.complete,
      incomplete: self.incomplete,
      peers: self._getPeers(params.numwant, peerType)
    })
  } else {
    cb(new Error('invalid event'))
  }
}

Swarm.prototype.scrape = function (params, cb) {
  cb(null, {
    complete: this.complete,
    incomplete: this.incomplete
  })
}

Swarm.prototype._onAnnounce_started = function (params, peer) {
  if (peer) {
    debug('unexpected `started` event from peer that is already in swarm')
    return this._onAnnounce_update(params, peer) // treat as an update
  }

  if (params.left === 0) this.complete += 1
  else this.incomplete += 1
  peer = this.peers.set((params.addr || params.peer_id), {
    complete: params.left === 0,
    ip: params.ip, // only http+udp
    peerId: params.peer_id, // as hex
    port: params.port, // only http+udp
    socket: params.socket // only websocket
  })
}

Swarm.prototype._onAnnounce_stopped = function (params, peer) {
  if (!peer) {
    debug('unexpected `stopped` event from peer that is not in swarm')
    return // do nothing
  }

  if (peer.complete) this.complete -= 1
  else this.incomplete -= 1
  this.peers.del(params.addr || params.peer_id)
}

Swarm.prototype._onAnnounce_completed = function (params, peer) {
  if (!peer) {
    debug('unexpected `completed` event from peer that is not in swarm')
    return this._onAnnounce_started(params, peer) // treat as a start
  }
  if (peer.complete) {
    debug('unexpected `completed` event from peer that is already marked as completed')
    return // do nothing
  }

  this.complete += 1
  this.incomplete -= 1
  peer.complete = true
}

Swarm.prototype._onAnnounce_update = function (params, peer) {
  if (!peer) {
    debug('unexpected `update` event from peer that is not in swarm')
    return this._onAnnounce_started(params, peer) // treat as a start
  }

  if (!peer.complete && params.left === 0) {
    this.complete += 1
    this.incomplete -= 1
    peer.complete = true
  }
}

Swarm.prototype._getPeers = function (numWant, peerType) {
  var peers = []
  var ite = randomIterate(this.peers.keys())
  while (true) {
    var peerId = ite()
    if (peers.length >= numWant || peerId == null) return peers
    var peer = this.peers.get(peerId)
    if (peer &&
        ((peerType === 'webrtc' && peer.socket) || (peerType === 'addr' && peer.ip))) {
      peers.push(peer)
    }
  }
}
