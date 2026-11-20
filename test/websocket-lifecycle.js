import Client from '../index.js'
import common from './common.js'
import fixtures from 'webtorrent-fixtures'
import test from 'tape'

const peerId = Buffer.from('01234567890123456789')
const port = 6881

function holdReconnectTimer () {
  const setTimeout = global.setTimeout
  const clearTimeout = global.clearTimeout
  let reconnectTimer = null

  global.setTimeout = (fn, ms, ...args) => {
    if (ms >= 10 * 1000) {
      reconnectTimer = {
        args,
        callback: fn,
        cleared: false,
        unref () { return this }
      }
      return reconnectTimer
    }
    return setTimeout(fn, ms, ...args)
  }

  global.clearTimeout = timer => {
    if (reconnectTimer && timer === reconnectTimer) timer.cleared = true
    return clearTimeout(timer)
  }

  return {
    get reconnectTimer () { return reconnectTimer },
    restore () {
      global.setTimeout = setTimeout
      global.clearTimeout = clearTimeout
    }
  }
}

function testTerminalDestroyCancelsReconnect (t, failure) {
  t.plan(5)

  common.createServer(t, 'ws', (server, announceUrl) => {
    const sockets = []
    let connections = 0
    server.ws.on('connection', socket => {
      connections += 1
      sockets.push(socket)
    })

    const client = new Client({
      infoHash: fixtures.leaves.parsedTorrent.infoHash,
      announce: announceUrl,
      peerId,
      port,
      wrtc: {}
    })
    const tracker = client._trackers[0]
    common.mockWebsocketTracker(client)

    client.once('update', () => {
      t.pass('received an update over the initial WebSocket')

      const clock = holdReconnectTimer()
      t.teardown(() => { clock.restore() })

      if (failure === 'close') {
        sockets[0].terminate()
      } else {
        tracker.socket.emit('error', new Error('forced WebSocket error'))
      }

      setTimeout(() => {
        const reconnectTimer = clock.reconnectTimer
        t.ok(reconnectTimer, `${failure} schedules a reconnect`)

        client.destroy()
        t.ok(reconnectTimer.cleared, 'terminal client.destroy() cancels the scheduled reconnect')

        clock.restore()

        // This is a deterministic event-loop simulation: a cancelled timeout does
        // not run, whereas an uncancelled reconnect opens a second real socket.
        if (!reconnectTimer.cleared) reconnectTimer.callback(...reconnectTimer.args)

        setTimeout(() => {
          t.equal(connections, 1, 'no WebSocket is opened after terminal destruction')
          if (!tracker.destroyed) tracker.destroy()
          sockets.forEach(socket => { socket.terminate() })
          server.close(() => { t.pass('server closed') })
        }, 50)
      }, 20)
    })

    client.start()
  })
}

test('ws: destroy cancels reconnect scheduled after a socket close', t => {
  testTerminalDestroyCancelsReconnect(t, 'close')
})

test('ws: destroy cancels reconnect scheduled after a socket error', t => {
  testTerminalDestroyCancelsReconnect(t, 'error')
})

test('ws: client.destroy() stops peer processing after a compound announce update', t => {
  t.plan(9)

  common.createServer(t, 'ws', (server, announceUrl) => {
    // Send a single tracker response containing both an update and an offer before
    // the built-in server processes the client's initial announce. This is a real
    // WebSocket data boundary, while keeping the response timing deterministic.
    server.ws.on('connection', socket => {
      socket.prependOnceListener('message', message => {
        const request = JSON.parse(message)
        t.equal(request.action, 'announce', 'server received the initial announce')
        socket.send(JSON.stringify({
          action: 'announce',
          complete: 1,
          info_hash: request.info_hash,
          offer: { type: 'offer', sdp: 'synthetic offer' },
          offer_id: 'offer-id-00000000001',
          peer_id: 'remote-peer-id-00001'
        }))
      })
    })

    const client = new Client({
      infoHash: fixtures.leaves.parsedTorrent.infoHash,
      announce: announceUrl,
      peerId,
      port,
      wrtc: {}
    })
    const tracker = client._trackers[0]
    let peerCreations = 0
    let peerSignals = 0
    let emittedPeers = 0

    // The fake peer makes an unintended call observable without requiring a
    // WebRTC implementation. It must never be reached after client.destroy().
    tracker._createPeer = () => {
      peerCreations += 1
      return {
        once () {},
        signal () { peerSignals += 1 }
      }
    }
    client.on('peer', () => { emittedPeers += 1 })
    common.mockWebsocketTracker(client)

    client.once('update', response => {
      t.equal(response.complete, 1, 'received the compound response update')
      t.ok(response.offer, 'the update response also contains an offer')
      t.doesNotThrow(
        () => { client.destroy() },
        'destroying from the synchronous update listener does not throw'
      )

      setImmediate(() => {
        t.equal(peerCreations, 0, 'does not create a peer after synchronous destruction')
        t.equal(peerSignals, 0, 'does not signal a peer after synchronous destruction')
        t.equal(emittedPeers, 0, 'does not emit a peer after synchronous destruction')
        t.ok(client.destroyed, 'client remains terminally destroyed after the listener returns')
        server.close(() => { t.pass('server closed') })
      })
    })

    client.start()
  })
})
