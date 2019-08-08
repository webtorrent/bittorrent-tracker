var Client = require('../')
var common = require('./common')
var test = require('tape')
var wrtc = require('wrtc')

var infoHash = '4cb67059ed6bd08362da625b3ae77f6f4a075705'
var peerId = Buffer.from('01234567890123456789')
var peerId2 = Buffer.from('12345678901234567890')
var peerId3 = Buffer.from('23456789012345678901')

function serverTest (t, serverType, serverFamily) {
  t.plan(10)

  var hostname = serverFamily === 'inet6'
    ? '[::1]'
    : '127.0.0.1'

  var opts = {
    serverType: serverType,
    peersCacheLength: 2 // LRU cache can only contain a max of 2 peers
  }

  common.createServer(t, opts, function (server) {
    // Not using announceUrl param from `common.createServer()` since we
    // want to control IPv4 vs IPv6.
    var port = server[serverType].address().port
    var announceUrl = serverType + '://' + hostname + ':' + port + '/announce'

    var client1 = new Client({
      infoHash: infoHash,
      announce: [announceUrl],
      peerId: peerId,
      port: 6881,
      wrtc: wrtc
    })
    if (serverType === 'ws') common.mockWebsocketTracker(client1)

    client1.start()

    client1.once('update', function (data) {
      var client2 = new Client({
        infoHash: infoHash,
        announce: [announceUrl],
        peerId: peerId2,
        port: 6882,
        wrtc: wrtc
      })
      if (serverType === 'ws') common.mockWebsocketTracker(client2)

      client2.start()

      client2.once('update', function (data) {
        server.getSwarm(infoHash, function (err, swarm) {
          t.error(err)

          t.equal(swarm.complete + swarm.incomplete, 2)

          // Ensure that first peer is evicted when a third one is added
          var evicted = false
          swarm.peers.once('evict', function (evictedPeer) {
            t.equal(evictedPeer.value.peerId, peerId.toString('hex'))
            t.equal(swarm.complete + swarm.incomplete, 2)
            evicted = true
          })

          var client3 = new Client({
            infoHash: infoHash,
            announce: [announceUrl],
            peerId: peerId3,
            port: 6880,
            wrtc: wrtc
          })
          if (serverType === 'ws') common.mockWebsocketTracker(client3)

          client3.start()

          client3.once('update', function (data) {
            t.ok(evicted, 'client1 was evicted from server before client3 gets response')
            t.equal(swarm.complete + swarm.incomplete, 2)

            client1.destroy(function () {
              t.pass('client1 destroyed')
            })

            client2.destroy(function () {
              t.pass('client3 destroyed')
            })

            client3.destroy(function () {
              t.pass('client3 destroyed')
            })

            server.close(function () {
              t.pass('server destroyed')
            })
          })
        })
      })
    })
  })
}

test('evict: ipv4 server', function (t) {
  serverTest(t, 'http', 'inet')
})

test('evict: http ipv6 server', function (t) {
  serverTest(t, 'http', 'inet6')
})

test('evict: udp server', function (t) {
  serverTest(t, 'udp', 'inet')
})

test('evict: ws server', function (t) {
  serverTest(t, 'ws', 'inet')
})
