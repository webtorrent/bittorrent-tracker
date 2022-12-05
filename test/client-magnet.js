import Client from '../index.js'
import common from './common.js'
import fixtures from 'webtorrent-fixtures'
import magnet from 'magnet-uri'
import test from 'tape'

const peerId = Buffer.from('01234567890123456789')

function testMagnet (t, serverType) {
  t.plan(9)

  const parsedTorrent = magnet(fixtures.leaves.magnetURI)

  common.createServer(t, serverType, (server, announceUrl) => {
    const client = new Client({
      infoHash: parsedTorrent.infoHash,
      announce: announceUrl,
      peerId,
      port: 6881,
      wrtc: {}
    })

    if (serverType === 'ws') common.mockWebsocketTracker(client)
    client.on('error', err => { t.error(err) })
    client.on('warning', err => { t.error(err) })

    client.once('update', data => {
      t.equal(data.announce, announceUrl)
      t.equal(typeof data.complete, 'number')
      t.equal(typeof data.incomplete, 'number')

      client.update()

      client.once('update', data => {
        t.equal(data.announce, announceUrl)
        t.equal(typeof data.complete, 'number')
        t.equal(typeof data.incomplete, 'number')

        client.stop()

        client.once('update', data => {
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

test('http: magnet: client.start/update/stop()', t => {
  testMagnet(t, 'http')
})

test('udp: magnet: client.start/update/stop()', t => {
  testMagnet(t, 'udp')
})

test('ws: magnet: client.start/update/stop()', t => {
  testMagnet(t, 'ws')
})
