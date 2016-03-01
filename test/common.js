var Server = require('../').Server

exports.createServer = function (t, serverType, cb) {
  var server = new Server({
    http: serverType === 'http',
    udp: serverType === 'udp',
    ws: serverType === 'ws'
  })

  server.on('error', function (err) { t.error(err) })
  server.on('warning', function (err) { t.error(err) })

  server.listen(0, function () {
    var port = server[serverType].address().port
    var announceUrl
    if (serverType === 'http') {
      announceUrl = 'http://127.0.0.1:' + port + '/announce'
    } else if (serverType === 'udp') {
      announceUrl = 'udp://127.0.0.1:' + port
    } else if (serverType === 'ws') {
      announceUrl = 'ws://127.0.0.1:' + port
    }

    cb(server, announceUrl)
  })
}

exports.mockWebsocketTracker = function (client) {
  client._trackers[0]._generateOffers = function (numwant, cb) {
    var offers = []
    for (var i = 0; i < numwant; i++) {
      offers.push({ fake_offer: 'fake_offer_' + i })
    }
    process.nextTick(function () {
      cb(offers)
    })
  }
}
