import makeWASocket, {
  DisconnectReason,
  fetchLatestBaileysVersion,
  useMultiFileAuthState,
} from '@whiskeysockets/baileys'
import fs from 'node:fs/promises'
import qrcode from 'qrcode-terminal'
import QRCode from 'qrcode'
import pino from 'pino'
import { Boom } from '@hapi/boom'
import { config } from './config.js'

const logger = pino({ level: 'silent' })

const PROCESSED_MESSAGE_TTL_MS = 10 * 60 * 1000
const PROCESSED_MESSAGE_MAX = 500

export class WhatsappClient {
  constructor({ onMessage, testMode = false }) {
    this.onMessage = onMessage
    this.sock = null
    this.connected = false
    this.processedMessageIds = new Map()
    this.testMode = testMode
  }

  // Simula un mensaje entrante del cliente sin pasar por WhatsApp/Baileys - para el chat de
  // prueba local (scripts/test-chat.js). Nunca se usa en produccion.
  async simulateIncomingMessage(chatId, text) {
    await this.onMessage({ chatId, text })
  }

  hasAlreadyProcessed(messageId) {
    if (!messageId) return false
    const now = Date.now()
    for (const [id, seenAt] of this.processedMessageIds) {
      if (now - seenAt > PROCESSED_MESSAGE_TTL_MS) this.processedMessageIds.delete(id)
    }
    if (this.processedMessageIds.has(messageId)) return true
    this.processedMessageIds.set(messageId, now)
    if (this.processedMessageIds.size > PROCESSED_MESSAGE_MAX) {
      const oldestKey = this.processedMessageIds.keys().next().value
      this.processedMessageIds.delete(oldestKey)
    }
    return false
  }

  async start() {
    const { state, saveCreds } = await useMultiFileAuthState(config.authDir)
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
    if (this.testMode) {
      console.log(`\n🤖 ${text}\n`)
      return { key: { id: 'test-' + Date.now() } }
    }
    if (!this.sock) throw new Error('WhatsApp no esta iniciado.')
    await this.sock.sendPresenceUpdate('composing', chatId).catch(() => undefined)
    await sleep(getTypingDelay(text))
    await this.sock.sendPresenceUpdate('paused', chatId).catch(() => undefined)
    return await this.sock.sendMessage(chatId, { text })
  }

  async startTyping(chatId) {
    if (this.testMode) return
    if (!this.sock) return
    await this.sock.sendPresenceUpdate('composing', chatId).catch(() => undefined)
  }

  async sendImage(chatId, imagePath, caption) {
    if (this.testMode) {
      console.log(`\n🤖 [IMAGEN: ${imagePath}]\n${caption}\n`)
      return { key: { id: 'test-' + Date.now() } }
    }
    if (!this.sock) throw new Error('WhatsApp no esta iniciado.')
    await this.sock.sendPresenceUpdate('composing', chatId).catch(() => undefined)
    await sleep(2800)
    await this.sock.sendPresenceUpdate('paused', chatId).catch(() => undefined)
    let imagePayload
    try {
      imagePayload = await fs.readFile(imagePath)
    } catch (e) {
      console.error('Error leyendo archivo de imagen:', e)
      imagePayload = { url: imagePath }
    }
    return await this.sock.sendMessage(chatId, {
      image: imagePayload,
      caption,
    })
  }

  async sendLocation(chatId, { latitude, longitude, name, address }) {
    if (this.testMode) {
      console.log(`\n🤖 [UBICACION] ${name || ''} ${address || ''} (${latitude}, ${longitude})\n`)
      return { key: { id: 'test-' + Date.now() } }
    }
    if (!this.sock) throw new Error('WhatsApp no esta iniciado.')
    await this.sock.sendPresenceUpdate('composing', chatId).catch(() => undefined)
    await sleep(2800)
    await this.sock.sendPresenceUpdate('paused', chatId).catch(() => undefined)
    return await this.sock.sendMessage(chatId, {
      location: {
        degreesLatitude: latitude,
        degreesLongitude: longitude,
        name,
        address,
      },
    })
  }

  async findGroupIdBySubject(subject) {
    if (!this.sock || !subject) return ''
    const groups = await this.sock.groupFetchAllParticipating().catch(() => ({}))
    const normalizedTarget = normalizeText(subject)
    const group = Object.values(groups).find((item) => normalizeText(item?.subject) === normalizedTarget)
    return group?.id || ''
  }

  async listGroups() {
    if (!this.sock) return []
    const groups = await this.sock.groupFetchAllParticipating().catch(() => ({}))
    return Object.values(groups)
      .map((group) => ({
        id: group.id,
        name: group.subject,
        participants: Array.isArray(group.participants) ? group.participants.length : 0,
      }))
      .sort((left, right) => normalizeText(left.name).localeCompare(normalizeText(right.name)))
  }

  async logout() {
    if (!this.sock) return
    await this.sock.logout().catch(() => undefined)
    this.connected = false
  }

  async handleMessages(event) {
    if (event.type !== 'notify') return

    for (const message of event.messages) {
      if (message.key.fromMe) continue
      if (this.hasAlreadyProcessed(message.key.id)) continue
      let chatId = message.key.remoteJidAlt || (message.key.remoteJid?.endsWith('@lid') ? message.key.participant : message.key.remoteJid) || message.key.remoteJid
      if (!chatId) continue
      if (chatId.endsWith('@g.us')) continue

      if (chatId.endsWith('@c.us')) {
        chatId = chatId.replace('@c.us', '@s.whatsapp.net')
      }

      const text = extractText(message)
      if (!text) continue

      console.log(`Mensaje de ${chatId}: "${text.slice(0, 80)}" -> procesando...`)
      try {
        await this.onMessage({ chatId, text, raw: message })
        console.log(`Mensaje de ${chatId} procesado sin lanzar error.`)
      } catch (error) {
        console.error(`Error no capturado procesando mensaje de ${chatId}:`, error)
      }
    }
  }

  handleConnection(update) {
    const { connection, lastDisconnect, qr } = update

    if (qr) {
      console.log('Escanea este QR con WhatsApp:')
      qrcode.generate(qr, { small: true })
      QRCode.toFile(config.qrPath, qr, { width: 720, margin: 2 })
        .then(() => console.log(`QR guardado en ${config.qrPath}`))
        .catch((error) => console.error('No se pudo guardar el QR:', error))
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
  let msg = message.message
  if (!msg) return ''

  if (msg.ephemeralMessage) msg = msg.ephemeralMessage.message || msg
  if (msg.viewOnceMessage) msg = msg.viewOnceMessage.message || msg
  if (msg.viewOnceMessageV2) msg = msg.viewOnceMessageV2.message || msg

  if (msg.imageMessage) {
    const caption = msg.imageMessage.caption || ''
    return caption.trim() || '[imagen_recibida]'
  }

  const doc = msg.documentMessage || msg.documentWithCaptionMessage?.message?.documentMessage
  if (doc) {
    const caption = doc.caption || ''
    return caption.trim() || '[comprobante_recibido]'
  }

  const location = msg.locationMessage
  if (location) {
    const latitude = location.degreesLatitude
    const longitude = location.degreesLongitude
    const name = location.name ? ` (${location.name})` : ''
    return `Ubicacion de WhatsApp${name}: https://maps.google.com/?q=${latitude},${longitude}`
  }

  return (
    msg.conversation ||
    msg.extendedTextMessage?.text ||
    msg.imageMessage?.caption ||
    msg.documentMessage?.caption ||
    msg.documentWithCaptionMessage?.message?.documentMessage?.caption ||
    ''
  ).trim()
}

function normalizeText(text) {
  return String(text || '')
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .trim()
    .toLowerCase()
}

function getTypingDelay(text) {
  const str = String(text || '')
  const base = 2500
  const perChar = Math.min(str.length * 6, 700)
  return base + perChar
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
