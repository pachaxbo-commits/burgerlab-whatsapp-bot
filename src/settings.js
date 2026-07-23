import fs from 'node:fs/promises'
import path from 'node:path'
import { config } from './config.js'

const settingsPath = config.settingsPath

export const defaultSettings = {
  acceptingOrders: true,
  acceptingOrdersPausedUntil: '',
  acceptingOrdersPauseReason: '',
  pickupOnlyMode: false,
  pickupOnlyMessage: 'Por el momento solo estamos trabajando pedidos para recojo en el restaurante. Si te parece bien, puedo registrar tu pedido para que pases a recogerlo.',
  autoRepliesEnabled: true,
  deliveryGroupName: config.deliveryGroupName,
  deliveryGroupId: config.deliveryGroupId,
  ownerAlertGroupName: config.ownerAlertGroupName,
  ownerAlertChatId: config.ownerAlertChatId,
  closedMessage: `Gracias por escribir a ${config.businessName}. Nuestro horario de pedidos por WhatsApp es de 5:00 pm a 11:00 pm. Te esperamos en ese horario para atenderte con gusto.`,
  pausedOrdersMessage: 'En este momento no estamos recibiendo pedidos por WhatsApp. Por favor intenta nuevamente mas tarde.',
  qrPaymentMessage: 'Cuando envies el comprobante por este chat, caja revisara el pago y te avisare el tiempo de salida.',
  deliveryPricingMessage: 'Te paso el tarifario de delivery y la ubicacion de Burger Lab para que puedas estimar el envio. El costo final puede variar por zona, clima, subida, ruta o disponibilidad del repartidor.',
  humanHelpMessage: 'Dame un momento, por favor. Voy a pedir apoyo para confirmarte eso correctamente.',
  personality: config.personality,
}

let currentSettings = { ...defaultSettings }

export async function loadSettings() {
  try {
    const raw = await fs.readFile(settingsPath, 'utf8')
    currentSettings = normalizeSettings(JSON.parse(raw))
  } catch {
    currentSettings = { ...defaultSettings }
    await saveSettings(currentSettings)
  }

  return currentSettings
}

export function getSettings() {
  return currentSettings
}

export async function updateSettings(patch) {
  currentSettings = normalizeSettings({
    ...currentSettings,
    ...pickAllowedSettings(patch),
  })
  await saveSettings(currentSettings)
  return currentSettings
}

async function saveSettings(settings) {
  await fs.mkdir(path.dirname(settingsPath), { recursive: true })
  await fs.writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, 'utf8')
}

function normalizeSettings(value) {
  return {
    ...defaultSettings,
    ...pickAllowedSettings(value || {}),
    acceptingOrders: value?.acceptingOrders !== false,
    acceptingOrdersPausedUntil: typeof value?.acceptingOrdersPausedUntil === 'string' ? value.acceptingOrdersPausedUntil : '',
    acceptingOrdersPauseReason: typeof value?.acceptingOrdersPauseReason === 'string' ? value.acceptingOrdersPauseReason : '',
    pickupOnlyMode: value?.pickupOnlyMode === true,
    pickupOnlyMessage: typeof value?.pickupOnlyMessage === 'string' ? value.pickupOnlyMessage : defaultSettings.pickupOnlyMessage,
    autoRepliesEnabled: value?.autoRepliesEnabled !== false,
  }
}

function pickAllowedSettings(value) {
  const allowed = {}
  for (const key of Object.keys(defaultSettings)) {
    if (Object.prototype.hasOwnProperty.call(value, key)) {
      allowed[key] = value[key]
    }
  }
  return allowed
}
