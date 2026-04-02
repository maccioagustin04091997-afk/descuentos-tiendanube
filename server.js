// =============================================
// Descuentos por Cantidad - Tienda Nube
// Base de datos: JSON en disco (sin dependencias nativas)
// =============================================
require('dotenv').config();

const express = require('express');
const fetch   = require('node-fetch');
const crypto  = require('crypto');
const path    = require('path');
const fs      = require('fs');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// ─── BASE DE DATOS (JSON) ────────────────────────────────────────────────────

const DB_FILE = path.join(__dirname, 'data.json');

function readDB() {
  try {
    if (fs.existsSync(DB_FILE)) return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  } catch {}
  return { stores: {}, rules: [], nextRuleId: 1 };
}

function writeDB(data) {
  fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
}

// Inicializar DB si no existe
if (!fs.existsSync(DB_FILE)) writeDB({ stores: {}, rules: [], nextRuleId: 1 });

// ─── HELPERS ──────────────────────────────────────────────────────────────────

async function tnFetch(storeId, endpoint, options = {}) {
  const db    = readDB();
  const store = db.stores[storeId];
  if (!store) throw new Error(`Tienda no encontrada: ${storeId}`);

  const url = `https://api.tiendanube.com/v1/${storeId}${endpoint}`;
  const res  = await fetch(url, {
    ...options,
    headers: {
      'Content-Type':  'application/json',
      'Authentication': `bearer ${store.access_token}`,
      'User-Agent':    `DescuentosPorCantidad (${process.env.CONTACT_EMAIL})`,
      ...(options.headers || {})
    }
  });

  if (res.status === 204) return null;
  const text = await res.text();
  try { return JSON.parse(text); } catch { return text; }
}

function findRule(rules, productId, categoryIds = []) {
  const active = rules.filter(r => r.active);
  for (const r of active) {
    if (r.target_type === 'products' && r.target_ids.map(String).includes(String(productId))) return r;
  }
  for (const r of active) {
    if (r.target_type === 'categories' && categoryIds.some(c => r.target_ids.map(String).includes(String(c)))) return r;
  }
  return active.find(r => r.target_type === 'all') || null;
}

function getDiscount(rule, qty) {
  const sorted = [...rule.scales].sort((a, b) => b.min - a.min);
  for (const s of sorted) {
    if (qty >= s.min && (s.max == null || qty <= s.max)) return s.pct;
  }
  return 0;
}

// ─── OAUTH ────────────────────────────────────────────────────────────────────

app.get('/auth/install', (req, res) => {
  const state   = crypto.randomBytes(16).toString('hex');
  const authUrl = `https://www.tiendanube.com/apps/${process.env.TN_CLIENT_ID}/authorize?state=${state}`;
  res.redirect(authUrl);
});

app.get('/auth/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.status(400).send('Falta el código de autorización');

  try {
    const tokenRes = await fetch('https://www.tiendanube.com/apps/authorize/token', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id:     process.env.TN_CLIENT_ID,
        client_secret: process.env.TN_CLIENT_SECRET,
        grant_type:    'authorization_code',
        code
      })
    });

    const tokenData = await tokenRes.json();
    console.log('Token response:', JSON.stringify(tokenData));

    const { access_token, user_id: storeId } = tokenData;
    if (!access_token || !storeId) {
      return res.status(400).send(`Error al obtener token: ${JSON.stringify(tokenData)}`);
    }

    const storeIdStr = String(storeId);
    const db = readDB();

    // Guardar store
    db.stores[storeIdStr] = {
      store_id:     storeIdStr,
      access_token,
      store_name:   null,
      promotion_id: null,
      connected_at: new Date().toISOString()
    };
    writeDB(db);

    // Obtener nombre de la tienda
    try {
      const info = await tnFetch(storeIdStr, '');
      if (info?.name) {
        const name = typeof info.name === 'object'
          ? (info.name.es || info.name.pt || Object.values(info.name)[0])
          : info.name;
        const db2 = readDB();
        db2.stores[storeIdStr].store_name = name;
        writeDB(db2);
      }
    } catch (e) { console.warn('No se pudo obtener nombre:', e.message); }

    // Registrar promoción (paso 1: crear, paso 2: registrar callback)
    try {
      const promo = await tnFetch(storeIdStr, '/promotions', {
        method: 'POST',
        body: JSON.stringify({
          name:            'Descuentos por Cantidad',
          description:     'Descuentos automáticos por volumen de compra',
          allocation_type: 'line_item',
          active:          true
        })
      });
      console.log('Promotion:', JSON.stringify(promo));

      const promoId = promo?.data?.id || promo?.id || promo?.promotion_id;
      if (promoId) {
        const db3 = readDB();
        db3.stores[storeIdStr].promotion_id = String(promoId);
        writeDB(db3);

        // Paso 2: registrar callback URL
        await tnFetch(storeIdStr, '/discounts/callbacks', {
          method: 'PUT',
          body: JSON.stringify({ url: `${process.env.APP_URL}/discount/callback` })
        });
        console.log('Callback URL registrada OK');
      }
    } catch (e) { console.error('Error registrando promoción:', e.message); }

    res.redirect(`/?store=${storeIdStr}&connected=1`);
  } catch (err) {
    console.error('OAuth error:', err);
    res.status(500).send(`Error: ${err.message}`);
  }
});

// ─── DISCOUNT CALLBACK ────────────────────────────────────────────────────────

app.post('/discount/callback', (req, res) => {
  const { store_id, products, currency } = req.body;
  if (!store_id || !Array.isArray(products) || products.length === 0) return res.status(204).send();

  const storeIdStr = String(store_id);
  const db    = readDB();
  const store = db.stores[storeIdStr];
  if (!store?.promotion_id) { console.warn(`Sin promotion_id: ${storeIdStr}`); return res.status(204).send(); }

  const rules    = db.rules.filter(r => r.store_id === storeIdStr);
  const commands = [];

  for (const product of products) {
    const lineItemId  = product.id ?? product.line_item_id;
    const productId   = product.product_id ?? product.id;
    const qty         = Number(product.quantity) || 0;
    const categories  = Array.isArray(product.categories) ? product.categories : [];
    if (!lineItemId || qty === 0) continue;

    const rule        = findRule(rules, productId, categories);
    const discountPct = rule ? getDiscount(rule, qty) : 0;

    if (discountPct > 0) {
      commands.push({
        command: 'create_or_update_discount',
        specs: {
          promotion_id: store.promotion_id,
          currency:     currency || 'ARS',
          display_text: {
            'es-ar': `${discountPct}% OFF por volumen`,
            'pt-br': `${discountPct}% OFF por volume`,
            'en':    `${discountPct}% OFF volume discount`
          },
          line_items: [{ line_item: String(lineItemId), discount_specs: { type: 'percentage', amount: String(discountPct) } }]
        }
      });
    } else {
      commands.push({ command: 'remove_discount', specs: { promotion_id: store.promotion_id, line_items: [String(lineItemId)] } });
    }
  }

  if (commands.length === 0) return res.status(204).send();
  console.log(`[callback] store=${storeIdStr} commands=${commands.length}`);
  res.json({ commands });
});

// ─── API – TIENDAS ────────────────────────────────────────────────────────────

app.get('/api/stores', (_, res) => {
  const db = readDB();
  res.json(Object.values(db.stores).sort((a, b) => b.connected_at?.localeCompare(a.connected_at)));
});

app.delete('/api/stores/:storeId', (req, res) => {
  const db = readDB();
  delete db.stores[req.params.storeId];
  db.rules = db.rules.filter(r => r.store_id !== req.params.storeId);
  writeDB(db);
  res.json({ ok: true });
});

// ─── API – REGLAS ─────────────────────────────────────────────────────────────

app.get('/api/rules/:storeId', (req, res) => {
  const db = readDB();
  res.json(db.rules.filter(r => r.store_id === req.params.storeId));
});

app.post('/api/rules/:storeId', (req, res) => {
  const { storeId } = req.params;
  const { name, target_type, target_ids, scales } = req.body;
  if (!name || !target_type || !Array.isArray(scales) || scales.length !== 5)
    return res.status(400).json({ error: 'Faltan campos' });

  const db = readDB();
  const rule = { id: db.nextRuleId++, store_id: storeId, name, target_type, target_ids: target_ids || [], scales, active: true, created_at: new Date().toISOString() };
  db.rules.push(rule);
  writeDB(db);
  res.json({ id: rule.id });
});

app.put('/api/rules/:id', (req, res) => {
  const id = Number(req.params.id);
  const { name, target_type, target_ids, scales, active } = req.body;
  const db = readDB();
  const idx = db.rules.findIndex(r => r.id === id);
  if (idx === -1) return res.status(404).json({ error: 'No encontrada' });
  db.rules[idx] = { ...db.rules[idx], name, target_type, target_ids: target_ids || [], scales, active: !!active };
  writeDB(db);
  res.json({ ok: true });
});

app.patch('/api/rules/:id/toggle', (req, res) => {
  const id = Number(req.params.id);
  const db = readDB();
  const rule = db.rules.find(r => r.id === id);
  if (!rule) return res.status(404).json({ error: 'No encontrada' });
  rule.active = !rule.active;
  writeDB(db);
  res.json({ active: rule.active });
});

app.delete('/api/rules/:id', (req, res) => {
  const id = Number(req.params.id);
  const db = readDB();
  db.rules = db.rules.filter(r => r.id !== id);
  writeDB(db);
  res.json({ ok: true });
});

// ─── PROXY – Productos y Categorías ──────────────────────────────────────────

app.get('/api/tn/:storeId/products', async (req, res) => {
  try { res.json(await tnFetch(req.params.storeId, `/products?per_page=200`)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/tn/:storeId/categories', async (req, res) => {
  try { res.json(await tnFetch(req.params.storeId, '/categories')); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── WEBHOOKS PRIVACIDAD (requeridos por TN) ─────────────────────────────────

app.post('/webhooks/privacy', (req, res) => {
  console.log('[privacy webhook]', req.body?.topic);
  // Si es redact de tienda, borramos sus datos
  if (req.body?.topic === 'store/redact') {
    const storeId = String(req.body.store_id);
    const db = readDB();
    delete db.stores[storeId];
    db.rules = db.rules.filter(r => r.store_id !== storeId);
    writeDB(db);
  }
  res.status(200).json({ ok: true });
});

// ─── INICIO ───────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`\n✅  Servidor en http://localhost:${PORT}`);

  // Auto-tunnel con localtunnel si APP_URL no está configurada
  if (!process.env.APP_URL || process.env.APP_URL === 'PENDIENTE') {
    try {
      const localtunnel = require('localtunnel');
      const tunnel = await localtunnel({ port: PORT, subdomain: 'descuentos-tn' });
      console.log(`🌐  URL pública: ${tunnel.url}`);
      process.env.APP_URL = tunnel.url;
      console.log(`📌  Actualizá APP_URL en .env con: ${tunnel.url}\n`);
      tunnel.on('error', err => console.error('Tunnel error:', err.message));
      tunnel.on('close', () => console.log('Tunnel cerrado'));
    } catch (e) {
      console.warn('⚠️  No se pudo iniciar el túnel automático:', e.message);
    }
  } else {
    console.log(`🌐  URL pública: ${process.env.APP_URL}`);
  }

  console.log(`🔗  Callback URL: ${process.env.APP_URL || '(pendiente)'}/discount/callback\n`);

  // Re-registrar callback URL en TN para todas las tiendas conectadas al arrancar
  if (process.env.APP_URL && process.env.APP_URL !== 'PENDIENTE') {
    const db = readDB();
    for (const store of Object.values(db.stores)) {
      if (!store.access_token || !store.promotion_id) continue;
      try {
        await tnFetch(store.store_id, '/discounts/callbacks', {
          method: 'PUT',
          body: JSON.stringify({ url: `${process.env.APP_URL}/discount/callback` })
        });
        console.log(`✅  Callback re-registrado para tienda ${store.store_id}`);
      } catch (e) {
        console.warn(`⚠️  No se pudo re-registrar callback para ${store.store_id}:`, e.message);
      }
    }
  }
});
