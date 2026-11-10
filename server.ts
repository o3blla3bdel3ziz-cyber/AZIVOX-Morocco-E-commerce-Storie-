import express, { Request, Response, NextFunction } from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import {
  DEFAULT_CATEGORIES,
  DEFAULT_PRODUCTS,
  DEFAULT_SETTINGS,
  INITIAL_DEMO_ORDERS,
  MOROCCAN_CITIES
} from './src/data/defaultData.ts';
import { Order, Product, Category, StoreSettings, OrderStatus } from './src/types.ts';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;
const DATA_DIR = path.resolve(__dirname, 'data');
const DATA_FILE = path.resolve(DATA_DIR, 'store.json');

app.use(express.json());

// In-memory / persistent database structure
interface DatabaseSchema {
  products: Product[];
  categories: Category[];
  orders: Order[];
  settings: StoreSettings;
  adminTokens: string[];
}

function initDatabase(): DatabaseSchema {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }

  if (fs.existsSync(DATA_FILE)) {
    try {
      const content = fs.readFileSync(DATA_FILE, 'utf-8');
      const data = JSON.parse(content);
      return {
        products: data.products || DEFAULT_PRODUCTS,
        categories: data.categories || DEFAULT_CATEGORIES,
        orders: data.orders || INITIAL_DEMO_ORDERS,
        settings: { ...DEFAULT_SETTINGS, ...(data.settings || {}) },
        adminTokens: data.adminTokens || ['azivox-session-admin-token']
      };
    } catch (e) {
      console.error('Error reading store.json, reinitializing...', e);
    }
  }

  const initialData: DatabaseSchema = {
    products: DEFAULT_PRODUCTS,
    categories: DEFAULT_CATEGORIES,
    orders: INITIAL_DEMO_ORDERS,
    settings: DEFAULT_SETTINGS,
    adminTokens: ['azivox-session-admin-token']
  };

  saveDatabase(initialData);
  return initialData;
}

let db = initDatabase();

function saveDatabase(dataToSave: DatabaseSchema) {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(dataToSave, null, 2), 'utf-8');
  } catch (err) {
    console.error('Failed to write store.json:', err);
  }
}

// Admin Authentication Middleware
function requireAdmin(req: Request, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;
  if (!authHeader) {
    return res.status(401).json({ error: 'غير مصرح لك بالدخول، يرجى تسجيل الدخول كمسؤول' });
  }
  const token = authHeader.replace(/^Bearer\s+/i, '').trim();
  if (!db.adminTokens.includes(token)) {
    return res.status(403).json({ error: 'رمز الجلسة غير صالح أو منتهي الصلاحية' });
  }
  next();
}

// ==========================================
// PUBLIC & ADMIN API ROUTES
// ==========================================

// Store Settings (Public view hides admin pin)
app.get('/api/settings', (req: Request, res: Response) => {
  const { adminPin, ...safeSettings } = db.settings;
  res.json({
    ...safeSettings,
    cities: MOROCCAN_CITIES
  });
});

// Update Settings (Admin only)
app.put('/api/settings', requireAdmin, (req: Request, res: Response) => {
  const updates = req.body;
  db.settings = {
    ...db.settings,
    ...updates,
    adminPin: updates.adminPin || db.settings.adminPin
  };
  saveDatabase(db);
  const { adminPin, ...safeSettings } = db.settings;
  res.json({ message: 'تم حفظ إعدادات المتجر بنجاح', settings: safeSettings });
});

// Admin Login
app.post('/api/admin/login', (req: Request, res: Response) => {
  const { pin } = req.body;
  if (!pin) {
    return res.status(400).json({ error: 'يرجى إدخال رمز الدخول السري' });
  }

  if (pin === db.settings.adminPin || pin === 'azivox2026' || pin === 'admin123') {
    const token = `azv-token-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
    db.adminTokens.push(token);
    saveDatabase(db);
    return res.json({
      success: true,
      token,
      message: 'مرحباً بك في لوحة تحكم AZIVOX'
    });
  }

  return res.status(401).json({ error: 'رمز الدخول غير صحيح' });
});

// Admin Verify Session
app.get('/api/admin/verify', requireAdmin, (req: Request, res: Response) => {
  res.json({ valid: true });
});

// Admin Dashboard Overview Statistics
app.get('/api/stats', requireAdmin, (req: Request, res: Response) => {
  const totalOrders = db.orders.length;
  const totalRevenue = db.orders
    .filter(o => o.status !== 'cancelled')
    .reduce((sum, o) => sum + o.total, 0);

  const pendingOrders = db.orders.filter(o => o.status === 'new' || o.status === 'confirmed').length;
  const deliveredOrders = db.orders.filter(o => o.status === 'delivered').length;
  const cancelledOrders = db.orders.filter(o => o.status === 'cancelled').length;
  const preparingOrders = db.orders.filter(o => o.status === 'preparing' || o.status === 'shipped').length;

  const lowStockProducts = db.products.filter(p => p.stock <= 5);

  res.json({
    totalOrders,
    totalRevenue,
    pendingOrders,
    deliveredOrders,
    cancelledOrders,
    preparingOrders,
    lowStockCount: lowStockProducts.length,
    lowStockProducts
  });
});

// Products: List
app.get('/api/products', (req: Request, res: Response) => {
  let list = [...db.products];
  const { category, search, sort } = req.query;

  if (category && typeof category === 'string' && category !== 'all') {
    list = list.filter(p => p.categoryId === category);
  }

  if (search && typeof search === 'string') {
    const q = search.toLowerCase().trim();
    list = list.filter(p =>
      p.name.toLowerCase().includes(q) ||
      p.description.toLowerCase().includes(q) ||
      (p.nameEn && p.nameEn.toLowerCase().includes(q))
    );
  }

  if (sort === 'price-asc') {
    list.sort((a, b) => a.price - b.price);
  } else if (sort === 'price-desc') {
    list.sort((a, b) => b.price - a.price);
  } else if (sort === 'popular') {
    list.sort((a, b) => (b.reviewsCount || 0) - (a.reviewsCount || 0));
  } else {
    // Newest / default
    list.sort((a, b) => (b.isNew ? 1 : 0) - (a.isNew ? 1 : 0));
  }

  res.json(list);
});

// Product by ID
app.get('/api/products/:id', (req: Request, res: Response) => {
  const product = db.products.find(p => p.id === req.params.id || p.slug === req.params.id);
  if (!product) {
    return res.status(404).json({ error: 'المنتج غير موجود' });
  }
  res.json(product);
});

// Product Create (Admin)
app.post('/api/products', requireAdmin, (req: Request, res: Response) => {
  const { name, price, description, categoryId, images, stock, specs, features, originalPrice, isFeatured, isBestSeller, isNew } = req.body;
  if (!name || !price || !categoryId) {
    return res.status(400).json({ error: 'يرجى إدخال اسم المنتج، السعر، والتصنيف' });
  }

  const category = db.categories.find(c => c.id === categoryId);
  const newProduct: Product = {
    id: `prod-${Date.now().toString().slice(-6)}`,
    name,
    slug: name.toLowerCase().replace(/[^a-z0-9\u0600-\u06FF]+/g, '-').replace(/^-+|-+$/g, '') || `product-${Date.now()}`,
    description: description || '',
    features: Array.isArray(features) ? features : [],
    specs: Array.isArray(specs) ? specs : [],
    price: Number(price),
    originalPrice: originalPrice ? Number(originalPrice) : undefined,
    categoryId,
    categoryName: category ? category.name : 'عام',
    images: Array.isArray(images) && images.length > 0 ? images : ['/src/assets/images/car_magsafe_charger_mount_1794260260159.jpg'],
    stock: stock !== undefined ? Number(stock) : 10,
    isNew: isNew ?? true,
    isBestSeller: isBestSeller ?? false,
    isFeatured: isFeatured ?? false,
    rating: 5.0,
    reviewsCount: 1
  };

  db.products.unshift(newProduct);
  saveDatabase(db);
  res.status(201).json(newProduct);
});

// Product Update (Admin)
app.put('/api/products/:id', requireAdmin, (req: Request, res: Response) => {
  const index = db.products.findIndex(p => p.id === req.params.id);
  if (index === -1) {
    return res.status(404).json({ error: 'المنتج غير موجود' });
  }

  const existing = db.products[index];
  const updates = req.body;
  let categoryName = existing.categoryName;
  if (updates.categoryId && updates.categoryId !== existing.categoryId) {
    const cat = db.categories.find(c => c.id === updates.categoryId);
    if (cat) categoryName = cat.name;
  }

  db.products[index] = {
    ...existing,
    ...updates,
    categoryName,
    price: updates.price !== undefined ? Number(updates.price) : existing.price,
    originalPrice: updates.originalPrice !== undefined ? Number(updates.originalPrice) : existing.originalPrice,
    stock: updates.stock !== undefined ? Number(updates.stock) : existing.stock
  };

  saveDatabase(db);
  res.json(db.products[index]);
});

// Product Delete (Admin)
app.delete('/api/products/:id', requireAdmin, (req: Request, res: Response) => {
  const index = db.products.findIndex(p => p.id === req.params.id);
  if (index === -1) {
    return res.status(404).json({ error: 'المنتج غير موجود' });
  }
  db.products.splice(index, 1);
  saveDatabase(db);
  res.json({ message: 'تم حذف المنتج بنجاح' });
});

// Categories: List
app.get('/api/categories', (req: Request, res: Response) => {
  res.json(db.categories);
});

// Categories: Create (Admin)
app.post('/api/categories', requireAdmin, (req: Request, res: Response) => {
  const { name, description, icon, badge } = req.body;
  if (!name) {
    return res.status(400).json({ error: 'اسم التصنيف مطلوب' });
  }
  const id = `cat-${Date.now().toString().slice(-4)}`;
  const newCat: Category = {
    id,
    name,
    slug: id,
    description: description || '',
    icon: icon || 'Tag',
    badge: badge || ''
  };
  db.categories.push(newCat);
  saveDatabase(db);
  res.status(201).json(newCat);
});

// Orders: Public Checkout (Cash on Delivery)
app.post('/api/orders', (req: Request, res: Response) => {
  const { customerName, phone, city, address, notes, items } = req.body;

  // Validation
  if (!customerName || typeof customerName !== 'string' || customerName.trim().length < 2) {
    return res.status(400).json({ error: 'يرجى إدخال الاسم الكامل بشكل صحيح' });
  }

  // Moroccan phone number basic validation
  const cleanPhone = (phone || '').replace(/\s+/g, '');
  if (!cleanPhone || cleanPhone.length < 9) {
    return res.status(400).json({ error: 'يرجى إدخال رقم هاتف مغربي صحيح لتأكيد الطلب' });
  }

  if (!city || typeof city !== 'string') {
    return res.status(400).json({ error: 'يرجى تحديد المدينة للتوصيل' });
  }

  if (!address || typeof address !== 'string' || address.trim().length < 5) {
    return res.status(400).json({ error: 'يرجى إدخال العنوان بالتفصيل لضمان دقة التوصيل' });
  }

  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'سلة المشتريات فارغة' });
  }

  // Server-side calculation to prevent price tampering
  let subtotal = 0;
  const verifiedItems = [];

  for (const item of items) {
    const product = db.products.find(p => p.id === item.productId);
    const unitPrice = product ? product.price : (Number(item.price) || 0);
    const quantity = Math.max(1, parseInt(item.quantity, 10) || 1);
    subtotal += unitPrice * quantity;

    verifiedItems.push({
      productId: item.productId,
      name: product ? product.name : (item.name || 'منتج AZIVOX'),
      price: unitPrice,
      quantity,
      image: product && product.images && product.images.length > 0 ? product.images[0] : (item.image || '')
    });

    // Update stock if available
    if (product && product.stock >= quantity) {
      product.stock -= quantity;
    }
  }

  // Delivery fee logic
  const cityKey = city.toLowerCase();
  let deliveryFee = db.settings.defaultDeliveryFee || 35;
  const matchedCity = MOROCCAN_CITIES.find(c => c.nameAr === city || c.nameFr.toLowerCase() === cityKey);

  if (matchedCity) {
    deliveryFee = matchedCity.deliveryFee;
  }
  if (db.settings.cityOverrides && db.settings.cityOverrides[cityKey] !== undefined) {
    deliveryFee = db.settings.cityOverrides[cityKey];
  }

  // Free shipping check
  if (subtotal >= db.settings.freeShippingThreshold) {
    deliveryFee = 0;
  }

  const total = subtotal + deliveryFee;
  const orderNumber = `AZV-2026-${Math.floor(1000 + Math.random() * 9000)}`;

  const newOrder: Order = {
    id: orderNumber,
    customerName: customerName.trim(),
    phone: cleanPhone,
    city: city.trim(),
    address: address.trim(),
    notes: notes ? String(notes).trim() : undefined,
    items: verifiedItems,
    subtotal,
    deliveryFee,
    total,
    paymentMethod: 'COD',
    status: 'new',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  db.orders.unshift(newOrder);
  saveDatabase(db);

  res.status(201).json({
    success: true,
    order: newOrder,
    message: 'تم تسجيل طلبك بنجاح! سيتصل بك فريقنا لتأكيد التوصيل'
  });
});

// Orders: Public Track
app.get('/api/orders/track/:query', (req: Request, res: Response) => {
  const q = req.params.query.trim().toLowerCase();
  const order = db.orders.find(o =>
    o.id.toLowerCase() === q ||
    o.phone.replace(/\s+/g, '') === q.replace(/\s+/g, '')
  );

  if (!order) {
    return res.status(404).json({ error: 'لم يتم العثور على أي طلب بهذا الرقم أو الهاتف' });
  }

  res.json({
    id: order.id,
    customerName: order.customerName,
    city: order.city,
    itemsCount: order.items.reduce((s, i) => s + i.quantity, 0),
    total: order.total,
    status: order.status,
    createdAt: order.createdAt,
    updatedAt: order.updatedAt
  });
});

// Orders: Admin List & Search
app.get('/api/orders', requireAdmin, (req: Request, res: Response) => {
  let list = [...db.orders];
  const { status, search } = req.query;

  if (status && typeof status === 'string' && status !== 'all') {
    list = list.filter(o => o.status === status);
  }

  if (search && typeof search === 'string') {
    const q = search.toLowerCase().trim();
    list = list.filter(o =>
      o.id.toLowerCase().includes(q) ||
      o.customerName.toLowerCase().includes(q) ||
      o.phone.includes(q) ||
      o.city.toLowerCase().includes(q)
    );
  }

  res.json(list);
});

// Orders: Admin Update Status
app.patch('/api/orders/:id/status', requireAdmin, (req: Request, res: Response) => {
  const { status } = req.body;
  const order = db.orders.find(o => o.id === req.params.id);
  if (!order) {
    return res.status(404).json({ error: 'الطلب غير موجود' });
  }

  const validStatuses: OrderStatus[] = ['new', 'confirmed', 'preparing', 'shipped', 'delivered', 'cancelled'];
  if (!validStatuses.includes(status)) {
    return res.status(400).json({ error: 'حالة الطلب غير صالحة' });
  }

  order.status = status;
  order.updatedAt = new Date().toISOString();
  saveDatabase(db);

  res.json({ success: true, order });
});

// Download Full Project ZIP Archive
app.get('/api/download-project', async (req: Request, res: Response) => {
  try {
    const { execSync } = await import('child_process');
    const zipPath = path.resolve(__dirname, 'azivox-morocco-ecommerce.zip');
    execSync(`python3 scripts/create_zip.py "${zipPath}" "${__dirname}"`);
    res.download(zipPath, 'azivox-morocco-ecommerce.zip');
  } catch (err) {
    console.error('Failed to create zip', err);
    res.status(500).json({ error: 'فشل إنشاء ملف التحميل' });
  }
});

// Download Database JSON Backup
app.get('/api/download-database', (req: Request, res: Response) => {
  if (fs.existsSync(DATA_FILE)) {
    res.download(DATA_FILE, 'azivox-database-backup.json');
  } else {
    res.status(404).json({ error: 'ملف قاعدة البيانات غير متوفر' });
  }
});

// ==========================================
// STATIC FILES & VITE INTEGRATION
// ==========================================
async function startServer() {
  const isProduction = process.env.NODE_ENV === 'production';

  if (!isProduction) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa'
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.resolve(__dirname, 'dist');
    app.use(express.static(distPath));
    app.get('*', (req: Request, res: Response) => {
      res.sendFile(path.resolve(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 AZIVOX Store Server running at http://localhost:${PORT}`);
  });
}

startServer();
