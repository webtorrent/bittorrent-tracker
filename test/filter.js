import Client from '../index.js'
import common from './common.js'
import fixtures from 'webtorrent-fixtures'
import test from 'tape'

const peerId = Buffer.from('01234567890123456789')

function testFilterOption (t, serverType) {
  t.plan(8)

  const opts = { serverType } // this is test-suite-only option
  opts.filter = (infoHash, params, cb) => {
    process.nextTick(() => {
      if (infoHash === fixtures.alice.parsedTorrent.infoHash) {
        cb(new Error('disallowed info_hash (Alice)'))
      } else {
        cb(null)
      }
    })
  }

  common.createServer(t, opts, (server, announceUrl) => {
    const client1 = new Client({
      infoHash: fixtures.alice.parsedTorrent.infoHash,
      announce: announceUrl,
      peerId,
      port: 6881,
      wrtc: {}
    })

    client1.on('error', err => { t.error(err) })
    if (serverType === 'ws') common.mockWebsocketTracker(client1)

    client1.once('warning', err => {
      t.ok(err.message.includes('disallowed info_hash (Alice)'), 'got client warning')

      client1.destroy(() => {
        t.pass('client1 destroyed')

        const client2 = new Client({
          infoHash: fixtures.leaves.parsedTorrent.infoHash,
          announce: announceUrl,
          peerId,
          port: 6881,
          wrtc: {}
        })
        if (serverType === 'ws') common.mockWebsocketTracker(client2)

        client2.on('error', err => { t.error(err) })
        client2.on('warning', err => { t.error(err) })

        client2.on('update', () => {
          t.pass('got announce')
          client2.destroy(() => { t.pass('client2 destroyed') })
          server.close(() => { t.pass('server closed') })
        })

        server.on('start', () => {
          t.equal(Object.keys(server.torrents).length, 1)
        })

        client2.start()
      })
    })

    server.removeAllListeners('warning')
    server.once('warning', err => {
      t.ok(err.message.includes('disallowed info_hash (Alice)'), 'got server warning')
      t.equal(Object.keys(server.torrents).length, 0)
    })

    client1.start()
  })
}

test('http: filter option blocks tracker from tracking torrent', t => {
  testFilterOption(t, 'http')
})

test('udp: filter option blocks tracker from tracking torrent', t => {
  testFilterOption(t, 'udp')
})

test('ws: filter option blocks tracker from tracking torrent', t => {
  testFilterOption(t, 'ws')
})

function testFilterCustomError (t, serverType) {
  t.plan(8)

  const opts = { serverType } // this is test-suite-only option
  opts.filter = (infoHash, params, cb) => {
    process.nextTick(() => {
      if (infoHash === fixtures.alice.parsedTorrent.infoHash) {
        cb(new Error('alice blocked'))
      } else {
        cb(null)
      }
    })
  }

  common.createServer(t, opts, (server, announceUrl) => {
    const client1 = new Client({
      infoHash: fixtures.alice.parsedTorrent.infoHash,
      announce: announceUrl,
      peerId,
      port: 6881,
      wrtc: {}
    })

    client1.on('error', err => { t.error(err) })
    if (serverType === 'ws') common.mockWebsocketTracker(client1)

    client1.once('warning', err => {
      t.ok(/alice blocked/.test(err.message), 'got client warning')

      client1.destroy(() => {
        t.pass('client1 destroyed')
        const client2 = new Client({
          infoHash: fixtures.leaves.parsedTorrent.infoHash,
          announce: announceUrl,
          peerId,
          port: 6881,
          wrtc: {}
        })
        if (serverType === 'ws') common.mockWebsocketTracker(client2)

        client2.on('error', err => { t.error(err) })
        client2.on('warning', err => { t.error(err) })

        client2.on('update', () => {
          t.pass('got announce')
          client2.destroy(() => { t.pass('client2 destroyed') })
          server.close(() => { t.pass('server closed') })
        })

        server.on('start', () => {
          t.equal(Object.keys(server.torrents).length, 1)
        })

        client2.start()
      })
    })

    server.removeAllListeners('warning')
    server.once('warning', err => {
      t.ok(/alice blocked/.test(err.message), 'got server warning')
      t.equal(Object.keys(server.torrents).length, 0)
    })

    client1.start()
  })
}

test('http: filter option with custom error', t => {
  testFilterCustomError(t, 'http')
})

test('udp: filter option filter option with custom error', t => {
  testFilterCustomError(t, 'udp')
})

test('ws: filter option filter option with custom error', t => {
  testFilterCustomError(t, 'ws')
})
