import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
process.env.BOT_TEST_MODE = '1'
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'test-key'
process.env.BOT_ADMIN_TOKEN = process.env.BOT_ADMIN_TOKEN || 'test-token'
process.env.DATA_DIR = path.join(__dirname, '..', '.test-data-manual')
await fs.rm(process.env.DATA_DIR, { recursive: true, force: true })

const indexUrl = pathToFileURL(path.join(__dirname, '..', 'src', 'index.js'))
const settingsUrl = pathToFileURL(path.join(__dirname, '..', 'src', 'settings.js'))
const { handleIncomingMessage, whatsapp } = await import(indexUrl)
const { updateSettings } = await import(settingsUrl)

await updateSettings({
  manualOrderEntryMode: true,
  autoRepliesEnabled: true,
  acceptingOrders: true,
  openHour: 0,
  closeHour: 24,
  pickupOnlyMode: false,
  ownerAlertChatId: '',
  ownerAlertGroupName: '',
})

const sent = []
whatsapp.sendText = async (chatId, text) => sent.push({ type: 'text', chatId, text })
whatsapp.sendImage = async (chatId, imagePath, caption) => sent.push({ type: 'image', chatId, imagePath, caption })
whatsapp.sendLocation = async (chatId, location) => sent.push({ type: 'location', chatId, location })
whatsapp.startTyping = async () => undefined

async function receive(phone, text) {
  await handleIncomingMessage({ chatId: `${phone}@s.whatsapp.net`, text, displayName: `Cliente ${phone}` })
}

await receive('59170000001', 'Quiero dos burger lab dobles con papas para delivery')
assert.equal(sent.length, 0, 'Un pedido directo debe quedar para registro manual y no recibir respuesta.')

await receive('59170000002', '[audio_recibido]')
assert.equal(sent.at(-1)?.type, 'text')
assert.match(sent.at(-1)?.text || '', /por escrito/i)

const beforeMenu = sent.length
await receive('59170000003', 'Quiero hacer un pedido')
assert.deepEqual(sent.slice(beforeMenu).map((entry) => entry.type), ['text', 'image'])
const beforeRepeatedMenu = sent.length
await receive('59170000003', 'Me mandas el menu otra vez')
assert.deepEqual(sent.slice(beforeRepeatedMenu).map((entry) => entry.type), ['image'])

const beforePricing = sent.length
await receive('59170000004', 'Cuanto cuesta el delivery?')
assert.deepEqual(sent.slice(beforePricing).map((entry) => entry.type), ['image', 'location'])

await receive('59170000005', 'Una bbq doble con papas para delivery')
const beforeDeliveryQr = sent.length
await receive('59170000005', 'Me puedes pasar el QR?')
assert.equal(sent.length, beforeDeliveryQr + 1)
assert.match(sent.at(-1)?.text || '', /directamente a la moto/i)

await receive('59170000006', 'Una burger lab para recojo')
const beforePickupQr = sent.length
await receive('59170000006', 'Me puedes pasar el QR?')
assert.equal(sent.length, beforePickupQr, 'El QR de recojo queda para atencion manual.')

const beforeUnknown = sent.length
await receive('59170000007', 'Pueden hacerme una factura especial con otros datos?')
assert.equal(sent.length, beforeUnknown, 'Una consulta fuera de la lista segura no debe responderse.')

console.log('Flujo manual: menu, audios, cotizacion, QR y silencios verificados.')
await fs.rm(process.env.DATA_DIR, { recursive: true, force: true })
