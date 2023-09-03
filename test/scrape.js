import bencode from 'bencode'
import Client from '../index.js'
import common from './common.js'
import commonLib from '../lib/common.js'
import fixtures from 'webtorrent-fixtures'
import fetch from 'cross-fetch-ponyfill'
import test from 'tape'
import { hex2bin } from 'uint8-util'

const peerId = Buffer.from('01234567890123456789')

function testSingle (t, serverType) {
  common.createServer(t, serverType, (server, announceUrl) => {
    const client = new Client({
      infoHash: fixtures.leaves.parsedTorrent.infoHash,
      announce: announceUrl,
      peerId,
      port: 6881,
      wrtc: {}
    })

    if (serverType === 'ws') common.mockWebsocketTracker(client)
    client.on('error', err => { t.error(err) })
    client.on('warning', err => { t.error(err) })

    client.scrape()

    client.on('scrape', data => {
      t.equal(data.announce, announceUrl)
      t.equal(data.infoHash, fixtures.leaves.parsedTorrent.infoHash)
      t.equal(typeof data.complete, 'number')
      t.equal(typeof data.incomplete, 'number')
      t.equal(typeof data.downloaded, 'number')
      client.destroy()
      server.close(() => {
        t.end()
      })
    })
  })
}

test('http: single info_hash scrape', t => {
  testSingle(t, 'http')
})

test('udp: single info_hash scrape', t => {
  testSingle(t, 'udp')
})

test('ws: single info_hash scrape', t => {
  testSingle(t, 'ws')
})

function clientScrapeStatic (t, serverType) {
  common.createServer(t, serverType, (server, announceUrl) => {
    const client = Client.scrape({
      announce: announceUrl,
      infoHash: fixtures.leaves.parsedTorrent.infoHash,
      wrtc: {}
    }, (err, data) => {
      t.error(err)
      t.equal(data.announce, announceUrl)
      t.equal(data.infoHash, fixtures.leaves.parsedTorrent.infoHash)
      t.equal(typeof data.complete, 'number')
      t.equal(typeof data.incomplete, 'number')
      t.equal(typeof data.downloaded, 'number')
      server.close(() => {
        t.end()
      })
    })
    if (serverType === 'ws') common.mockWebsocketTracker(client)
  })
}

test('http: scrape using Client.scrape static method', t => {
  clientScrapeStatic(t, 'http')
})

test('udp: scrape using Client.scrape static method', t => {
  clientScrapeStatic(t, 'udp')
})

test('ws: scrape using Client.scrape static method', t => {
  clientScrapeStatic(t, 'ws')
})

// Ensure the callback function gets called when an invalid url is passed
function clientScrapeStaticInvalid (t, serverType) {
  let announceUrl = `${serverType}://invalid.lol`
  if (serverType === 'http') announceUrl += '/announce'

  const client = Client.scrape({
    announce: announceUrl,
    infoHash: fixtures.leaves.parsedTorrent.infoHash,
    wrtc: {}
  }, (err, data) => {
    t.ok(err instanceof Error)
    t.end()
  })
  if (serverType === 'ws') common.mockWebsocketTracker(client)
}

test('http: scrape using Client.scrape static method (invalid url)', t => {
  clientScrapeStaticInvalid(t, 'http')
})

test('udp: scrape using Client.scrape static method (invalid url)', t => {
  clientScrapeStaticInvalid(t, 'udp')
})

test('ws: scrape using Client.scrape static method (invalid url)', t => {
  clientScrapeStaticInvalid(t, 'ws')
})

function clientScrapeMulti (t, serverType) {
  const infoHash1 = fixtures.leaves.parsedTorrent.infoHash
  const infoHash2 = fixtures.alice.parsedTorrent.infoHash

  common.createServer(t, serverType, (server, announceUrl) => {
    Client.scrape({
      infoHash: [infoHash1, infoHash2],
      announce: announceUrl
    }, (err, results) => {
      t.error(err)

      t.equal(results[infoHash1].announce, announceUrl)
      t.equal(results[infoHash1].infoHash, infoHash1)
      t.equal(typeof results[infoHash1].complete, 'number')
      t.equal(typeof results[infoHash1].incomplete, 'number')
      t.equal(typeof results[infoHash1].downloaded, 'number')

      t.equal(results[infoHash2].announce, announceUrl)
      t.equal(results[infoHash2].infoHash, infoHash2)
      t.equal(typeof results[infoHash2].complete, 'number')
      t.equal(typeof results[infoHash2].incomplete, 'number')
      t.equal(typeof results[infoHash2].downloaded, 'number')

      server.close(() => {
        t.end()
      })
    })
  })
}

test('http: MULTI scrape using Client.scrape static method', t => {
  clientScrapeMulti(t, 'http')
})

test('udp: MULTI scrape using Client.scrape static method', t => {
  clientScrapeMulti(t, 'udp')
})

test('server: multiple info_hash scrape (manual http request)', t => {
  t.plan(12)

  const binaryInfoHash1 = hex2bin(fixtures.leaves.parsedTorrent.infoHash)
  const binaryInfoHash2 = hex2bin(fixtures.alice.parsedTorrent.infoHash)

  common.createServer(t, 'http', async (server, announceUrl) => {
    const scrapeUrl = announceUrl.replace('/announce', '/scrape')

    const url = `${scrapeUrl}?${commonLib.querystringStringify({
  info_hash: [binaryInfoHash1, binaryInfoHash2]
})}`
    let res
    try {
      res = await fetch(url)
    } catch (err) {
      t.error(err)
    }
    let data = Buffer.from(await res.arrayBuffer())

    t.equal(res.status, 200)

    data = bencode.decode(data)
    t.ok(data.files)
    t.equal(Object.keys(data.files).length, 2)

    t.ok(data.files[binaryInfoHash1])
    t.equal(typeof data.files[binaryInfoHash1].complete, 'number')
    t.equal(typeof data.files[binaryInfoHash1].incomplete, 'number')
    t.equal(typeof data.files[binaryInfoHash1].downloaded, 'number')

    t.ok(data.files[binaryInfoHash2])
    t.equal(typeof data.files[binaryInfoHash2].complete, 'number')
    t.equal(typeof data.files[binaryInfoHash2].incomplete, 'number')
    t.equal(typeof data.files[binaryInfoHash2].downloaded, 'number')

    server.close(() => { t.pass('server closed') })
  })
})

test('server: all info_hash scrape (manual http request)', t => {
  t.plan(9)

  const binaryInfoHash = hex2bin(fixtures.leaves.parsedTorrent.infoHash)

  common.createServer(t, 'http', (server, announceUrl) => {
    const scrapeUrl = announceUrl.replace('/announce', '/scrape')

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

    server.once('start', async () => {
      // now do a scrape of everything by omitting the info_hash param
      let res
      try {
        res = await fetch(scrapeUrl)
      } catch (err) {
        t.error(err)
      }
      let data = Buffer.from(await res.arrayBuffer())

      t.equal(res.status, 200)
      data = bencode.decode(data)
      t.ok(data.files)
      t.equal(Object.keys(data.files).length, 1)

      t.ok(data.files[binaryInfoHash])
      t.equal(typeof data.files[binaryInfoHash].complete, 'number')
      t.equal(typeof data.files[binaryInfoHash].incomplete, 'number')
      t.equal(typeof data.files[binaryInfoHash].downloaded, 'number')

      client.destroy(() => { t.pass('client destroyed') })
      server.close(() => { t.pass('server closed') })
    })
  })
})
