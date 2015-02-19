#!/usr/bin/env node

var Server = require('../..').Server
var express = require('express')
var app = express()

// https://wiki.theory.org/BitTorrentSpecification#peer_id
var whitelist = {
  UT: true // uTorrent
}

var server = new Server({
  http: false, // we do our own
  udp: false,  // not interested
  filter: function (params) {
    // black/whitelist for disallowing/allowing specific clients [default=allow all]
    // this example only allows the uTorrent client
    var client = params.peer_id[1] + params.peer_id[2]
    return whitelist[client]
  }
})

var onHttpRequest = server.onHttpRequest.bind(server)
app.get('/announce', onHttpRequest)
app.get('/scrape', onHttpRequest)

app.listen(8080)
