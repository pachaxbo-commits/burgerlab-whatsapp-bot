# Burger Lab WhatsApp Bot

Bot local/servidor para recibir pedidos por WhatsApp Web, interpretar mensajes con Gemini y crear pedidos en el Firestore del comandero.

## Primer arranque

1. Copia `.env.example` a `.env`.
2. Coloca tu key de Gemini en `GEMINI_API_KEY`.
3. Descarga una service account de Firebase y guardala como `firebase-service-account.json`.
4. Ejecuta:

```bash
npm install
npm start
```

5. Escanea el QR con el WhatsApp que atendera pedidos.

## Endpoints locales

- `GET /health`: estado basico del bot.
- `POST /bot/on`: prende respuestas automaticas.
- `POST /bot/off`: apaga respuestas automaticas.
- `POST /orders/:orderId/confirmed`: avisa al cliente que su pedido fue confirmado.

Todos los endpoints POST requieren header:

```txt
x-bot-token: BOT_ADMIN_TOKEN
```

## Confirmacion desde el sistema

Cuando caja confirme el pedido con demora, el sistema puede llamar:

```http
POST http://localhost:3010/orders/{orderId}/confirmed
x-bot-token: cambia_este_token_largo
content-type: application/json

{
  "delayMinutes": 15
}
```

El bot buscara el telefono guardado en Firestore y enviara el mensaje por WhatsApp.
