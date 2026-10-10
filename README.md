# tilcai-mcp

Servidor MCP (stdio) que permite a un agente con una wallet **EVM** pagar USDC a una dirección **Stellar** a través de [`tilcai-infrastructure`](../tilcai-infrastructure) (Circle CCTP V2). Dos entornos, uno por proceso, según `TILCAI_NETWORK`:

| `TILCAI_NETWORK` | Ruta | Red en evm-mcp-server | API por defecto |
| --- | --- | --- | --- |
| `testnet` (por defecto) | Avalanche Fuji (`eip155:43113`) → Stellar Testnet | `avalanche-fuji` | `http://192.168.1.57:8787` |
| `mainnet` | Avalanche C-Chain (`eip155:43114`) → Stellar Public Network (`stellar:pubnet`) | `avalanche` | `http://127.0.0.1:18787` (`tilcai-mainnet`, solo loopback) |

**Mainnet mueve USDC real.** Usa claves propias (`TILCAI_API_KEYS_MAINNET` en el servidor; las de testnet se rechazan). `tilcai_create_payment` comprueba antes `/health` y falla con `ENVIRONMENT_MISMATCH` si la API es de otro entorno, o con `TRANSACTIONS_DISABLED` si la instancia es de solo lectura (`MAINNET_TRANSACTIONS_ENABLED`). `tilcai_status` informa la red configurada y avisa si no coincide.

El agente firma y transmite con [`evm-mcp-server`](https://github.com/mcpdotdirect/evm-mcp-server); `tilcai-mcp` solo habla con la API de TilcAI y le dice al agente qué firmar. **Nunca maneja claves privadas.**

## Instalación

```sh
npx -y tilcai-mcp          # o: npm i -g tilcai-mcp
```

Ejemplo de configuración en un cliente MCP: `{"command": "npx", "args": ["-y", "tilcai-mcp"], "env": {"TILCAI_API_KEY": "…"}}`.

## Herramientas

| Herramienta | Qué hace |
| --- | --- |
| `tilcai_status` | Salud de TilcAI/relayer y rutas |
| `tilcai_quote` | Cotiza `amount` USDC de Fuji a `payTo` (G…) y comprueba la trustline |
| `tilcai_create_payment` | Crea el pago. `gasless` (por defecto): devuelve los argumentos de `sign_typed_data`. `external`: devuelve las llamadas `approve` + `depositForBurnWithHook` |
| `tilcai_submit_authorization` | `gasless`: envía la firma de `sign_typed_data`; el relayer paga el gas en las dos redes |
| `tilcai_submit_burn` | `external`: informa el hash del burn |
| `tilcai_payment_status` | Estado hasta `SETTLED` (`reconcile=true` fuerza un paso) |

## Flujo (gasless, el agente no necesita AVAX)

1. `evm.get_wallet_address` → `payer`.
2. `tilcai_quote {amount, payTo}` → `quoteId`.
3. `tilcai_create_payment {quoteId, payer}` → argumentos de `sign_typed_data`.
4. `evm.sign_typed_data` con esos argumentos → firma.
5. `tilcai_submit_authorization {paymentId, signature}`.
6. `tilcai_payment_status` hasta `SETTLED` (la atestación de Circle puede tardar minutos).

## Configuración

Variables: `TILCAI_NETWORK` (`testnet`|`mainnet`), `TILCAI_API_URL` (por defecto según la red), `TILCAI_API_KEY` (clave Bearer de TilcAI; obligatoria salvo `tilcai_status`).

opencode (`~/.config/opencode/opencode.json`) usa `{env:…}`, así que ningún secreto queda en el archivo: exporta `EVM_PRIVATE_KEY` (wallet con USDC de la red elegida) y `TILCAI_API_KEY` antes de abrir opencode.

```sh
npm install
npm test
npm run typecheck
opencode mcp list      # evm y tilcai deben aparecer connected
```

Para mainnet, registra una segunda entrada (p. ej. `tilcai-mainnet`) con `TILCAI_NETWORK=mainnet` y su propia `TILCAI_API_KEY`; así testnet y mainnet conviven sin mezclarse.

### Túnel ngrok

El servidor expone un único dominio ngrok (`https://dot-revealable-telescopically.ngrok-free.dev`) y `ngrok-router.mjs` separa por prefijo de ruta (se quita antes de reenviar):

| `TILCAI_API_URL` | Instancia |
| --- | --- |
| `…/tilcai` | testnet (`:8787`) |
| `…/tilcai-mainnet` | mainnet (`:18787`) |

`~/.config/opencode/opencode.json` registra `tilcai` y `tilcai-mainnet` con esas URLs. Exporta `TILCAI_API_KEY` (testnet) y `TILCAI_API_KEY_MAINNET` (`MAINNET_TILCAI_API_KEYS` del servidor) antes de abrir opencode. La URL de mainnet es pública: solo la protege la clave Bearer.
