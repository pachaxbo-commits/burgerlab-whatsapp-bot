import makeWASocket, {
  DisconnectReason,
  fetchLatestBaileysVersion,
  useMultiFileAuthState,
} from '@whiskeysockets/baileys'
import qrcode from 'qrcode-terminal'
import QRCode from 'qrcode'
import pino from 'pino'
import { Boom } from '@hapi/boom'

const logger = pino({ level: 'silent' })

export class WhatsappClient {
  constructor({ onMessage }) {
    this.onMessage = onMessage
    this.sock = null
    this.connected = false
  }

  async start() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info')
    const { version } = await fetchLatestBaileysVersion()

    this.sock = makeWASocket({
      version,
      auth: state,
      printQRInTerminal: false,
      logger,
      browser: ['Burger Lab Bot', 'Chrome', '1.0.0'],
    })

    this.sock.ev.on('creds.update', saveCreds)
    this.sock.ev.on('connection.update', (update) => this.handleConnection(update))
    this.sock.ev.on('messages.upsert', (event) => this.handleMessages(event))
  }

  async sendText(chatId, text) {
    if (!this.sock) throw new Error('WhatsApp no esta iniciado.')
    await this.sock.sendPresenceUpdate('composing', chatId)
    await sleep(getTypingDelay(text))
    await this.sock.sendPresenceUpdate('paused', chatId)
    await this.sock.sendMessage(chatId, { text })
  }

  async sendImage(chatId, imagePath, caption) {
    if (!this.sock) throw new Error('WhatsApp no esta iniciado.')
    await this.sock.sendPresenceUpdate('composing', chatId)
    await sleep(1800)
    await this.sock.sendPresenceUpdate('paused', chatId)
    await this.sock.sendMessage(chatId, {
      image: { url: imagePath },
      caption,
    })
  }

  async handleMessages(event) {
    if (event.type !== 'notify') return

    for (const message of event.messages) {
      if (message.key.fromMe) continue
      const chatId = message.key.remoteJid
      const text = extractText(message)
      if (!chatId || !text) continue
      if (chatId.endsWith('@g.us')) continue

      await this.onMessage({ chatId, text, raw: message })
    }
  }

  handleConnection(update) {
    const { connection, lastDisconnect, qr } = update

    if (qr) {
      console.log('Escanea este QR con WhatsApp:')
      qrcode.generate(qr, { small: true })
      QRCode.toFile('bot-qr.png', qr, { width: 720, margin: 2 })
        .then(() => console.log('QR guardado en bot-qr.png'))
        .catch((error) => console.error('No se pudo guardar bot-qr.png:', error))
    }

    if (connection === 'open') {
      this.connected = true
      console.log('WhatsApp conectado.')
    }

    if (connection === 'close') {
      this.connected = false
      const statusCode = new Boom(lastDisconnect?.error)?.output?.statusCode
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut
      console.log(`WhatsApp desconectado. Reconectar: ${shouldReconnect}`)
      if (shouldReconnect) {
        setTimeout(() => void this.start(), 2000)
      }
    }
  }
}

function extractText(message) {
  const location = message.message?.locationMessage
  if (location) {
    const latitude = location.degreesLatitude
    const longitude = location.degreesLongitude
    const name = location.name ? ` (${location.name})` : ''
    return `Ubicacion de WhatsApp${name}: https://maps.google.com/?q=${latitude},${longitude}`
  }

  return (
    message.message?.conversation ||
    message.message?.extendedTextMessage?.text ||
    message.message?.imageMessage?.caption ||
    ''
  ).trim()
}

function getTypingDelay(text) {
  const base = 1200
  const perChar = Math.min(text.length * 25, 4500)
  return base + perChar
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
