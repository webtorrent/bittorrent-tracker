const Client = require('../')
const common = require('./common')
const test = require('tape')
const wrtc = require('wrtc')

const infoHash = '4cb67059ed6bd08362da625b3ae77f6f4a075705'
const peerId = Buffer.from('01234567890123456789')
const peerId2 = Buffer.from('12345678901234567890')
const peerId3 = Buffer.from('23456789012345678901')

function serverTest (t, serverType, serverFamily) {
  t.plan(10)

  const hostname = serverFamily === 'inet6'
    ? '[::1]'
    : '127.0.0.1'

  const opts = {
    serverType,
    peersCacheLength: 2 // LRU cache can only contain a max of 2 peers
  }

  common.createServer(t, opts, server => {
    // Not using announceUrl param from `common.createServer()` since we
    // want to control IPv4 vs IPv6.
    const port = server[serverType].address().port
    const announceUrl = `${serverType}://${hostname}:${port}/announce`

    const client1 = new Client({
      infoHash,
      announce: [announceUrl],
      peerId,
      port: 6881,
      wrtc
    })
    if (serverType === 'ws') common.mockWebsocketTracker(client1)

    client1.start()

    client1.once('update', data => {
      const client2 = new Client({
        infoHash,
        announce: [announceUrl],
        peerId: peerId2,
        port: 6882,
        wrtc
      })
      if (serverType === 'ws') common.mockWebsocketTracker(client2)

      client2.start()

      client2.once('update', data => {
        server.getSwarm(infoHash, (err, swarm) => {
          t.error(err)

          t.equal(swarm.complete + swarm.incomplete, 2)

          // Ensure that first peer is evicted when a third one is added
          let evicted = false
          swarm.peers.once('evict', evictedPeer => {
            t.equal(evictedPeer.value.peerId, peerId.toString('hex'))
            t.equal(swarm.complete + swarm.incomplete, 2)
            evicted = true
          })

          const client3 = new Client({
            infoHash,
            announce: [announceUrl],
            peerId: peerId3,
            port: 6880,
            wrtc
          })
          if (serverType === 'ws') common.mockWebsocketTracker(client3)

          client3.start()

          client3.once('update', data => {
            t.ok(evicted, 'client1 was evicted from server before client3 gets response')
            t.equal(swarm.complete + swarm.incomplete, 2)

            client1.destroy(() => {
              t.pass('client1 destroyed')
            })

            client2.destroy(() => {
              t.pass('client3 destroyed')
            })

            client3.destroy(() => {
              t.pass('client3 destroyed')
            })

            server.close(() => {
              t.pass('server destroyed')
            })
          })
        })
      })
    })
  })
}

test('evict: ipv4 server', t => {
  serverTest(t, 'http', 'inet')
})

test('evict: http ipv6 server', t => {
  serverTest(t, 'http', 'inet6')
})

test('evict: udp server', t => {
  serverTest(t, 'udp', 'inet')
})

test('evict: ws server', t => {
  serverTest(t, 'ws', 'inet')
})
