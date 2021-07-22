const Client = require('../')
const common = require('./common')
const fixtures = require('webtorrent-fixtures')
const test = require('tape')
const Server = require('../server')

const peerId = Buffer.from('01234567890123456789')

function testRequestHandler (t, serverType) {
  t.plan(5)

  const opts = { serverType } // this is test-suite-only option

  class Swarm extends Server.Swarm {
    announce (params, cb) {
      super.announce(params, (err, response) => {
        if (cb && err) return cb(response)
        response.complete = 246
        response.extraData = 'hi'
        if (cb) cb(null, response)
      })
    }
  }

  // Use a custom Swarm implementation for this test only
  const OldSwarm = Server.Swarm
  Server.Swarm = Swarm
  t.on('end', () => {
    Server.Swarm = OldSwarm
  })

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

    server.once('start', () => {
      t.pass('got start message from client1')
    })

    client1.once('update', data => {
      t.equal(data.complete, 246)
      t.equal(data.extraData.toString(), 'hi')

      client1.destroy(() => {
        t.pass('client1 destroyed')
      })

      server.close(() => {
        t.pass('server destroyed')
      })
    })

    client1.start()
  })
}

test('http: request handler option intercepts announce requests and responses', t => {
  testRequestHandler(t, 'http')
})

test('ws: request handler option intercepts announce requests and responses', t => {
  testRequestHandler(t, 'ws')
})

// NOTE: it's not possible to include extra data in a UDP response, because it's compact and accepts only params that are in the spec!
