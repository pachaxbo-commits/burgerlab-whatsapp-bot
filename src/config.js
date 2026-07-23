import 'dotenv/config'

function readBoolean(value, fallback) {
  if (value === undefined) return fallback
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase())
}

export const config = {
  port: Number(process.env.PORT || 3010),
  openaiApiKey: process.env.OPENAI_API_KEY || '',
  openaiModel: process.env.OPENAI_MODEL || 'gpt-4.1-mini',
  geminiApiKey: process.env.GEMINI_API_KEY || '',
  geminiModel: process.env.GEMINI_MODEL || 'gemini-3.5-flash',
  firebaseProjectId: process.env.FIREBASE_PROJECT_ID || 'comandero-6907f',
  restaurantId: process.env.FIREBASE_RESTAURANT_ID || 'principal',
  botEnabled: readBoolean(process.env.BOT_ENABLED, true),
  adminToken: process.env.BOT_ADMIN_TOKEN || '',
  businessName: process.env.BUSINESS_NAME || 'Burger Lab',
  defaultDelayMinutes: Number(process.env.DEFAULT_DELAY_MINUTES || 10),
  restaurantLatitude: Number(process.env.RESTAURANT_LATITUDE || -17.3790815),
  restaurantLongitude: Number(process.env.RESTAURANT_LONGITUDE || -66.1733523),
  restaurantAddress: process.env.RESTAURANT_ADDRESS || 'Burger Lab',
  deliveryGroupName: process.env.DELIVERY_GROUP_NAME || 'Burger Lab / Mr delivery',
  deliveryGroupId: process.env.DELIVERY_GROUP_ID || '',
  ownerAlertGroupName: process.env.OWNER_ALERT_GROUP_NAME || 'Burger Lab - Soporte Bot',
  ownerAlertChatId: process.env.OWNER_ALERT_CHAT_ID || '',
  timezone: process.env.BOT_TIMEZONE || 'America/La_Paz',
  openHour: Number(process.env.BOT_OPEN_HOUR || 17),
  closeHour: Number(process.env.BOT_CLOSE_HOUR || 23),
  personality:
    process.env.BOT_PERSONALITY ||
    'Natural, formal y vendedor. Habla como Burger Lab: amable, seguro, breve, con energia de restaurante. Ofrece ayuda sin sonar robotico ni exagerado.',
}

export function assertRequiredConfig() {
  const missing = []
  if (!config.openaiApiKey && !config.geminiApiKey) missing.push('OPENAI_API_KEY o GEMINI_API_KEY')
  if (!config.adminToken) missing.push('BOT_ADMIN_TOKEN')
  if (missing.length > 0) {
    throw new Error(`Faltan variables en .env: ${missing.join(', ')}`)
  }
}
