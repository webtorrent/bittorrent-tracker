module.exports = Swarm

var debug = require('debug')('bittorrent-tracker')

// Regard this as the default implementation of an interface that you
// need to support when overriding Server.getSwarm()
function Swarm (infoHash, server) {
  this.peers = {}
  this.complete = 0
  this.incomplete = 0
}

Swarm.prototype.announce = function (params, cb) {
  var self = this
  var peer = self.peers[params.addr || params.peer_id]

  // Dispatch announce event
  var fn = '_onAnnounce_' + params.event
  if (self[fn]) {
    self[fn](params, peer) // process event

    if (params.left === 0 && peer) peer.complete = true

    cb(null, {
      complete: self.complete,
      incomplete: self.incomplete,
      peers: self._getPeers(params.numwant, params.peer_id)
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
  peer = this.peers[params.addr || params.peer_id] = {
    complete: false,
    ip: params.ip, // only http+udp
    peerId: params.peer_id, // as hex
    port: params.port, // only http+udp
    socket: params.socket // only websocket
  }
}

Swarm.prototype._onAnnounce_stopped = function (params, peer) {
  if (!peer) {
    debug('unexpected `stopped` event from peer that is not in swarm')
    return // do nothing
  }

  if (peer.complete) this.complete -= 1
  else this.incomplete -= 1
  this.peers[params.addr || params.peer_id] = null
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
}

// TODO: randomize the peers that are given out
Swarm.prototype._getPeers = function (numWant, fromPeerId) {
  var peers = []
  for (var peerId in this.peers) {
    if (peers.length >= numWant) break
    if (peerId === fromPeerId) continue // skip self

    var peer = this.peers[peerId]
    if (!peer) continue // ignore null values
    peers.push(peer)
  }
  return peers
}
