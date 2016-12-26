var Buffer = require('safe-buffer').Buffer
var Client = require('bittorrent-tracker')
var common = require('./common')
var fixtures = require('webtorrent-fixtures')
var test = require('tape')

var peerId = Buffer.from('01234567890123456789')

test('large torrent: client.start()', function (t) {
  t.plan(9)

  common.createServer(t, {}, function (server, announceUrl) {
    console.log(announceUrl)

    var client = new Client({
      infoHash: fixtures.sintel.parsedTorrent.infoHash,
      peerId: peerId,
      port: 6881,
      announce: announceUrl,
      wrtc: {}
    })

    common.mockWebsocketTracker(client)
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
})
