// Chat de prueba local del bot, sin pasar por WhatsApp.
// Uso: npm run test-chat
//
// Usa el mismo codigo real (catalogo de Firestore, prompt de la IA, toda la logica de
// pedidos) - solo que las respuestas se imprimen en la terminal en vez de mandarse por
// WhatsApp, y no hace falta esperar el delay de tipeo.
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import readline from 'node:readline'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

process.env.BOT_TEST_MODE = '1'
// Aislado de los datos reales del bot (auth_info, conversation-state.json, bot-settings.json)
// para no pisar nada de la sesion de WhatsApp real ni de pruebas anteriores.
process.env.DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', '.test-data')

const indexUrl = pathToFileURL(path.join(__dirname, '..', 'src', 'index.js'))
const { handleIncomingMessage } = await import(indexUrl)

const chatId = process.argv[2] ? `${process.argv[2]}@s.whatsapp.net` : 'test-cliente@s.whatsapp.net'

console.log('=== Chat de prueba del bot (sin WhatsApp real) ===')
console.log(`Simulando cliente: ${chatId}`)
console.log('Escribi como si fueras el cliente. Comandos: ".reset" reinicia la conversacion de prueba, Ctrl+C sale.\n')

const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: 'cliente> ' })
rl.prompt()

// Procesamos los mensajes en cola, uno a la vez: si el input viene por pipe (varias lineas de
// golpe), los 'line' events llegan todos casi al instante, pero cada uno dispara una llamada
// async (a veces a la IA real) que puede tardar - sin esta cola, el evento 'close' del stream
// podia dispararse y cerrar el proceso antes de terminar de procesar todo.
let queue = Promise.resolve()
let closed = false

rl.on('line', (line) => {
  const text = line.trim()
  queue = queue.then(async () => {
    if (!text) {
      rl.prompt()
      return
    }
    if (text === '.reset') {
      await handleIncomingMessage({ chatId, text: 'nuevo pedido' })
      console.log('(conversacion de prueba reiniciada)\n')
      rl.prompt()
      return
    }
    try {
      await handleIncomingMessage({ chatId, text })
    } catch (error) {
      console.error('Error procesando el mensaje de prueba:', error)
    }
    if (!closed) rl.prompt()
  })
})

rl.on('close', () => {
  closed = true
  queue.then(() => {
    console.log('\nChat de prueba finalizado.')
    process.exit(0)
  })
})
