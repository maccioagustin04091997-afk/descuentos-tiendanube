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
    if (fs.existsSync(DB_FILE)) {
      const data = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
      // Migración: asegurar que shipping_rules exista
      if (!data.shipping_rules) { data.shipping_rules = []; data.nextShippingRuleId = 1; }
      if (!data.nextShippingRuleId) data.nextShippingRuleId = (data.shipping_rules.length + 1);
      return data;
    }
  } catch {}
  return { stores: {}, rules: [], nextRuleId: 1, shipping_rules: [], nextShippingRuleId: 1 };
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

// ─── ENVÍO GRATIS CABA / AMBA ─────────────────────────────────────────────────
const CABA_RANGE  = [1000, 1499];
const AMBA_RANGES = [
  [1600, 1641], [1642, 1649], [1618, 1649], [1650, 1679],
  [1660, 1679], [1682, 1699], [1706, 1729], [1714, 1718],
  [1686, 1692], [1722, 1749], [1742, 1749], [1752, 1779],
  [1741, 1760], [1802, 1818], [1820, 1836], [1840, 1866],
  [1868, 1878], [1876, 1882], [1880, 1884], [1886, 1889],
];

function isCabaAmba(zipcode) {
  if (!zipcode) return false;
  const z = String(zipcode).trim().toUpperCase().replace(/\s+/g, '');
  if (/^C1\d{3}/.test(z)) return true;                          // CABA nuevo (C1xxx)
  if (z.startsWith('B')) {
    const num = parseInt(z.slice(1, 5), 10);
    if (!isNaN(num)) return AMBA_RANGES.some(([lo, hi]) => num >= lo && num <= hi);
  }
  const num = parseInt(z, 10);
  if (!isNaN(num) && /^\d{4}$/.test(z.replace(/[A-Z]/g, ''))) {
    if (num >= CABA_RANGE[0] && num <= CABA_RANGE[1]) return true;
    return AMBA_RANGES.some(([lo, hi]) => num >= lo && num <= hi);
  }
  return false;
}

// Verifica si al menos un producto del carrito tiene regla de envío activa
function cartHasShippingRule(db, storeId, cartItems) {
  const rules = (db.shipping_rules || []).filter(r => r.store_id === storeId && r.active);
  if (rules.length === 0) return false;
  // Si existe una regla "all", aplica a cualquier producto
  if (rules.some(r => r.target_type === 'all')) return true;
  // Si algún producto del carrito tiene regla explícita, aplica
  return cartItems.some(item => {
    const pid = String(item.product_id || item.id || '');
    return rules.some(r =>
      r.target_type === 'products' && r.target_ids.map(String).includes(pid)
    );
  });
}

async function registerShippingCarrier(storeId) {
  const db    = readDB();
  const store = db.stores[storeId];
  if (!store?.access_token) return;

  const body = {
    name:         'Envío Gratis CABA y GBA',
    callback_url: `${process.env.APP_URL}/shipping/callback`,
    types:        'ship'
  };

  try {
    const carrierId = store.shipping_carrier_id;
    let result;
    if (carrierId) {
      result = await tnFetch(storeId, `/shipping_carriers/${carrierId}`, { method: 'PUT', body: JSON.stringify(body) });
    } else {
      result = await tnFetch(storeId, '/shipping_carriers', { method: 'POST', body: JSON.stringify(body) });
    }
    console.log('[shipping-carrier] result:', JSON.stringify(result));
    const newId = result?.id || result?.data?.id;
    if (newId) {
      const db2 = readDB();
      db2.stores[storeId].shipping_carrier_id = String(newId);
      writeDB(db2);
      console.log(`[shipping-carrier] registrado id=${newId} para tienda ${storeId}`);
    }
  } catch(e) {
    console.error('[shipping-carrier] error:', e.message);
  }
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

    // Registrar (o actualizar) el script del widget en la tienda
    try {
      await registerWidgetScript(storeIdStr);
    } catch (e) { console.warn('No se pudo registrar script:', e.message); }

    // Registrar el carrier de envío gratis CABA/AMBA
    try {
      await registerShippingCarrier(storeIdStr);
    } catch (e) { console.warn('No se pudo registrar shipping carrier:', e.message); }

    res.redirect(`/?store=${storeIdStr}&connected=1`);
  } catch (err) {
    console.error('OAuth error:', err);
    res.status(500).send(`Error: ${err.message}`);
  }
});

// ─── DISCOUNT CALLBACK ────────────────────────────────────────────────────────

app.post('/discount/callback', (req, res) => {
  console.log('[callback-raw]', JSON.stringify(req.body));
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
    const unitPrice   = parseFloat(product.price) || 0;
    const categories  = Array.isArray(product.categories) ? product.categories : [];
    if (!lineItemId || qty === 0) continue;

    const rule        = findRule(rules, productId, categories);
    const discountPct = rule ? getDiscount(rule, qty) : 0;

    if (discountPct > 0 && unitPrice > 0) {
      // TN aplica "fixed" como descuento TOTAL de la línea (no por unidad)
      const totalDiscount = (unitPrice * qty * discountPct / 100).toFixed(2);
      commands.push({
        command: 'create_or_update_discount',
        specs: {
          promotion_id: store.promotion_id,
          currency:     currency || 'ARS',
          display_text: {
            'es-ar': `${discountPct}% OFF por volumen`
          },
          line_items: [{ line_item: String(lineItemId), discount_specs: { type: 'fixed', amount: totalDiscount } }]
        }
      });
      console.log(`[callback] descuento ${discountPct}% sobre ${qty}u × $${unitPrice} = -$${totalDiscount}`);
    }
    // No enviamos remove_discount si no hay descuento (puede romper el batch)
  }

  if (commands.length === 0) return res.status(204).send();
  const respBody = { commands };
  console.log(`[callback] store=${storeIdStr} commands=${commands.length} resp=${JSON.stringify(respBody)}`);
  res.json(respBody);
});

// ─── SHIPPING CARRIER CALLBACK ───────────────────────────────────────────────
// TN llama este endpoint durante el checkout con CP destino + ítems del carrito
app.post('/shipping/callback', (req, res) => {
  console.log('[shipping-callback]', JSON.stringify(req.body));

  const storeId = String(req.body?.store_id || '');
  const zipcode = req.body?.destination?.postal_code
                || req.body?.destination?.zipcode
                || req.body?.destination?.zip
                || '';
  const items   = Array.isArray(req.body?.items) ? req.body.items : [];

  const db = readDB();

  // Si el CP no es CABA/AMBA → no ofrecemos envío, TN usa sus carriers
  if (!isCabaAmba(zipcode)) {
    console.log(`[shipping-callback] CP ${zipcode} fuera de zona → sin tarifa`);
    return res.json({ rates: [] });
  }

  // Si ningún producto del carrito tiene regla de envío → no ofrecemos
  if (!cartHasShippingRule(db, storeId, items)) {
    console.log(`[shipping-callback] CP ${zipcode} en zona pero sin regla de envío para estos productos`);
    return res.json({ rates: [] });
  }

  const hoy  = new Date();
  const min_ = new Date(hoy.getTime() + 1*86400000).toISOString();
  const max_ = new Date(hoy.getTime() + 3*86400000).toISOString();

  console.log(`[shipping-callback] CP ${zipcode} → envío gratis`);
  res.json({
    rates: [{
      name:              'Envío Gratis',
      code:              'envio_gratis_caba_gba',
      price:             0,
      price_merchant:    0,
      currency:          'ARS',
      type:              'ship',
      min_delivery_date: min_,
      max_delivery_date: max_,
      phone_required:    false,
      reference:         'envio_gratis_caba_gba'
    }]
  });
});

// ─── API – TIENDAS ────────────────────────────────────────────────────────────

// Registrar manualmente el carrier de envío para una tienda ya conectada
app.post('/api/stores/:storeId/register-carrier', async (req, res) => {
  try {
    await registerShippingCarrier(req.params.storeId);
    const db = readDB();
    const carrierId = db.stores[req.params.storeId]?.shipping_carrier_id;
    res.json({ ok: true, shipping_carrier_id: carrierId || null });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

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

// ─── API – REGLAS DE ENVÍO GRATIS ────────────────────────────────────────────

app.get('/api/shipping-rules/:storeId', (req, res) => {
  const db = readDB();
  res.json((db.shipping_rules || []).filter(r => r.store_id === req.params.storeId));
});

app.post('/api/shipping-rules/:storeId', (req, res) => {
  const { storeId } = req.params;
  const { name, target_type, target_ids } = req.body;
  if (!name || !target_type) return res.status(400).json({ error: 'Faltan campos' });

  const db   = readDB();
  const rule = {
    id:          db.nextShippingRuleId++,
    store_id:    storeId,
    name,
    target_type, // 'products' | 'categories' | 'all'
    target_ids:  target_ids || [],
    active:      true,
    created_at:  new Date().toISOString()
  };
  db.shipping_rules.push(rule);
  writeDB(db);
  res.json({ id: rule.id });
});

app.put('/api/shipping-rules/:id', (req, res) => {
  const id = Number(req.params.id);
  const { name, target_type, target_ids, active } = req.body;
  const db  = readDB();
  const idx = db.shipping_rules.findIndex(r => r.id === id);
  if (idx === -1) return res.status(404).json({ error: 'No encontrada' });
  db.shipping_rules[idx] = { ...db.shipping_rules[idx], name, target_type, target_ids: target_ids || [], active: !!active };
  writeDB(db);
  res.json({ ok: true });
});

app.patch('/api/shipping-rules/:id/toggle', (req, res) => {
  const id   = Number(req.params.id);
  const db   = readDB();
  const rule = db.shipping_rules.find(r => r.id === id);
  if (!rule) return res.status(404).json({ error: 'No encontrada' });
  rule.active = !rule.active;
  writeDB(db);
  res.json({ active: rule.active });
});

app.delete('/api/shipping-rules/:id', (req, res) => {
  const id = Number(req.params.id);
  const db = readDB();
  db.shipping_rules = db.shipping_rules.filter(r => r.id !== id);
  writeDB(db);
  res.json({ ok: true });
});

// ─── PROXY – Productos y Categorías ──────────────────────────────────────────

app.get('/api/tn/:storeId/products', async (req, res) => {
  try {
    // Paginar automáticamente hasta traer todos los productos
    let all = [];
    let page = 1;
    const perPage = 200;
    while (true) {
      const batch = await tnFetch(req.params.storeId, `/products?per_page=${perPage}&page=${page}`);
      if (!Array.isArray(batch) || batch.length === 0) break;
      all = all.concat(batch);
      if (batch.length < perPage) break; // última página
      page++;
    }
    res.json(all);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/tn/:storeId/categories', async (req, res) => {
  try { res.json(await tnFetch(req.params.storeId, '/categories')); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── REGISTRO DE SCRIPT EN TN ────────────────────────────────────────────────

async function registerWidgetScript(storeId) {
  const db    = readDB();
  const store = db.stores[storeId];
  if (!store?.access_token) return;

  const scriptUrl = `${process.env.APP_URL}/widget/${storeId}/widget.js`;
  // TN requiere un script_id entero único provisto por el developer
  const myScriptId = parseInt(String(storeId).slice(-6), 10);

  // 1. Listar scripts existentes para ver si ya está registrado
  const listRes = await tnFetch(storeId, '/scripts');
  console.log(`[script] listado en tienda ${storeId}:`, JSON.stringify(listRes));

  const scripts = Array.isArray(listRes) ? listRes
                : Array.isArray(listRes?.data) ? listRes.data
                : [];

  // Buscar si ya existe un script con nuestra URL o script_id
  const existing = scripts.find(s =>
    s.src === scriptUrl ||
    Number(s.script_id) === myScriptId
  );

  let res;
  if (existing) {
    // Ya existe — actualizarlo con PUT usando el ID asignado por TN
    const tnId = existing.id || existing.script_id || myScriptId;
    res = await tnFetch(storeId, `/scripts/${tnId}`, {
      method: 'PUT',
      body: JSON.stringify({ src: scriptUrl, event: 'onload', where: 'store' })
    });
    console.log(`[script] actualizado (id=${tnId}) en tienda ${storeId}:`, JSON.stringify(res));
  } else {
    // No existe — crearlo con POST
    res = await tnFetch(storeId, '/scripts', {
      method: 'POST',
      body: JSON.stringify({ script_id: myScriptId, src: scriptUrl, event: 'onload', where: 'store' })
    });
    console.log(`[script] creado en tienda ${storeId}:`, JSON.stringify(res));
  }

  const scriptId = res?.data?.id || res?.id || existing?.id || myScriptId;
  const db2 = readDB();
  db2.stores[storeId].script_id = String(scriptId);
  writeDB(db2);
}

// ─── WIDGET PÚBLICO ──────────────────────────────────────────────────────────

// Reglas públicas para el widget (sin auth, CORS abierto)
app.get('/api/public/rules/:storeId', (req, res) => {
  res.header('Access-Control-Allow-Origin', '*');
  const db = readDB();
  const rules = db.rules.filter(r => r.store_id === req.params.storeId && r.active);
  res.json(rules);
});

// Verificar si un producto específico tiene descuento configurado EXPLÍCITAMENTE
// (solo reglas de producto o categoría, NO el fallback "all")
// GET /api/public/product-discount/:storeId/:productId?categories=id1,id2
app.get('/api/public/product-discount/:storeId/:productId', (req, res) => {
  res.header('Access-Control-Allow-Origin', '*');
  const db = readDB();
  const rules = db.rules.filter(r => r.store_id === req.params.storeId);
  const categoryIds = req.query.categories
    ? req.query.categories.split(',').map(s => s.trim()).filter(Boolean)
    : [];

  // Solo aplica si hay regla explícita de producto o categoría
  const active = rules.filter(r => r.active);
  let rule = null;
  for (const r of active) {
    if (r.target_type === 'products' && r.target_ids.map(String).includes(String(req.params.productId))) { rule = r; break; }
  }
  if (!rule) {
    for (const r of active) {
      if (r.target_type === 'categories' && categoryIds.some(c => r.target_ids.map(String).includes(String(c)))) { rule = r; break; }
    }
  }

  if (!rule) return res.json({ applies: false });
  res.json({ applies: true, scales: rule.scales || [] });
});

// Verificar si un producto tiene envío gratis CABA/AMBA configurado
// GET /api/public/product-shipping/:storeId/:productId?categories=id1,id2
app.get('/api/public/product-shipping/:storeId/:productId', (req, res) => {
  res.header('Access-Control-Allow-Origin', '*');
  const db   = readDB();
  const rules = (db.shipping_rules || []).filter(r => r.store_id === req.params.storeId);
  const categoryIds = req.query.categories
    ? req.query.categories.split(',').map(s => s.trim()).filter(Boolean)
    : [];

  const active = rules.filter(r => r.active);
  let found = null;

  // Prioridad: producto > categoría > todos
  for (const r of active) {
    if (r.target_type === 'products' && r.target_ids.map(String).includes(String(req.params.productId))) { found = r; break; }
  }
  if (!found) {
    for (const r of active) {
      if (r.target_type === 'categories' && categoryIds.some(c => r.target_ids.map(String).includes(String(c)))) { found = r; break; }
    }
  }
  if (!found) {
    found = active.find(r => r.target_type === 'all') || null;
  }

  if (!found) return res.json({ free_shipping: false });
  res.json({ free_shipping: true });
});

// Widget JS dinámico por tienda
app.get('/widget/:storeId/widget.js', (req, res) => {
  res.header('Content-Type', 'application/javascript; charset=utf-8');
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Cache-Control', 'public, max-age=60');
  res.send(buildWidgetScript(req.params.storeId, process.env.APP_URL));
});

function buildWidgetScript(storeId, appUrl) {
  return `
(function() {
  var STORE_ID = '${storeId}';
  var API = '${appUrl}';

  function ready(fn) {
    if (document.readyState !== 'loading') fn();
    else document.addEventListener('DOMContentLoaded', fn);
  }

  function getProductId() {
    if (typeof LS !== 'undefined' && LS.product && LS.product.id) return String(LS.product.id);
    var inp = document.querySelector('input[name="product_id"], [data-product-id]');
    if (inp) return String(inp.value || inp.getAttribute('data-product-id') || '');
    return null;
  }

  function getCategoryIds() {
    try {
      if (typeof LS !== 'undefined' && LS.product && Array.isArray(LS.product.categories)) {
        return LS.product.categories.map(function(c) { return String(c.id || c); }).filter(Boolean);
      }
    } catch(e) {}
    return [];
  }

  function insertWidget(el) {
    // Inserta el widget después del precio, o antes del botón comprar
    var inserted = false;
    var priceSelectors = [
      '.product-price', '.prices', '.product-prices',
      '[class*="product-price"]', '[class*="product__price"]',
      '[class*="price-box"]', '.js-price-display'
    ];
    for (var i = 0; i < priceSelectors.length; i++) {
      var anchor = document.querySelector(priceSelectors[i]);
      if (anchor && anchor.parentNode) {
        anchor.parentNode.insertBefore(el, anchor.nextSibling);
        inserted = true; break;
      }
    }
    if (!inserted) {
      var cartBtn = document.querySelector(
        'form[action*="/cart/add"], [class*="add-to-cart"], [class*="buy-button"], .buy-button'
      );
      if (cartBtn && cartBtn.parentNode) {
        cartBtn.parentNode.insertBefore(el, cartBtn); inserted = true;
      }
    }
    if (!inserted) {
      var form = document.querySelector('form.product-form, form[action*="cart"]');
      if (form) form.insertAdjacentElement('beforebegin', el);
    }
  }

  ready(function() {
    var productId = getProductId();
    if (!productId) return;

    var categoryIds = getCategoryIds();
    var catParam = categoryIds.length > 0 ? '?categories=' + categoryIds.join(',') : '';

    var urlDiscount = API + '/api/public/product-discount/' + STORE_ID + '/' + productId + catParam;
    var urlShipping = API + '/api/public/product-shipping/' + STORE_ID + '/' + productId + catParam;

    Promise.all([
      fetch(urlDiscount).then(function(r) { return r.json(); }).catch(function() { return {}; }),
      fetch(urlShipping).then(function(r) { return r.json(); }).catch(function() { return {}; })
    ]).then(function(results) {
      var discount = results[0];
      var shipping = results[1];

      var hasDiscount = discount.applies && Array.isArray(discount.scales) &&
                        discount.scales.some(function(s) { return s.pct > 0; });
      var hasShipping = !!shipping.free_shipping;

      if (!hasDiscount && !hasShipping) return;

      // ── Bloque de envío gratis ────────────────────────────────
      var shippingHtml = '';
      if (hasShipping) {
        shippingHtml =
          '<div style="display:flex;align-items:center;gap:8px;padding:10px 12px;' +
          'background:#f0fdf4;border:1px solid #86efac;border-radius:6px;margin-bottom:' +
          (hasDiscount ? '10px' : '0') + ';">' +
            '<span style="font-size:18px;">\uD83D\uDE9A</span>' +
            '<div>' +
              '<div style="font-weight:700;font-size:13px;color:#166534;">Env\u00edo GRATIS</div>' +
              '<div style="font-size:12px;color:#15803d;margin-top:1px;">' +
                'A CABA, Gran Buenos Aires y AMBA' +
              '</div>' +
            '</div>' +
          '</div>';
      }

      // ── Tabla de descuentos ───────────────────────────────────
      var discountHtml = '';
      if (hasDiscount) {
        var scales = discount.scales.filter(function(s) { return s.pct > 0; });
        var rows = '';
        scales.forEach(function(s) {
          var range = s.max ? (s.min + ' \u2013 ' + s.max + ' unidades') : (s.min + '+ unidades');
          rows += '<tr style="border-top:1px solid #d0e8fb;">' +
            '<td style="padding:6px 10px;color:#333;font-size:13px;">' + range + '</td>' +
            '<td style="padding:6px 10px;text-align:center;font-weight:700;color:#c0392b;font-size:13px;">' + s.pct + '% OFF</td>' +
            '</tr>';
        });
        discountHtml =
          '<div style="display:flex;align-items:center;gap:6px;margin-bottom:10px;">' +
            '<span style="font-size:16px;">\uD83C\uDFF7\uFE0F</span>' +
            '<span style="font-weight:700;font-size:14px;color:#1a3c5e;">Descuentos por cantidad</span>' +
          '</div>' +
          '<table style="width:100%;border-collapse:collapse;">' +
            '<thead><tr style="background:#cce8fc;">' +
              '<th style="padding:6px 10px;text-align:left;font-size:12px;color:#1a3c5e;font-weight:600;">CANTIDAD</th>' +
              '<th style="padding:6px 10px;text-align:center;font-size:12px;color:#1a3c5e;font-weight:600;">DESCUENTO</th>' +
            '</tr></thead>' +
            '<tbody>' + rows + '</tbody>' +
          '</table>';
      }

      // ── Montar widget contenedor ──────────────────────────────
      var widget = document.createElement('div');
      widget.id = 'dcx-descuentos-widget';
      widget.setAttribute('style',
        'margin:14px 0;padding:14px 16px;background:#eef6ff;' +
        'border:1px solid #aad4f5;border-radius:8px;font-family:inherit;');
      widget.innerHTML = shippingHtml + discountHtml;

      insertWidget(widget);
    });
  });
})();
`.trim();
}

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

  // Re-registrar callback y script en TN para todas las tiendas al arrancar
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
      // Re-registrar widget script
      try {
        await registerWidgetScript(store.store_id);
        console.log(`✅  Script widget re-registrado para tienda ${store.store_id}`);
      } catch (e) {
        console.warn(`⚠️  No se pudo re-registrar script para ${store.store_id}:`, e.message);
      }
    }
  }
});
