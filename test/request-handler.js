var Buffer = require('safe-buffer').Buffer
var Client = require('../')
var common = require('./common')
var fixtures = require('webtorrent-fixtures')
var test = require('tape')

var peerId = Buffer.from('01234567890123456789')

function testRequestHandler (t, serverType) {
  t.plan(4)

  var opts = { serverType: serverType } // this is test-suite-only option
  opts.requestHandler = {
    getParams: function (params) {
      params.extra = 123
      return params
    },
    getResponse: function (params, cb) {
      return function (err, response) {
        response.complete = params.extra * 2
        cb(err, response)
      }
    }
  }

  common.createServer(t, opts, function (server, announceUrl) {
    var client1 = new Client({
      infoHash: fixtures.alice.parsedTorrent.infoHash,
      announce: announceUrl,
      peerId: peerId,
      port: 6881,
      wrtc: {}
    })

    client1.on('error', function (err) { t.error(err) })
    if (serverType === 'ws') common.mockWebsocketTracker(client1)

    server.once('start', function () {
      t.pass('got start message from client1')
    })

    client1.once('update', function (data) {
      t.equal(data.complete, 246)

      client1.destroy(function () {
        t.pass('client1 destroyed')
      })

      server.close(function () {
        t.pass('server destroyed')
      })
    })

    client1.start()
  })
}

test('http: request handler option intercepts announce requests and responses', function (t) {
  testRequestHandler(t, 'http')
})

test('udp: request handler option intercepts announce requests and responses', function (t) {
  testRequestHandler(t, 'udp')
})

test('ws: request handler option intercepts announce requests and responses', function (t) {
  testRequestHandler(t, 'ws')
})
