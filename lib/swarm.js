var debug = require('debug')('bittorrent-tracker')

module.exports = Swarm

// Regard this as the default implementation of an interface that you
// need to support when overriding Server.getSwarm()
function Swarm (infoHash, server) {
  this.peers = {}
  this.complete = 0
  this.incomplete = 0
  this.emit = server.emit.bind(server)
}

Swarm.prototype.announce = function (params, cb) {
  var self = this
  var peer = self.peers[params.addr]

  var start = function () {
    if (peer) {
      debug('unexpected `started` event from peer that is already in swarm')
      return update() // treat as an update
    }
    if (params.left === 0) self.complete += 1
    else self.incomplete += 1
    peer = self.peers[params.addr] = {
      ip: params.ip,
      port: params.port,
      peerId: params.peer_id
    }
    self.emit('start', params.addr)
  }

  var stop = function () {
    if (!peer) {
      debug('unexpected `stopped` event from peer that is not in swarm')
      return // do nothing
    }
    if (peer.complete) self.complete -= 1
    else self.incomplete -= 1
    self.peers[params.addr] = null
    self.emit('stop', params.addr)
  }

  var complete = function () {
    if (!peer) {
      debug('unexpected `completed` event from peer that is not in swarm')
      return start() // treat as a start
    }
    if (peer.complete) {
      debug('unexpected `completed` event from peer that is already marked as completed')
      return // do nothing
    }
    self.complete += 1
    self.incomplete -= 1
    peer.complete = true
    self.emit('complete', params.addr)
  }

  var update = function () {
    if (!peer) {
      debug('unexpected `update` event from peer that is not in swarm')
      return start() // treat as a start
    }
    self.emit('update', params.addr)
  }

  switch (params.event) {
  case 'started':
    start()
    break
  case 'stopped':
    stop()
    break
  case 'completed':
    complete()
    break
  case '': case undefined: case 'empty': case 'update': // update
    update()
    break
  default:
    return cb(new Error('invalid event')) // early return
  }

  if (params.left === 0 && peer) peer.complete = true

  // send peers
  var peers = self._getPeers(params.numwant)

  cb(null, {
    complete: this.complete,
    incomplete: this.incomplete,
    peers: peers
  })
}

Swarm.prototype._getPeers = function (numwant) {
  var peers = []
  for (var peerId in this.peers) {
    if (peers.length >= numwant) break
    var peer = this.peers[peerId]
    if (!peer) continue // ignore null values
    peers.push({
      'peer id': peer.peerId,
      ip: peer.ip,
      port: peer.port
    })
  }
  return peers
}

Swarm.prototype.scrape = function (infoHash, params, cb) {
  cb(null, {
    complete: this.complete,
    incomplete: this.incomplete
  })
}
