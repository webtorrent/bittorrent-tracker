const Client = require('../')
const common = require('./common')
const fixtures = require('webtorrent-fixtures')
const test = require('tape')

const peerId = Buffer.from('01234567890123456789')

function testLargeTorrent (t, serverType) {
  t.plan(9)

  common.createServer(t, serverType, function (server, announceUrl) {
    const client = new Client({
      infoHash: fixtures.sintel.parsedTorrent.infoHash,
      peerId,
      port: 6881,
      announce: announceUrl,
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

test('http: large torrent: client.start()', function (t) {
  testLargeTorrent(t, 'http')
})

test('udp: large torrent: client.start()', function (t) {
  testLargeTorrent(t, 'udp')
})

test('ws: large torrent: client.start()', function (t) {
  testLargeTorrent(t, 'ws')
})
