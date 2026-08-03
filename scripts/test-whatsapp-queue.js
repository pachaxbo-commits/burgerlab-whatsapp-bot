import assert from 'node:assert/strict'
import { PerChatMessageQueue } from '../src/whatsapp.js'

const queue = new PerChatMessageQueue()
const events = []

const first = queue.run('cliente-1', async () => {
  events.push('inicio-1')
  await new Promise((resolve) => setTimeout(resolve, 25))
  events.push('fin-1')
})

const second = queue.run('cliente-1', async () => {
  events.push('inicio-2')
  events.push('fin-2')
})

await Promise.all([first, second])

assert.deepEqual(events, ['inicio-1', 'fin-1', 'inicio-2', 'fin-2'])
assert.equal(queue.tails.size, 0)

console.log('Los mensajes de un mismo cliente se procesan en orden y sin solaparse.')
