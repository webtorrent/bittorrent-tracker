import { Server } from '../index.js'

export const createServer = (t, opts, cb) => {
  if (typeof opts === 'string') opts = { serverType: opts }

  opts.http = (opts.serverType === 'http')
  opts.udp = (opts.serverType === 'udp')
  opts.ws = (opts.serverType === 'ws')

  const server = new Server(opts)

  server.on('error', err => { t.error(err) })
  server.on('warning', err => { t.error(err) })

  server.listen(0, () => {
    const port = server[opts.serverType].address().port
    let announceUrl
    if (opts.serverType === 'http') {
      announceUrl = `http://127.0.0.1:${port}/announce`
    } else if (opts.serverType === 'udp') {
      announceUrl = `udp://127.0.0.1:${port}`
    } else if (opts.serverType === 'ws') {
      announceUrl = `ws://127.0.0.1:${port}`
    }

    cb(server, announceUrl)
  })
}

export const mockWebsocketTracker = client => {
  client._trackers[0]._generateOffers = (numwant, cb) => {
    const offers = []
    for (let i = 0; i < numwant; i++) {
      offers.push({ fake_offer: `fake_offer_${i}` })
    }
    process.nextTick(() => {
      cb(offers)
    })
  }
}

export default { mockWebsocketTracker, createServer }
