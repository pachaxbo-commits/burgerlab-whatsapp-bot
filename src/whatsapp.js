import makeWASocket, {
  DisconnectReason,
  fetchLatestBaileysVersion,
  fetchLatestWaWebVersion,
  useMultiFileAuthState,
} from '@whiskeysockets/baileys'
import fs from 'node:fs/promises'
import qrcode from 'qrcode-terminal'
import QRCode from 'qrcode'
import pino from 'pino'
import { Boom } from '@hapi/boom'
import { config } from './config.js'

const logger = pino({ level: 'silent' })

const PROCESSED_MESSAGE_TTL_MS = 24 * 60 * 60 * 1000
const PROCESSED_MESSAGE_MAX = 5000
const MAX_INCOMING_MESSAGE_AGE_MS = 15 * 60 * 1000

export class PerChatMessageQueue {
  constructor() {
    this.tails = new Map()
  }

  async run(chatId, task) {
    const previous = this.tails.get(chatId) || Promise.resolve()
    const current = previous.catch(() => undefined).then(task)
    this.tails.set(chatId, current)

    try {
      return await current
    } finally {
      if (this.tails.get(chatId) === current) this.tails.delete(chatId)
    }
  }
}

export class WhatsappClient {
  constructor({ onMessage, testMode = false }) {
    this.onMessage = onMessage
    this.sock = null
    this.connected = false
    this.processedMessageIds = new Map()
    this.processedMessagesLoaded = false
    this.processedMessageSaveTimer = null
    this.chatMessageQueue = new PerChatMessageQueue()
    this.testMode = testMode
    this.consecutiveDisconnects = 0
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
    this.scheduleProcessedMessagesSave()
    return false
  }

  async loadProcessedMessageIds() {
    if (this.processedMessagesLoaded || this.testMode) return
    this.processedMessagesLoaded = true

    try {
      const raw = await fs.readFile(config.processedMessagesPath, 'utf8')
      const entries = JSON.parse(raw)
      const now = Date.now()
      this.processedMessageIds = new Map(
        (Array.isArray(entries) ? entries : [])
          .filter(([id, seenAt]) => id && Number.isFinite(Number(seenAt)) && now - Number(seenAt) <= PROCESSED_MESSAGE_TTL_MS)
          .slice(-PROCESSED_MESSAGE_MAX)
          .map(([id, seenAt]) => [String(id), Number(seenAt)]),
      )
    } catch {
      this.processedMessageIds = new Map()
    }
  }

  scheduleProcessedMessagesSave() {
    if (this.testMode) return
    if (this.processedMessageSaveTimer) clearTimeout(this.processedMessageSaveTimer)
    this.processedMessageSaveTimer = setTimeout(() => {
      this.processedMessageSaveTimer = null
      this.saveProcessedMessageIds().catch((error) => {
        console.error('No se pudo guardar la deduplicacion de mensajes:', error)
      })
    }, 150)
  }

  async saveProcessedMessageIds() {
    await fs.mkdir(config.dataDir, { recursive: true })
    await fs.writeFile(
      config.processedMessagesPath,
      `${JSON.stringify(Array.from(this.processedMessageIds.entries()))}\n`,
      'utf8',
    )
  }

  async start() {
    await this.loadProcessedMessageIds()
    const { state, saveCreds } = await useMultiFileAuthState(config.authDir)
    const version = await resolveWaWebVersion()

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
    const degreesLatitude = Number(latitude)
    const degreesLongitude = Number(longitude)
    if (!Number.isFinite(degreesLatitude) || !Number.isFinite(degreesLongitude)) {
      throw new Error('La ubicacion del restaurante no tiene coordenadas validas.')
    }
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
        degreesLatitude,
        degreesLongitude,
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
      if (isStaleIncomingMessage(message)) {
        console.log(`Mensaje antiguo ignorado al reconectar WhatsApp (${message.key.id || 'sin id'}).`)
        continue
      }
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
        await this.chatMessageQueue.run(chatId, () => this.onMessage({ chatId, text, raw: message }))
        console.log(`Mensaje de ${chatId} procesado sin lanzar error.`)
      } catch (error) {
        console.error(`Error no capturado procesando mensaje de ${chatId}:`, error)
      }
    }
  }

  handleConnection(update) {
    const { connection, lastDisconnect, qr } = update

    if (qr) {
      // Baileys esta pidiendo un QR nuevo de verdad (no tiene o descarto la sesion guardada) -
      // esto es la señal de que ya no esta atascado reintentando con credenciales rotas.
      this.consecutiveDisconnects = 0
      console.log('Escanea este QR con WhatsApp:')
      qrcode.generate(qr, { small: true })
      QRCode.toFile(config.qrPath, qr, { width: 720, margin: 2 })
        .then(() => console.log(`QR guardado en ${config.qrPath}`))
        .catch((error) => console.error('No se pudo guardar el QR:', error))
    }

    if (connection === 'open') {
      this.connected = true
      this.consecutiveDisconnects = 0
      console.log('WhatsApp conectado.')
    }

    if (connection === 'close') {
      this.connected = false
      const statusCode = new Boom(lastDisconnect?.error)?.output?.statusCode
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut
      this.consecutiveDisconnects += 1
      console.log(`WhatsApp desconectado (codigo ${statusCode ?? 'desconocido'}). Reconectar: ${shouldReconnect}. Intentos seguidos sin conectar: ${this.consecutiveDisconnects}`)

      if (!shouldReconnect) return

      // Si se desconecta muchas veces seguidas sin nunca llegar a "conectado" ni pedir un QR
      // nuevo, la sesion guardada (auth_info) probablemente quedo invalidada del lado de
      // WhatsApp (ej. por muchos reinicios seguidos durante despliegues). Seguir reintentando
      // con esas mismas credenciales rotas cada pocos segundos, sin parar, no arregla nada y
      // satura los servidores de WhatsApp - mala señal para la cuenta, ademas de que nunca vas a
      // poder ver un QR nuevo porque Baileys sigue intentando "reanudar" la sesion vieja en vez
      // de pedir una nueva. Despues de varios intentos seguidos, borramos la sesion guardada y
      // arrancamos de cero para forzar un QR nuevo, sin necesitar entrar manualmente a "Cerrar
      // sesion".
      const MAX_CONSECUTIVE_DISCONNECTS = 8
      if (this.consecutiveDisconnects >= MAX_CONSECUTIVE_DISCONNECTS) {
        console.log(`Demasiadas desconexiones seguidas (${this.consecutiveDisconnects}). Borrando la sesion guardada y reiniciando para pedir un QR nuevo.`)
        this.consecutiveDisconnects = 0
        fs.rm(config.authDir, { recursive: true, force: true })
          .catch(() => undefined)
          .finally(() => {
            setTimeout(() => void this.start(), 2000)
          })
        return
      }

      const delay = Math.min(2000 * 2 ** (this.consecutiveDisconnects - 1), 60000)
      setTimeout(() => void this.start(), delay)
    }
  }
}

export function isStaleIncomingMessage(message, now = Date.now()) {
  const rawTimestamp = message?.messageTimestamp
  let timestamp = 0

  if (typeof rawTimestamp === 'number' || typeof rawTimestamp === 'bigint') {
    timestamp = Number(rawTimestamp)
  } else if (typeof rawTimestamp?.toNumber === 'function') {
    timestamp = rawTimestamp.toNumber()
  } else if (rawTimestamp !== undefined && rawTimestamp !== null) {
    timestamp = Number(rawTimestamp)
  }

  if (!Number.isFinite(timestamp) || timestamp <= 0) return false
  const timestampMs = timestamp > 1_000_000_000_000 ? timestamp : timestamp * 1000
  return now - timestampMs > MAX_INCOMING_MESSAGE_AGE_MS
}

// WhatsApp rechaza el handshake con error 405 ("Connection Failure") si la version de
// protocolo que le mandamos quedo vieja, y eso pasa antes de siquiera generar el QR.
// Ojo con fetchLatestBaileysVersion(): lee la version del repositorio de Baileys, que
// suele estar atrasado, y devuelve isLatest:true igual - o sea, miente. Comprobado a mano:
// la que da esa funcion (2.3000.1035194821) daba 405, y la de fetchLatestWaWebVersion
// (2.3000.1044015310), que la consulta directo a WhatsApp, conecto y dio QR.
// Por eso el orden: WhatsApp primero, Baileys como respaldo, y recien al final un numero fijo.
const FALLBACK_WA_WEB_VERSION = [2, 3000, 1044015310]

async function resolveWaWebVersion() {
  try {
    const { version, isLatest } = await fetchLatestWaWebVersion({})
    if (version && isLatest) return version
  } catch (error) {
    console.log('No se pudo consultar la version de WhatsApp Web:', error?.message || error)
  }

  try {
    const { version, isLatest } = await fetchLatestBaileysVersion()
    if (version && isLatest) {
      console.log(`Usando la version que reporta Baileys (${version.join('.')}). Si aparece error 405, esta desactualizada.`)
      return version
    }
  } catch (error) {
    console.log('No se pudo consultar la version desde Baileys:', error?.message || error)
  }

  console.log(`Usando version de respaldo fija ${FALLBACK_WA_WEB_VERSION.join('.')}.`)
  return FALLBACK_WA_WEB_VERSION
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
