import { GoogleGenAI } from '@google/genai'
import { z } from 'zod'
import { config } from './config.js'

const ai = new GoogleGenAI({ apiKey: config.geminiApiKey })

const nullableEnum = (values) =>
  z.preprocess((value) => {
    if (value === 'null' || value === '' || value === undefined) return null
    return value
  }, z.enum(values).nullable().default(null))

const orderSchema = z.object({
  intent: z.enum(['greeting', 'question', 'order_draft', 'order_ready', 'confirm_order', 'cancel_order', 'other']),
  reply: z.string(),
  missingFields: z.array(z.string()).default([]),
  customerName: z.string().default(''),
  customerPhone: z.string().default(''),
  paymentMethod: nullableEnum(['cash', 'qr', 'mixed']),
  fulfillmentType: nullableEnum(['pickup', 'delivery']),
  deliveryAddress: z.string().default(''),
  items: z
    .array(
      z.object({
        productId: z.string(),
        name: z.string(),
        basePrice: z.number(),
        quantity: z.number().int().positive(),
        note: z.string().default(''),
        options: z.array(z.string()).default([]),
        extras: z.array(z.object({ id: z.string(), name: z.string(), price: z.number() })).default([]),
      }),
    )
    .default([]),
})

export async function understandMessage({ message, conversation, catalog }) {
  const prompt = buildPrompt({ message, conversation, catalog })
  const response = await ai.models.generateContent({
    model: config.geminiModel,
    contents: prompt,
    config: {
      responseMimeType: 'application/json',
      temperature: 0.4,
    },
  })

  const text = response.text || '{}'
  const parsed = JSON.parse(text)
  return orderSchema.parse(parsed)
}

function buildPrompt({ message, conversation, catalog }) {
  const catalogLines = catalog.products
    .map((product) => {
      const extras = Array.isArray(product.extras) && product.extras.length
        ? ` Extras: ${product.extras.map((extra) => `${extra.name} +${extra.price}`).join(', ')}.`
        : ''
      return `- id=${product.id}; ${product.name}; precio=${product.price}; categoria=${product.categoryId}.${extras}`
    })
    .join('\n')

  return `
Eres el bot de WhatsApp de ${config.businessName}.
Personalidad: ${config.personality}

Objetivo:
- Responder natural, corto y claro.
- Ayudar al cliente a registrar un pedido.
- No inventar productos ni precios; usa solo el catalogo.
- Si el cliente saluda o pregunta, responde normal y ofrece tomar pedido.
- Cuando quiera pedir, pide esta lista:
Nombre
Pedido
Metodo de pago: QR o efectivo
Recojo o envio. Si es envio, pedir ubicacion/direccion.
- No crees el pedido hasta tener esos datos y los items del catalogo.
- Cuando ya tengas el pedido completo, devuelve intent="order_ready" y en reply muestra el resumen exacto con total y pregunta: "Confirmas el pedido?"
- Si el cliente confirma un resumen pendiente con palabras como si, confirmo, correcto, dale o ok, devuelve intent="confirm_order".
- Si el cliente cancela o quiere cambiar, devuelve intent="cancel_order" u "order_draft" segun corresponda.
- Si el metodo es QR, puede ser pago anticipado y recojo en restaurante.
- Si es delivery y manda direccion escrita, pide amablemente ubicacion de WhatsApp. Si no puede o no sabe, acepta la direccion escrita y colocala en deliveryAddress.
- Si falta algo, missingFields debe indicarlo.

Catalogo disponible:
${catalogLines}

Conversacion resumida:
${conversation.map((entry) => `${entry.role}: ${entry.text}`).join('\n')}

Mensaje nuevo del cliente:
${message}

Devuelve SOLO JSON con esta forma:
{
  "intent": "greeting|question|order_draft|order_ready|confirm_order|cancel_order|other",
  "reply": "respuesta para WhatsApp",
  "missingFields": ["Nombre", "Metodo de pago"],
  "customerName": "",
  "customerPhone": "",
  "paymentMethod": "cash|qr|mixed|null",
  "fulfillmentType": "pickup|delivery|null",
  "deliveryAddress": "",
  "items": [
    {
      "productId": "id del catalogo",
      "name": "nombre",
      "basePrice": 25,
      "quantity": 1,
      "note": "",
      "options": [],
      "extras": []
    }
  ]
}
`
}
