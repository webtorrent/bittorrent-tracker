const Client = require('../')
const common = require('./common')
const fixtures = require('webtorrent-fixtures')
const test = require('tape')

const peerId = Buffer.from('01234567890123456789')
const port = 6681

test('ensure client.destroy() callback is called with re-used websockets in socketPool', function (t) {
  t.plan(4)

  common.createServer(t, 'ws', function (server, announceUrl) {
    const client1 = new Client({
      infoHash: fixtures.leaves.parsedTorrent.infoHash,
      announce: announceUrl,
      peerId,
      port,
      wrtc: {}
    })

    common.mockWebsocketTracker(client1)
    client1.on('error', function (err) { t.error(err) })
    client1.on('warning', function (err) { t.error(err) })

    client1.start()

    client1.once('update', function () {
      t.pass('got client1 update')
      // second ws client using same announce url will re-use the same websocket
      const client2 = new Client({
        infoHash: fixtures.alice.parsedTorrent.infoHash, // different info hash
        announce: announceUrl,
        peerId,
        port,
        wrtc: {}
      })

      common.mockWebsocketTracker(client2)
      client2.on('error', function (err) { t.error(err) })
      client2.on('warning', function (err) { t.error(err) })

      client2.start()

      client2.once('update', function () {
        t.pass('got client2 update')
        client1.destroy(function (err) {
          t.error(err, 'got client1 destroy callback')
          client2.destroy(function (err) {
            t.error(err, 'got client2 destroy callback')
            server.close()
          })
        })
      })
    })
  })
})
