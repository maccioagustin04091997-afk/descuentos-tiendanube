# Descuentos por Cantidad — Tienda Nube
## Guía de Instalación

---

### PASO 1 — Crear cuenta de Partner en Tienda Nube

1. Ingresá a https://partners.tiendanube.com/
2. Creá una cuenta de partner (es gratis)
3. Andá a **Apps** → **Crear App**
4. Completá:
   - Nombre: "Descuentos por Cantidad"
   - URL de callback de OAuth: `https://TU-DOMINIO.com/auth/callback`
   - Permisos requeridos: `read_products`, `read_orders`, `write_discount`
5. Guardá y copiá el **Client ID** y **Client Secret**

---

### PASO 2 — Instalar Node.js

Necesitás Node.js 18 o superior.
Descargalo desde: https://nodejs.org

---

### PASO 3 — Configurar la aplicación

```bash
# 1. Descomprimí el ZIP y entrá a la carpeta
cd descuentos-tiendanube

# 2. Instalá dependencias
npm install

# 3. Copiá el archivo de configuración
cp .env.example .env

# 4. Editá .env con tus datos
# (abrilo con cualquier editor de texto)
```

Completá el archivo `.env`:
```
TN_CLIENT_ID=tu_client_id
TN_CLIENT_SECRET=tu_client_secret
APP_URL=https://TU-URL-PUBLICA.ngrok.io
CONTACT_EMAIL=tu@email.com
```

---

### PASO 4 — Exponer tu app con ngrok (desarrollo local)

Si estás probando en tu computadora, necesitás una URL pública.
Usá ngrok (gratis): https://ngrok.com/download

```bash
# En una terminal aparte:
ngrok http 3000

# Copiá la URL que te da (ej: https://abc123.ngrok.io)
# Ponela en APP_URL de tu .env
```

---

### PASO 5 — Iniciar la aplicación

```bash
npm start
```

Abrí http://localhost:3000 en tu navegador.

---

### PASO 6 — Conectar tu tienda

1. En el dashboard, hacé clic en **"Conectar Tienda"**
2. Se abre el flujo OAuth de Tienda Nube
3. Autorizá la app en tu tienda
4. ¡Listo! Ya podés crear tus reglas de descuento

---

### Cómo funciona

- Cada vez que un cliente **agrega o modifica** productos en el carrito, Tienda Nube llama a tu app
- Tu app evalúa la cantidad y aplica el descuento correspondiente **automáticamente en el checkout**
- El descuento es real (no cosmético): se descuenta del total a pagar

---

### Escalas recomendadas para empezar

| Escala | Cantidad | Descuento |
|--------|----------|-----------|
| 1      | 1 unidad | 0% (precio lleno) |
| 2      | 2–4      | 4.5% |
| 3      | 5–9      | 8% |
| 4      | 10–19    | 12% |
| 5      | 20+      | 15% |

---

### Despliegue en producción

Para producción, podés usar servicios gratuitos o baratos:
- **Railway**: https://railway.app (recomendado, muy fácil)
- **Render**: https://render.com
- **Heroku**: https://heroku.com

En cualquiera de estos, configurás las variables de entorno (.env)
y apuntás APP_URL a la URL que te dan.
