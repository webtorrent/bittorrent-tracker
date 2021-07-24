const Client = require('../')
const commonTest = require('./common')
const fixtures = require('webtorrent-fixtures')
const get = require('simple-get')
const test = require('tape')

const peerId = Buffer.from('-WW0091-4ea5886ce160')
const unknownPeerId = Buffer.from('01234567890123456789')

function parseHtml (html) {
  const extractValue = /[^v^h](\d+)/
  const array = html.replace('torrents', '\n').split('\n').filter(line => line && line.trim().length > 0).map(line => {
    const a = extractValue.exec(line)
    if (a) {
      return parseInt(a[1])
    }
    return null
  })
  let i = 0
  return {
    torrents: array[i++],
    activeTorrents: array[i++],
    peersAll: array[i++],
    peersSeederOnly: array[i++],
    peersLeecherOnly: array[i++],
    peersSeederAndLeecher: array[i++],
    peersIPv4: array[i++],
    peersIPv6: array[i]
  }
}

test('server: get empty stats', t => {
  t.plan(11)

  commonTest.createServer(t, 'http', (server, announceUrl) => {
    const url = announceUrl.replace('/announce', '/stats')

    get.concat(url, (err, res, data) => {
      t.error(err)

      const stats = parseHtml(data.toString())
      t.equal(res.statusCode, 200)
      t.equal(stats.torrents, 0)
      t.equal(stats.activeTorrents, 0)
      t.equal(stats.peersAll, 0)
      t.equal(stats.peersSeederOnly, 0)
      t.equal(stats.peersLeecherOnly, 0)
      t.equal(stats.peersSeederAndLeecher, 0)
      t.equal(stats.peersIPv4, 0)
      t.equal(stats.peersIPv6, 0)

      server.close(() => { t.pass('server closed') })
    })
  })
})

test('server: get empty stats with json header', t => {
  t.plan(11)

  commonTest.createServer(t, 'http', (server, announceUrl) => {
    const opts = {
      url: announceUrl.replace('/announce', '/stats'),
      headers: {
        accept: 'application/json'
      },
      json: true
    }

    get.concat(opts, (err, res, stats) => {
      t.error(err)

      t.equal(res.statusCode, 200)
      t.equal(stats.torrents, 0)
      t.equal(stats.activeTorrents, 0)
      t.equal(stats.peersAll, 0)
      t.equal(stats.peersSeederOnly, 0)
      t.equal(stats.peersLeecherOnly, 0)
      t.equal(stats.peersSeederAndLeecher, 0)
      t.equal(stats.peersIPv4, 0)
      t.equal(stats.peersIPv6, 0)

      server.close(() => { t.pass('server closed') })
    })
  })
})

test('server: get empty stats on stats.json', t => {
  t.plan(11)

  commonTest.createServer(t, 'http', (server, announceUrl) => {
    const opts = {
      url: announceUrl.replace('/announce', '/stats.json'),
      json: true
    }

    get.concat(opts, (err, res, stats) => {
      t.error(err)

      t.equal(res.statusCode, 200)
      t.equal(stats.torrents, 0)
      t.equal(stats.activeTorrents, 0)
      t.equal(stats.peersAll, 0)
      t.equal(stats.peersSeederOnly, 0)
      t.equal(stats.peersLeecherOnly, 0)
      t.equal(stats.peersSeederAndLeecher, 0)
      t.equal(stats.peersIPv4, 0)
      t.equal(stats.peersIPv6, 0)

      server.close(() => { t.pass('server closed') })
    })
  })
})

test('server: get leecher stats.json', t => {
  t.plan(11)

  commonTest.createServer(t, 'http', (server, announceUrl) => {
    // announce a torrent to the tracker
    const client = new Client({
      infoHash: fixtures.leaves.parsedTorrent.infoHash,
      announce: announceUrl,
      peerId,
      port: 6881
    })
    client.on('error', err => { t.error(err) })
    client.on('warning', err => { t.error(err) })

    client.start()

    server.once('start', () => {
      const opts = {
        url: announceUrl.replace('/announce', '/stats.json'),
        json: true
      }

      get.concat(opts, (err, res, stats) => {
        t.error(err)

        t.equal(res.statusCode, 200)
        t.equal(stats.torrents, 1)
        t.equal(stats.activeTorrents, 1)
        t.equal(stats.peersAll, 1)
        t.equal(stats.peersSeederOnly, 0)
        t.equal(stats.peersLeecherOnly, 1)
        t.equal(stats.peersSeederAndLeecher, 0)
        t.equal(stats.clients.WebTorrent['0.91'], 1)

        client.destroy(() => { t.pass('client destroyed') })
        server.close(() => { t.pass('server closed') })
      })
    })
  })
})

test('server: get leecher stats.json (unknown peerId)', t => {
  t.plan(11)

  commonTest.createServer(t, 'http', (server, announceUrl) => {
    // announce a torrent to the tracker
    const client = new Client({
      infoHash: fixtures.leaves.parsedTorrent.infoHash,
      announce: announceUrl,
      peerId: unknownPeerId,
      port: 6881
    })
    client.on('error', err => { t.error(err) })
    client.on('warning', err => { t.error(err) })

    client.start()

    server.once('start', () => {
      const opts = {
        url: announceUrl.replace('/announce', '/stats.json'),
        json: true
      }

      get.concat(opts, (err, res, stats) => {
        t.error(err)

        t.equal(res.statusCode, 200)
        t.equal(stats.torrents, 1)
        t.equal(stats.activeTorrents, 1)
        t.equal(stats.peersAll, 1)
        t.equal(stats.peersSeederOnly, 0)
        t.equal(stats.peersLeecherOnly, 1)
        t.equal(stats.peersSeederAndLeecher, 0)
        t.equal(stats.clients.unknown['01234567'], 1)

        client.destroy(() => { t.pass('client destroyed') })
        server.close(() => { t.pass('server closed') })
      })
    })
  })
})
