const Client = require('../')
const common = require('./common')
const fixtures = require('webtorrent-fixtures')
const magnet = require('magnet-uri')
const test = require('tape')

const peerId = Buffer.from('01234567890123456789')

function testMagnet (t, serverType) {
  t.plan(9)

  const parsedTorrent = magnet(fixtures.leaves.magnetURI)

  common.createServer(t, serverType, function (server, announceUrl) {
    const client = new Client({
      infoHash: parsedTorrent.infoHash,
      announce: announceUrl,
      peerId,
      port: 6881,
      wrtc: {}
    })

    if (serverType === 'ws') common.mockWebsocketTracker(client)
    client.on('error', function (err) { t.error(err) })
    client.on('warning', function (err) { t.error(err) })

    client.once('update', function (data) {
      t.equal(data.announce, announceUrl)
      t.equal(typeof data.complete, 'number')
      t.equal(typeof data.incomplete, 'number')

      client.update()

      client.once('update', function (data) {
        t.equal(data.announce, announceUrl)
        t.equal(typeof data.complete, 'number')
        t.equal(typeof data.incomplete, 'number')

        client.stop()

        client.once('update', function (data) {
          t.equal(data.announce, announceUrl)
          t.equal(typeof data.complete, 'number')
          t.equal(typeof data.incomplete, 'number')

          server.close()
          client.destroy()
        })
      })
    })

    client.start()
  })
}

test('http: magnet: client.start/update/stop()', function (t) {
  testMagnet(t, 'http')
})

test('udp: magnet: client.start/update/stop()', function (t) {
  testMagnet(t, 'udp')
})

test('ws: magnet: client.start/update/stop()', function (t) {
  testMagnet(t, 'ws')
})
