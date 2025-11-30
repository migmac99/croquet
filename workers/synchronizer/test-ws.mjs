#!/usr/bin/env node
/**
 * Manual WebSocket test for the synchronizer
 * Usage: node test-ws.mjs [session-id]
 */

import WebSocket from 'ws'

const sessionId = process.argv[2] || 'test-session-' + Date.now()
const url = `ws://localhost:8787/clients/connect?session=${sessionId}`

console.log(`Connecting to: ${url}`)

const ws = new WebSocket(url)

ws.on('open', () => {
  console.log('WebSocket connected!')

  // Send JOIN message (Croquet protocol)
  const joinMsg = {
    action: 'JOIN',
    args: {
      user: 'test-user',
      name: 'Test Client',
      version: '1.0.0',
    },
  }

  console.log('Sending JOIN:', JSON.stringify(joinMsg))
  ws.send(JSON.stringify(joinMsg))
})

ws.on('message', (data) => {
  console.log('Received:', data.toString())
})

ws.on('close', (code, reason) => {
  console.log(`WebSocket closed: ${code} ${reason}`)
  process.exit(0)
})

ws.on('error', (err) => {
  console.error('WebSocket error:', err.message)
  process.exit(1)
})

// Keep alive for 10 seconds
setTimeout(() => {
  console.log('Test timeout, closing...')
  ws.close()
}, 10000)
