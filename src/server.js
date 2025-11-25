require('dotenv').config();
const express = require('express');
const swaggerUi = require('swagger-ui-express');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { WebSocketServer } = require('ws');
const { PrismaClient, Role } = require('@prisma/client');

const prisma = new PrismaClient();
const app = express();
const server = http.createServer(app);

const PORT = process.env.PORT || 3000;
const WS_PORT = process.env.WS_PORT || 3001;
const ADMIN_MATS = (process.env.ADMIN_MATRICULAS || '0000001,1111111')
  .split(',')
  .map((v) => v.trim())
  .filter(Boolean);

function loadAdminToken() {
  try {
    const filePath = path.join(__dirname, '..', 'config', 'admin.json');
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed.adminToken) return String(parsed.adminToken).trim();
  } catch (err) {
    // fallback to env/default
  }
  return (process.env.ADMIN_TOKEN || 'admin-secret-token').trim();
}

const ADMIN_TOKEN = loadAdminToken();

const openApiPath = path.join(__dirname, 'openapi.json');
const openApiClientPath = path.join(__dirname, 'openapi-client.json');
const openApiAdminPath = path.join(__dirname, 'openapi-admin.json');
const usageSockets = new Set();

app.use((req, res, next) => {
  const origin = req.headers.origin || '*';
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', req.headers['access-control-request-headers'] || '*');
  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }
  next();
});

app.use(express.json({ limit: '1mb' }));

function parseAuth(header) {
  if (!header) return { token: null, matricula: null, isAdminToken: false, invalid: false };
  const token = header.replace(/Bearer\s+/i, '').trim();
  const isAdminToken = token === ADMIN_TOKEN;
  const matricula = /^[0-9]{7}$/.test(token) ? token : null;
  const invalid = !isAdminToken && !matricula;
  return { token, matricula, isAdminToken, invalid };
}

function requireAuth(req, res, next) {
  if (req.invalidAuthToken) {
    return res
      .status(401)
      .json({ error: 'Authorization header inválido: use matrícula de 7 dígitos ou token de admin' });
  }
  if (!req.matricula && !req.isAdmin) {
    return res
      .status(401)
      .json({ error: 'Authorization header with matricula or admin token is required' });
  }
  next();
}

function requireAdmin(req, res, next) {
  if (!req.isAdmin) {
    return res.status(403).json({ error: 'Admin privileges required' });
  }
  next();
}

app.use(async (req, res, next) => {
  const auth = parseAuth(req.header('authorization'));
  req.matricula = auth.matricula || (auth.isAdminToken ? 'admin' : null);
  req.isAdmin = auth.isAdminToken;
  req.invalidAuthToken = auth.invalid;
  res.on('finish', async () => {
    try {
      const log = await prisma.usageLog.create({
        data: {
          matricula: req.matricula,
          method: req.method,
          path: req.originalUrl,
          status: res.statusCode,
        },
      });
      const payload = JSON.stringify({ type: 'usage', log });
      usageSockets.forEach((conn) => {
        if (conn.ws.readyState !== conn.ws.OPEN) return;
        if (!conn.includeAdmin && isAdminMat(log.matricula)) return;
        conn.ws.send(payload);
      });
    } catch (err) {
      // avoid throwing during response finalization
      console.error('Failed to persist usage log', err.message);
    }
  });
  next();
});

app.get('/health', (req, res) => res.json({ status: 'ok', time: new Date().toISOString() }));
app.get('/status', (req, res) => res.json({ status: 'ok', time: new Date().toISOString() }));
app.get('/openapi.json', (req, res) => res.sendFile(openApiPath));
app.get('/openapi-client.json', (req, res) => res.sendFile(openApiClientPath));
app.get('/openapi-admin.json', (req, res) => res.sendFile(openApiAdminPath));
app.get('/privacy', (req, res) => {
  const filePath = path.join(__dirname, '..', 'PRIVACY.md');
  res.sendFile(filePath);
});
app.use(
  '/docs',
  swaggerUi.serve,
  swaggerUi.setup(null, {
    explorer: true,
    swaggerOptions: {
      urls: [
        { url: '/openapi-client.json', name: 'Client API (<=30 ops)' },
        { url: '/openapi-admin.json', name: 'Admin API (<=30 ops)' },
        { url: '/openapi.json', name: 'Full API' },
      ],
    },
  })
);

function ensureSelfOrAdmin(req, res, targetMatricula) {
  if (req.isAdmin) return true;
  if (!req.matricula) {
    res.status(401).json({ error: 'Authorization header required' });
    return false;
  }
  if (req.matricula !== targetMatricula) {
    res.status(403).json({ error: 'Not allowed for this matricula' });
    return false;
  }
  return true;
}

function pickClientPayload(body) {
  const payload = {
    name: body.name,
    email: body.email,
    role: body.role === 'ADMIN' ? Role.ADMIN : Role.STUDENT,
    active: body.active !== undefined ? !!body.active : undefined,
  };
  return payload;
}

function parseDateSafe(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function validateDateRange(checkInRaw, checkOutRaw) {
  const checkIn = parseDateSafe(checkInRaw);
  const checkOut = parseDateSafe(checkOutRaw);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  if (checkIn && checkIn < today) return { error: 'checkIn must be today or a future date' };
  if (checkOut && checkOut < today) return { error: 'checkOut must be today or a future date' };
  if (checkIn && checkOut && checkOut <= checkIn) return { error: 'checkOut must be after checkIn' };
  return { checkIn, checkOut };
}

// Hotels
app.get('/hotels', async (req, res) => {
  const { city, priceMin, priceMax, stars, amenities } = req.query;
  const where = {};
  if (city) where.city = { contains: city, mode: 'insensitive' };
  if (stars) where.stars = Number(stars);
  if (priceMin || priceMax) {
    where.price = {};
    if (priceMin) where.price.gte = Number(priceMin);
    if (priceMax) where.price.lte = Number(priceMax);
  }
  if (amenities) {
    const list = String(amenities)
      .split(',')
      .map((v) => v.trim())
      .filter(Boolean);
    if (list.length) where.amenities = { hasSome: list };
  }
  const hotels = await prisma.hotel.findMany({
    where,
    include: { roomTypes: true, reviews: true },
    orderBy: { id: 'asc' },
  });
  res.json(hotels);
});

app.post('/hotels', requireAuth, requireAdmin, async (req, res) => {
  const { name, city, country, address, price, stars, amenities, locationId, roomTypes } =
    req.body;
  const hotel = await prisma.hotel.create({
    data: {
      name,
      city,
      country,
      address,
      price,
      stars,
      amenities: amenities || [],
      locationId,
      roomTypes: roomTypes
        ? {
            create: roomTypes.map((room) => ({
              name: room.name,
              price: room.price,
              available: room.available ?? 5,
            })),
          }
        : undefined,
    },
    include: { roomTypes: true },
  });
  res.status(201).json(hotel);
});

app.get('/hotels/:id', async (req, res) => {
  const id = Number(req.params.id);
  const hotel = await prisma.hotel.findUnique({
    where: { id },
    include: { roomTypes: true, reviews: true },
  });
  if (!hotel) return res.status(404).json({ error: 'Hotel not found' });
  res.json(hotel);
});

app.put('/hotels/:id', requireAuth, requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  try {
    const hotel = await prisma.hotel.update({
      where: { id },
      data: {
        name: req.body.name,
        city: req.body.city,
        country: req.body.country,
        address: req.body.address,
        price: req.body.price,
        stars: req.body.stars,
        amenities: req.body.amenities,
        locationId: req.body.locationId,
      },
    });
    res.json(hotel);
  } catch (err) {
    res.status(404).json({ error: 'Hotel not found' });
  }
});

app.patch('/hotels/:id', requireAuth, requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  try {
    const hotel = await prisma.hotel.update({
      where: { id },
      data: req.body,
    });
    res.json(hotel);
  } catch (err) {
    res.status(404).json({ error: 'Hotel not found' });
  }
});

app.delete('/hotels/:id', requireAuth, requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  try {
    await prisma.hotel.delete({ where: { id } });
    res.json({ deleted: true });
  } catch (err) {
    res.status(404).json({ error: 'Hotel not found' });
  }
});

app.get('/hotels/:id/availability', async (req, res) => {
  const id = Number(req.params.id);
  const hotel = await prisma.hotel.findUnique({
    where: { id },
    include: { roomTypes: true },
  });
  if (!hotel) return res.status(404).json({ error: 'Hotel not found' });
  const startDate = parseDateSafe(req.query.startDate);
  const endDate = parseDateSafe(req.query.endDate);
  let bookingsOverlap = 0;
  if (startDate || endDate) {
    bookingsOverlap = await prisma.booking.count({
      where: {
        hotelId: id,
        AND: [
          startDate ? { checkOut: { gte: startDate } } : {},
          endDate ? { checkIn: { lte: endDate } } : {},
        ],
      },
    });
  }
  const rooms = hotel.roomTypes.map((room) => {
    const available = Math.max((room.available ?? 0) - bookingsOverlap, 0);
    return {
      roomType: room.name,
      price: room.price,
      available,
    };
  });
  res.json({
    hotelId: id,
    startDate: req.query.startDate || null,
    endDate: req.query.endDate || null,
    rooms,
  });
});

// Locations
app.get('/locations', async (req, res) => {
  const locations = await prisma.location.findMany({ include: { hotels: true } });
  res.json(locations);
});

app.post('/locations', requireAuth, requireAdmin, async (req, res) => {
  const { name, city, state, country, description } = req.body;
  const location = await prisma.location.create({
    data: { name, city, state, country, description },
  });
  res.status(201).json(location);
});

app.get('/locations/:id', async (req, res) => {
  const id = Number(req.params.id);
  const location = await prisma.location.findUnique({
    where: { id },
    include: { hotels: true },
  });
  if (!location) return res.status(404).json({ error: 'Location not found' });
  res.json(location);
});

app.put('/locations/:id', requireAuth, requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  try {
    const location = await prisma.location.update({
      where: { id },
      data: req.body,
    });
    res.json(location);
  } catch (err) {
    res.status(404).json({ error: 'Location not found' });
  }
});

app.delete('/locations/:id', requireAuth, requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  try {
    await prisma.location.delete({ where: { id } });
    res.json({ deleted: true });
  } catch (err) {
    res.status(404).json({ error: 'Location not found' });
  }
});

// Planes / flights
async function listPlanes(req, res) {
  const { origin, destination, date } = req.query;
  const originTokens = tokensForSearch(origin);
  const destinationTokens = tokensForSearch(destination);

  const where = { AND: [] };
  if (originTokens.length) {
    where.AND.push({ OR: originTokens.map((t) => ({ origin: { contains: t, mode: 'insensitive' } })) });
  }
  if (destinationTokens.length) {
    where.AND.push({ OR: destinationTokens.map((t) => ({ destination: { contains: t, mode: 'insensitive' } })) });
  }
  if (date) {
    const day = new Date(date);
    if (!Number.isNaN(day.getTime())) {
      const nextDay = new Date(day);
      nextDay.setDate(day.getDate() + 1);
      where.AND.push({ departure: { gte: day, lt: nextDay } });
    }
  }

  const planes = await prisma.plane.findMany({
    where: where.AND.length ? where : undefined,
    orderBy: { departure: 'asc' },
  });
  res.json(planes);
}

app.get('/planes', listPlanes);
app.get('/planes/search', listPlanes);

app.post('/planes', requireAuth, requireAdmin, async (req, res) => {
  const { code, origin, destination, departure, arrival, price } = req.body;
  const plane = await prisma.plane.create({
    data: {
      code,
      origin,
      destination,
      departure: departure ? new Date(departure) : new Date(),
      arrival: arrival ? new Date(arrival) : new Date(),
      price,
    },
  });
  res.status(201).json(plane);
});

app.get('/planes/:id', async (req, res) => {
  const id = Number(req.params.id);
  const plane = await prisma.plane.findUnique({ where: { id } });
  if (!plane) return res.status(404).json({ error: 'Plane not found' });
  res.json(plane);
});

app.put('/planes/:id', requireAuth, requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  try {
    const plane = await prisma.plane.update({
      where: { id },
      data: {
        code: req.body.code,
        origin: req.body.origin,
        destination: req.body.destination,
        departure: req.body.departure ? new Date(req.body.departure) : undefined,
        arrival: req.body.arrival ? new Date(req.body.arrival) : undefined,
        price: req.body.price,
      },
    });
    res.json(plane);
  } catch (err) {
    res.status(404).json({ error: 'Plane not found' });
  }
});

app.delete('/planes/:id', requireAuth, requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  try {
    await prisma.plane.delete({ where: { id } });
    res.json({ deleted: true });
  } catch (err) {
    res.status(404).json({ error: 'Plane not found' });
  }
});

// Clients
app.get('/clients', requireAuth, requireAdmin, async (req, res) => {
  const clients = await prisma.client.findMany({ orderBy: { matricula: 'asc' } });
  res.json(clients);
});

app.post('/clients', requireAuth, async (req, res) => {
  const matricula = req.body.matricula;
  if (!/^[0-9]{7}$/.test(matricula || '')) {
    return res.status(400).json({ error: 'matricula must be 7 digits' });
  }
  const payload = pickClientPayload(req.body);
  try {
    const client = await prisma.client.create({
      data: { matricula, ...payload, createdBy: req.matricula || (req.isAdmin ? 'admin' : null) },
    });
    res.status(201).json(client);
  } catch (err) {
    res.status(409).json({ error: 'Client already exists' });
  }
});

app.get('/clients/:matricula', requireAuth, async (req, res) => {
  const { matricula } = req.params;
  const client = await prisma.client.findUnique({ where: { matricula } });
  if (!client) return res.status(404).json({ error: 'Client not found' });
  res.json(client);
});

app.put('/clients/:matricula', requireAuth, async (req, res) => {
  const { matricula } = req.params;
  const existing = await prisma.client.findUnique({ where: { matricula } });
  if (!existing) return res.status(404).json({ error: 'Client not found' });
  const payload = pickClientPayload(req.body);
  try {
    const client = await prisma.client.update({
      where: { matricula },
      data: payload,
    });
    res.json(client);
  } catch (err) {
    res.status(404).json({ error: 'Client not found' });
  }
});

app.delete('/clients/:matricula', requireAuth, async (req, res) => {
  const { matricula } = req.params;
  const existing = await prisma.client.findUnique({ where: { matricula } });
  if (!existing) return res.status(404).json({ error: 'Client not found' });
  if (!canAccessResource(req, res, existing.matricula, existing.createdBy, 'client')) return;
  try {
    await prisma.client.delete({ where: { matricula } });
    res.json({ deleted: true });
  } catch (err) {
    res.status(404).json({ error: 'Client not found' });
  }
});

// Purchases
app.post('/purchases', requireAuth, async (req, res) => {
  const {
    clientMatricula = req.matricula,
    hotelId,
    planeId,
    checkIn,
    checkOut,
    totalAmount,
    guests = 1,
  } = req.body;
  if (!ensureSelfOrAdmin(req, res, clientMatricula)) return;
  const amount = parseAmount(totalAmount);
  if (amount === null) return res.status(400).json({ error: 'totalAmount must be a number' });
  const dateValidation = validateDateRange(checkIn, checkOut);
  if (dateValidation.error) return res.status(400).json({ error: dateValidation.error });
  if (hotelId && planeId) {
    const [hotel, plane] = await Promise.all([
      prisma.hotel.findUnique({ where: { id: hotelId } }),
      prisma.plane.findUnique({ where: { id: planeId } }),
    ]);
    if (hotel && plane && !destinationMatchesCity(plane.destination, hotel.city)) {
      return res.status(400).json({ error: 'Plane destination does not match hotel city' });
    }
  }
  const purchase = await prisma.purchase.create({
    data: {
      clientMatricula,
      hotelId,
      planeId,
      checkIn: dateValidation.checkIn,
      checkOut: dateValidation.checkOut,
      totalAmount: amount,
      guests,
      createdBy: req.matricula || (req.isAdmin ? 'admin' : null),
    },
  });
  res.status(201).json(purchase);
});

app.get('/purchases/:id', requireAuth, async (req, res) => {
  const id = Number(req.params.id);
  const purchase = await prisma.purchase.findUnique({
    where: { id },
  });
  if (!purchase) return res.status(404).json({ error: 'Purchase not found' });
  if (!canAccessPurchase(req, res, purchase)) return;
  res.json(purchase);
});

app.put('/purchases/:id', requireAuth, async (req, res) => {
  const id = Number(req.params.id);
  const existing = await prisma.purchase.findUnique({ where: { id } });
  if (!existing) return res.status(404).json({ error: 'Purchase not found' });
  if (!canAccessPurchase(req, res, existing)) return;
  const amount = parseAmount(req.body.totalAmount);
  if (amount === null) return res.status(400).json({ error: 'totalAmount must be a number' });
  const dateValidation = validateDateRange(req.body.checkIn, req.body.checkOut);
  if (dateValidation.error) return res.status(400).json({ error: dateValidation.error });
  if (req.body.hotelId && req.body.planeId) {
    const [hotel, plane] = await Promise.all([
      prisma.hotel.findUnique({ where: { id: req.body.hotelId } }),
      prisma.plane.findUnique({ where: { id: req.body.planeId } }),
    ]);
    if (hotel && plane && !destinationMatchesCity(plane.destination, hotel.city)) {
      return res.status(400).json({ error: 'Plane destination does not match hotel city' });
    }
  }
  const purchase = await prisma.purchase.update({
    where: { id },
    data: {
      hotelId: req.body.hotelId,
      planeId: req.body.planeId,
      checkIn: dateValidation.checkIn,
      checkOut: dateValidation.checkOut,
      totalAmount: amount,
      guests: req.body.guests,
    },
  });
  res.json(purchase);
});

app.delete('/purchases/:id', requireAuth, async (req, res) => {
  const id = Number(req.params.id);
  const existing = await prisma.purchase.findUnique({ where: { id } });
  if (!existing) return res.status(404).json({ error: 'Purchase not found' });
  if (!canAccessPurchase(req, res, existing)) return;
  await prisma.purchase.delete({ where: { id } });
  res.json({ deleted: true });
});

// Offers
app.get('/offers', async (req, res) => {
  const { date } = req.query;
  let filterDate = null;
  if (date) {
    const d = new Date(date);
    if (!isNaN(d)) filterDate = d;
  }
  const offers = await prisma.offer.findMany({
    where: filterDate ? { OR: [{ validUntil: null }, { validUntil: { gte: filterDate } }] } : undefined,
    orderBy: { id: 'asc' },
  });
  res.json(offers);
});

app.get('/offers/today', async (req, res) => {
  const today = new Date();
  const offers = await prisma.offer.findMany({
    where: {
      OR: [{ validUntil: null }, { validUntil: { gte: today } }],
    },
    orderBy: { id: 'asc' },
  });
  res.json(offers);
});

app.get('/offers/:id', async (req, res) => {
  const id = Number(req.params.id);
  const offer = await prisma.offer.findUnique({ where: { id } });
  if (!offer) return res.status(404).json({ error: 'Offer not found' });
  res.json(offer);
});

app.post('/offers', requireAuth, requireAdmin, async (req, res) => {
  const offer = await prisma.offer.create({
    data: {
      title: req.body.title,
      description: req.body.description,
      discountPercent: req.body.discountPercent,
      validUntil: req.body.validUntil ? new Date(req.body.validUntil) : null,
    },
  });
  res.status(201).json(offer);
});

app.put('/offers/:id', requireAuth, requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  try {
    const offer = await prisma.offer.update({
      where: { id },
      data: {
        title: req.body.title,
        description: req.body.description,
        discountPercent: req.body.discountPercent,
        validUntil: req.body.validUntil ? new Date(req.body.validUntil) : null,
      },
    });
    res.json(offer);
  } catch (err) {
    res.status(404).json({ error: 'Offer not found' });
  }
});

app.delete('/offers/:id', requireAuth, requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  try {
    await prisma.offer.delete({ where: { id } });
    res.json({ deleted: true });
  } catch (err) {
    res.status(404).json({ error: 'Offer not found' });
  }
});

// Bookings
app.post('/bookings', requireAuth, async (req, res) => {
  const {
    clientMatricula = req.matricula,
    hotelId,
    planeId,
    itineraryId,
    status,
    checkIn,
    checkOut,
    totalAmount,
  } = req.body;
  const amount = parseAmount(totalAmount);
  if (amount === null) return res.status(400).json({ error: 'totalAmount must be a number' });
  const dateValidation = validateDateRange(checkIn, checkOut);
  if (dateValidation.error) return res.status(400).json({ error: dateValidation.error });
  if (hotelId && planeId) {
    const [hotel, plane] = await Promise.all([
      prisma.hotel.findUnique({ where: { id: hotelId } }),
      prisma.plane.findUnique({ where: { id: planeId } }),
    ]);
    if (hotel && plane && !destinationMatchesCity(plane.destination, hotel.city)) {
      return res.status(400).json({ error: 'Plane destination does not match hotel city' });
    }
  }
  const booking = await prisma.booking.create({
    data: {
      clientMatricula,
      hotelId,
      planeId,
      itineraryId,
      status: status || 'CONFIRMED',
      checkIn: dateValidation.checkIn,
      checkOut: dateValidation.checkOut,
      totalAmount: amount,
      createdBy: req.matricula || (req.isAdmin ? 'admin' : 'unknown'),
    },
  });
  res.status(201).json(booking);
});

app.get('/bookings/:id', requireAuth, async (req, res) => {
  const id = Number(req.params.id);
  const booking = await prisma.booking.findUnique({
    where: { id },
  });
  if (!booking) return res.status(404).json({ error: 'Booking not found' });
  if (!canAccessBooking(req, res, booking)) return;
  res.json(booking);
});

app.put('/bookings/:id', requireAuth, async (req, res) => {
  const id = Number(req.params.id);
  const existing = await prisma.booking.findUnique({ where: { id } });
  if (!existing) return res.status(404).json({ error: 'Booking not found' });
  if (!canAccessBooking(req, res, existing)) return;
  const amount = parseAmount(req.body.totalAmount);
  if (amount === null) return res.status(400).json({ error: 'totalAmount must be a number' });
  const dateValidation = validateDateRange(req.body.checkIn, req.body.checkOut);
  if (dateValidation.error) return res.status(400).json({ error: dateValidation.error });
  if (req.body.hotelId && req.body.planeId) {
    const [hotel, plane] = await Promise.all([
      prisma.hotel.findUnique({ where: { id: req.body.hotelId } }),
      prisma.plane.findUnique({ where: { id: req.body.planeId } }),
    ]);
    if (hotel && plane && !destinationMatchesCity(plane.destination, hotel.city)) {
      return res.status(400).json({ error: 'Plane destination does not match hotel city' });
    }
  }
  const booking = await prisma.booking.update({
    where: { id },
    data: {
      hotelId: req.body.hotelId,
      planeId: req.body.planeId,
      itineraryId: req.body.itineraryId,
      status: req.body.status,
      checkIn: dateValidation.checkIn,
      checkOut: dateValidation.checkOut,
      totalAmount: amount,
    },
  });
  res.json(booking);
});

app.delete('/bookings/:id', requireAuth, async (req, res) => {
  const id = Number(req.params.id);
  const existing = await prisma.booking.findUnique({ where: { id } });
  if (!existing) return res.status(404).json({ error: 'Booking not found' });
  if (!canAccessBooking(req, res, existing)) return;
  await prisma.booking.delete({ where: { id } });
  res.json({ deleted: true });
});

app.post('/purchases/:id/attach-itinerary', requireAuth, async (req, res) => {
  const id = Number(req.params.id);
  const { itineraryId } = req.body || {};
  if (!itineraryId) return res.status(400).json({ error: 'itineraryId is required' });
  const purchase = await prisma.purchase.findUnique({ where: { id } });
  if (!purchase) return res.status(404).json({ error: 'Purchase not found' });
  if (!canAccessPurchase(req, res, purchase)) return;

  const itinerary = await prisma.itinerary.findUnique({ where: { id: Number(itineraryId) } });
  if (!itinerary) return res.status(404).json({ error: 'Itinerary not found' });
  if (!canAccessResource(req, res, itinerary.clientMatricula, itinerary.createdBy, 'itinerary')) return;

  if (!purchase.hotelId && !purchase.planeId) {
    return res.status(400).json({ error: 'Purchase must include a hotelId or planeId to attach' });
  }

  const existingBooking = await prisma.booking.findFirst({
    where: {
      clientMatricula: purchase.clientMatricula,
      itineraryId: itinerary.id,
      hotelId: purchase.hotelId || undefined,
      planeId: purchase.planeId || undefined,
    },
  });
  if (existingBooking) return res.json(existingBooking);

  const booking = await prisma.booking.create({
    data: {
      clientMatricula: purchase.clientMatricula,
      hotelId: purchase.hotelId || null,
      planeId: purchase.planeId || null,
      itineraryId: itinerary.id,
      status: 'CONFIRMED',
      checkIn: purchase.checkIn,
      checkOut: purchase.checkOut,
      totalAmount: purchase.totalAmount,
      createdBy: req.matricula || (req.isAdmin ? 'admin' : 'unknown'),
    },
  });
  res.status(201).json(booking);
});

// Itineraries
app.post('/itineraries', requireAuth, async (req, res) => {
  const { name, notes, clientMatricula = req.matricula } = req.body;
  const client = await prisma.client.findUnique({ where: { matricula: clientMatricula } });
  if (!client) return res.status(404).json({ error: 'Client not found for itinerary' });
  const itinerary = await prisma.itinerary.create({
    data: { name, notes, clientMatricula, createdBy: req.matricula || (req.isAdmin ? 'admin' : null) },
  });
  res.status(201).json(itinerary);
});

app.get('/itineraries/:id', requireAuth, async (req, res) => {
  const id = Number(req.params.id);
  const itinerary = await prisma.itinerary.findUnique({
    where: { id },
    include: { bookings: true },
  });
  if (!itinerary) return res.status(404).json({ error: 'Itinerary not found' });
  if (!canAccessResource(req, res, itinerary.clientMatricula, itinerary.createdBy, 'itinerary')) return;
  res.json(itinerary);
});

app.put('/itineraries/:id', requireAuth, async (req, res) => {
  const id = Number(req.params.id);
  const itinerary = await prisma.itinerary.findUnique({ where: { id } });
  if (!itinerary) return res.status(404).json({ error: 'Itinerary not found' });
  if (!canAccessResource(req, res, itinerary.clientMatricula, itinerary.createdBy, 'itinerary')) return;
  const updated = await prisma.itinerary.update({
    where: { id },
    data: { name: req.body.name, notes: req.body.notes },
  });
  res.json(updated);
});

app.delete('/itineraries/:id', requireAuth, async (req, res) => {
  const id = Number(req.params.id);
  const itinerary = await prisma.itinerary.findUnique({ where: { id } });
  if (!itinerary) return res.status(404).json({ error: 'Itinerary not found' });
  if (!canAccessResource(req, res, itinerary.clientMatricula, itinerary.createdBy, 'itinerary')) return;
  await prisma.itinerary.delete({ where: { id } });
  res.json({ deleted: true });
});

// Reviews
app.get('/hotels/:id/reviews', async (req, res) => {
  const hotelId = Number(req.params.id);
  const reviews = await prisma.review.findMany({
    where: { hotelId },
    orderBy: { createdAt: 'desc' },
  });
  res.json(reviews);
});

app.post('/hotels/:id/reviews', requireAuth, async (req, res) => {
  const hotelId = Number(req.params.id);
  const review = await prisma.review.create({
    data: {
      hotelId,
      clientMatricula: req.matricula,
      rating: req.body.rating,
      comment: req.body.comment,
    },
  });
  res.status(201).json(review);
});

// Reports (admin only)
app.get('/reports/sales', requireAuth, requireAdmin, async (req, res) => {
  const purchases = await prisma.purchase.findMany({
    include: { hotel: true, plane: true },
  });
  const totalsByDate = {};
  const totalsByHotel = {};
  const totalsByDestination = {};

  purchases.forEach((p) => {
    const dateKey = p.createdAt.toISOString().slice(0, 10);
    totalsByDate[dateKey] = (totalsByDate[dateKey] || 0) + p.totalAmount;
    if (p.hotel) {
      totalsByHotel[p.hotel.name] = (totalsByHotel[p.hotel.name] || 0) + p.totalAmount;
      totalsByDestination[p.hotel.city] = (totalsByDestination[p.hotel.city] || 0) + p.totalAmount;
    }
    if (p.plane) {
      totalsByDestination[p.plane.destination] =
        (totalsByDestination[p.plane.destination] || 0) + p.totalAmount;
    }
  });

  res.json({ totalsByDate, totalsByHotel, totalsByDestination, count: purchases.length });
});

app.get('/reports/clients', requireAuth, requireAdmin, async (req, res) => {
  const clients = await prisma.client.findMany();
  const active = clients.filter((c) => c.active).length;
  res.json({ total: clients.length, active, clients });
});

app.get('/reports/top-destinations', requireAuth, requireAdmin, async (req, res) => {
  const purchases = await prisma.purchase.findMany({
    include: { hotel: true, plane: true },
  });
  const counts = {};
  purchases.forEach((p) => {
    if (p.hotel) counts[p.hotel.city] = (counts[p.hotel.city] || 0) + 1;
    if (p.plane) counts[p.plane.destination] = (counts[p.plane.destination] || 0) + 1;
  });
  const sorted = Object.entries(counts)
    .map(([city, count]) => ({ city, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);
  res.json({ top: sorted });
});

app.get('/reports/usage', requireAuth, requireAdmin, async (req, res) => {
  const { matricula } = req.query;
  const includeAdminParam = (req.query.includeAdmin || '').toLowerCase();
  const includeAdmin = includeAdminParam === '1' || includeAdminParam === 'true';
  try {
    let where = matricula ? { matricula: String(matricula) } : undefined;
    if (!includeAdmin) {
      const notIn = ['admin', ...ADMIN_MATS];
      if (where && where.matricula) {
        if (isAdminMat(where.matricula)) {
          where = { matricula: '__none__' };
        }
      } else {
        where = { matricula: { notIn } };
      }
    }
    const logs = await prisma.usageLog.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
    res.json(logs);
  } catch (err) {
    // Keep the report endpoint stable while surfacing the full stack for investigation
    console.error('Failed to fetch usage logs', err?.stack || err);
    res.status(200).json([]);
  }
});

// Auth helper
app.post('/auth/login', async (req, res) => {
  const payload = req.body || {};
  const matricula = payload.matricula || req.query?.matricula;
  if (!/^[0-9]{7}$/.test(matricula || '')) {
    return res.status(400).json({ error: 'matricula must be 7 digits' });
  }
  res.json({ token: matricula, bearer: `Bearer ${matricula}` });
});

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Unexpected error', detail: err.message });
});

app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

server.listen(PORT, () => {
  console.log(`API running on port ${PORT}`);
});

function handleUsageWsConnection(ws, req) {
  const url = new URL(req.url || '', 'http://localhost');
  const token = url.searchParams.get('adminToken');
  const includeAdminParam = (url.searchParams.get('includeAdmin') || '').toLowerCase();
  const includeAdmin = includeAdminParam === '1' || includeAdminParam === 'true';
  if (token !== ADMIN_TOKEN) {
    ws.close(1008, 'Admin token required');
    return;
  }
  const conn = { ws, includeAdmin };
  usageSockets.add(conn);
  ws.on('close', () => usageSockets.delete(conn));
  ws.on('error', () => usageSockets.delete(conn));

  (async () => {
    try {
      const logs = await prisma.usageLog.findMany({
        orderBy: { createdAt: 'desc' },
        take: 50,
      });
      const filtered = includeAdmin ? logs : logs.filter((l) => !isAdminMat(l.matricula));
      ws.send(JSON.stringify({ type: 'usage:init', logs: filtered.reverse() }));
    } catch (err) {
      ws.send(JSON.stringify({ type: 'usage:init', logs: [] }));
    }
  })();
}

// Accept WebSocket connections on the HTTP port (upgrade) and also on WS_PORT for reverse proxies.
const wss = new WebSocketServer({ noServer: true });
wss.on('connection', handleUsageWsConnection);

server.on('upgrade', (req, socket, head) => {
  if (!req.url || !req.url.startsWith('/reports/usage/stream')) {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
});

if (WS_PORT) {
  const standaloneWss = new WebSocketServer({ port: WS_PORT });
  standaloneWss.on('connection', handleUsageWsConnection);
  console.log(`WebSocket server running on port ${WS_PORT}`);
} else {
  console.log(`WebSocket server attached to HTTP port ${PORT}`);
}

async function ensureUnaccentExtension() {
  // kept for backward compatibility; no-op after removing unaccent usage
}

function tokensForSearch(value) {
  if (!value) return [];
  const sanitized = String(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim();
  if (!sanitized) return [];
  const parts = sanitized.split(/\s+/).filter(Boolean);
  const tokens = new Set(parts);
  const noSpaces = parts.join('');
  if (noSpaces) {
    tokens.add(noSpaces);
    if (noSpaces.length >= 3) tokens.add(noSpaces.slice(0, 3));
  }
  const initials = parts.map((p) => p[0]).join('');
  if (initials) tokens.add(initials);
  return Array.from(tokens);
}

function normalizeCity(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, '')
    .toUpperCase();
}

const DESTINATION_ALIASES = {
  SAO: 'SAOPAULO',
  GRU: 'SAOPAULO',
  CGH: 'SAOPAULO',
  NYC: 'NEWYORK',
  JFK: 'NEWYORK',
  LGA: 'NEWYORK',
  EWR: 'NEWYORK',
  RIO: 'RIODEJANEIRO',
  GIG: 'RIODEJANEIRO',
  SDU: 'RIODEJANEIRO',
};

function destinationMatchesCity(planeDestination, hotelCity) {
  if (!planeDestination || !hotelCity) return true;
  const planeNorm = normalizeCity(planeDestination);
  const hotelNorm = normalizeCity(hotelCity);
  const alias = DESTINATION_ALIASES[planeNorm] || planeNorm;
  if (hotelNorm === alias) return true;
  if (hotelNorm.includes(alias) || alias.includes(hotelNorm)) return true;
  // last-resort fuzzy: allow common city names to match common codes
  const cityTokens = tokensForSearch(hotelCity).map((t) => t.toUpperCase());
  if (cityTokens.some((t) => alias.includes(t) || t.includes(alias))) return true;
  return false;
}

function isAdminMat(matricula) {
  if (!matricula) return false;
  const value = String(matricula);
  return value === 'admin' || ADMIN_MATS.includes(value);
}

function parseAmount(raw) {
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function canAccessResource(req, res, targetMatricula, createdBy, resourceName = 'resource') {
  if (req.isAdmin) return true;
  if (req.invalidAuthToken || !req.matricula) {
    res.status(401).json({ error: 'Authorization header required' });
    return false;
  }
  if (req.matricula === targetMatricula) return true;
  if (createdBy && createdBy === req.matricula) return true;
  res.status(403).json({ error: `Not allowed for this ${resourceName}` });
  return false;
}

function canAccessPurchase(req, res, purchase) {
  return canAccessResource(req, res, purchase.clientMatricula, purchase.createdBy, 'purchase');
}

function canAccessBooking(req, res, booking) {
  return canAccessResource(req, res, booking.clientMatricula, booking.createdBy, 'booking');
}
