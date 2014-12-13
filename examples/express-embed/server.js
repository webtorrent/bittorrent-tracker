#!/usr/bin/env node

var Server = require('../..').Server
var express = require('express')
var app = express()

var server = new Server({
  http: false, // we do our own
  udp: false   // not interested
})

var onHttpRequest = server.onHttpRequest.bind(server)
app.get('/announce', onHttpRequest)
app.get('/scrape', onHttpRequest)

app.listen(8080)
