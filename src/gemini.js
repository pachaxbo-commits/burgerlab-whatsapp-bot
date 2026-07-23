import { GoogleGenAI } from '@google/genai'
import { z } from 'zod'
import { config } from './config.js'
import { getSettings } from './settings.js'

const ai = new GoogleGenAI({ apiKey: config.geminiApiKey })

const nullableEnum = (values) =>
  z.preprocess((value) => {
    if (value === 'null' || value === '' || value === undefined) return null
    return value
  }, z.enum(values).nullable().default(null))

const orderSchema = z.object({
  intent: z.enum(['greeting', 'question', 'order_draft', 'order_ready', 'confirm_order', 'cancel_order', 'delivery_pricing', 'payment_qr_request', 'human_help', 'other']),
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
  const text = config.openaiApiKey
    ? await generateOpenAiWithRetry(prompt)
    : (await generateContentWithRetry(prompt)).text || '{}'
  const parsed = JSON.parse(text)
  return orderSchema.parse(parsed)
}

async function generateOpenAiWithRetry(prompt) {
  try {
    return await generateOpenAi(prompt)
  } catch (error) {
    if (!isTemporaryOpenAiError(error)) throw error
    await new Promise((resolve) => setTimeout(resolve, 700))
    return generateOpenAi(prompt)
  }
}

async function generateOpenAi(prompt) {
  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.openaiApiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: config.openaiModel,
      temperature: 0.25,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content: 'Eres un extractor y asistente de pedidos de restaurante. Responde solo JSON valido.',
        },
        {
          role: 'user',
          content: prompt,
        },
      ],
    }),
  })

  const body = await response.json().catch(() => ({}))
  if (!response.ok) {
    const error = new Error(body?.error?.message || `OpenAI error ${response.status}`)
    error.status = response.status
    throw error
  }

  return body?.choices?.[0]?.message?.content || '{}'
}

function isTemporaryOpenAiError(error) {
  const status = Number(error?.status || error?.code || 0)
  const message = String(error?.message || '')
  return status === 408 || status === 409 || status === 429 || status >= 500 || /rate|timeout|temporarily|overloaded/i.test(message)
}

async function generateContentWithRetry(prompt) {
  try {
    return await generateContent(prompt)
  } catch (error) {
    if (!isTemporaryGeminiError(error)) throw error
    await new Promise((resolve) => setTimeout(resolve, 900))
    return generateContent(prompt)
  }
}

function generateContent(prompt) {
  return ai.models.generateContent({
    model: config.geminiModel,
    contents: prompt,
    config: {
      responseMimeType: 'application/json',
      temperature: 0.4,
    },
  })
}

function isTemporaryGeminiError(error) {
  const status = Number(error?.status || error?.code || 0)
  const message = String(error?.message || '')
  return status === 429 || status === 500 || status === 503 || /UNAVAILABLE|high demand|quota|rate/i.test(message)
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
Personalidad: ${getSettings().personality || config.personality}

Objetivo:
- Responder natural, corto y claro.
- Ayudar al cliente a registrar un pedido.
- No inventar productos ni precios; usa solo el catalogo.
- Si el cliente saluda o pregunta, responde normal y ofrece tomar pedido.
- Si el cliente pregunta cuanto cuesta el delivery/envio/tarifa, devuelve intent="delivery_pricing".
- Si el cliente quiere pagar por QR o pide QR/comprobante, devuelve intent="payment_qr_request".
- Si pregunta algo que no puedes responder con seguridad o requiere decision humana, devuelve intent="human_help" y no inventes.
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
- Si es delivery, pide ubicacion de WhatsApp o direccion. Si manda direccion escrita, aceptala y colocala en deliveryAddress.
- No calcules costo de envio. El delivery lo cobra la moto directo al cliente.
- Detalles como sin mantequilla, sin salsa, sin cebolla, doble llajua, salsa picante, salsa aparte o cambios similares deben ir en note del item correspondiente. Llajua/salsa picante es gratis si no esta en catalogo.
- Si falta algo, missingFields debe indicarlo.

Catalogo disponible:
${catalogLines}

Conversacion resumida:
${conversation.map((entry) => `${entry.role}: ${entry.text}`).join('\n')}

Mensaje nuevo del cliente:
${message}

Devuelve SOLO JSON con esta forma:
{
  "intent": "greeting|question|order_draft|order_ready|confirm_order|cancel_order|delivery_pricing|payment_qr_request|human_help|other",
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
