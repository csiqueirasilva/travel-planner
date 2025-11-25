require('dotenv').config();
const express = require('express');
const cors = require('cors');
const swaggerUi = require('swagger-ui-express');
const fs = require('fs');
const path = require('path');
const { PrismaClient, Role } = require('@prisma/client');

const prisma = new PrismaClient();
const app = express();

const PORT = process.env.PORT || 3000;

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
const openApiDoc = JSON.parse(fs.readFileSync(openApiPath, 'utf8'));

app.use(
  cors({
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['*'],
  })
);
app.use(express.json({ limit: '1mb' }));

function parseAuth(header) {
  if (!header) return { token: null, matricula: null, isAdminToken: false };
  const token = header.replace(/Bearer\s+/i, '').trim();
  const isAdminToken = token === ADMIN_TOKEN;
  const matricula = /^[0-9]{7}$/.test(token) ? token : null;
  return { token, matricula, isAdminToken };
}

function requireAuth(req, res, next) {
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
  res.on('finish', async () => {
    try {
      await prisma.usageLog.create({
        data: {
          matricula: req.matricula,
          method: req.method,
          path: req.originalUrl,
          status: res.statusCode,
        },
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
app.get('/openapi.json', (req, res) => res.json(openApiDoc));
app.use('/docs', swaggerUi.serve, swaggerUi.setup(openApiDoc, { explorer: true }));

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
  const rooms = hotel.roomTypes.map((room) => ({
    roomType: room.name,
    price: room.price,
    available: room.available,
  }));
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
  const where = {};
  if (origin) where.origin = { contains: origin, mode: 'insensitive' };
  if (destination) where.destination = { contains: destination, mode: 'insensitive' };
  if (date) {
    const day = new Date(date);
    const nextDay = new Date(day);
    nextDay.setDate(day.getDate() + 1);
    where.departure = { gte: day, lt: nextDay };
  }
  const planes = await prisma.plane.findMany({ where, orderBy: { departure: 'asc' } });
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
      data: { matricula, ...payload },
    });
    res.status(201).json(client);
  } catch (err) {
    res.status(409).json({ error: 'Client already exists' });
  }
});

app.get('/clients/:matricula', requireAuth, async (req, res) => {
  const { matricula } = req.params;
  if (!ensureSelfOrAdmin(req, res, matricula)) return;
  const client = await prisma.client.findUnique({ where: { matricula } });
  if (!client) return res.status(404).json({ error: 'Client not found' });
  res.json(client);
});

app.put('/clients/:matricula', requireAuth, async (req, res) => {
  const { matricula } = req.params;
  if (!ensureSelfOrAdmin(req, res, matricula)) return;
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
  if (!ensureSelfOrAdmin(req, res, matricula)) return;
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
  const purchase = await prisma.purchase.create({
    data: {
      clientMatricula,
      hotelId,
      planeId,
      checkIn: checkIn ? new Date(checkIn) : null,
      checkOut: checkOut ? new Date(checkOut) : null,
      totalAmount,
      guests,
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
  if (!ensureSelfOrAdmin(req, res, purchase.clientMatricula)) return;
  res.json(purchase);
});

app.put('/purchases/:id', requireAuth, async (req, res) => {
  const id = Number(req.params.id);
  const existing = await prisma.purchase.findUnique({ where: { id } });
  if (!existing) return res.status(404).json({ error: 'Purchase not found' });
  if (!ensureSelfOrAdmin(req, res, existing.clientMatricula)) return;
  const purchase = await prisma.purchase.update({
    where: { id },
    data: {
      hotelId: req.body.hotelId,
      planeId: req.body.planeId,
      checkIn: req.body.checkIn ? new Date(req.body.checkIn) : null,
      checkOut: req.body.checkOut ? new Date(req.body.checkOut) : null,
      totalAmount: req.body.totalAmount,
      guests: req.body.guests,
    },
  });
  res.json(purchase);
});

app.delete('/purchases/:id', requireAuth, async (req, res) => {
  const id = Number(req.params.id);
  const existing = await prisma.purchase.findUnique({ where: { id } });
  if (!existing) return res.status(404).json({ error: 'Purchase not found' });
  if (!ensureSelfOrAdmin(req, res, existing.clientMatricula)) return;
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
  if (!ensureSelfOrAdmin(req, res, clientMatricula)) return;
  const booking = await prisma.booking.create({
    data: {
      clientMatricula,
      hotelId,
      planeId,
      itineraryId,
      status: status || 'CONFIRMED',
      checkIn: checkIn ? new Date(checkIn) : null,
      checkOut: checkOut ? new Date(checkOut) : null,
      totalAmount,
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
  if (!ensureSelfOrAdmin(req, res, booking.clientMatricula)) return;
  res.json(booking);
});

app.put('/bookings/:id', requireAuth, async (req, res) => {
  const id = Number(req.params.id);
  const existing = await prisma.booking.findUnique({ where: { id } });
  if (!existing) return res.status(404).json({ error: 'Booking not found' });
  if (!ensureSelfOrAdmin(req, res, existing.clientMatricula)) return;
  const booking = await prisma.booking.update({
    where: { id },
    data: {
      hotelId: req.body.hotelId,
      planeId: req.body.planeId,
      itineraryId: req.body.itineraryId,
      status: req.body.status,
      checkIn: req.body.checkIn ? new Date(req.body.checkIn) : null,
      checkOut: req.body.checkOut ? new Date(req.body.checkOut) : null,
      totalAmount: req.body.totalAmount,
    },
  });
  res.json(booking);
});

app.delete('/bookings/:id', requireAuth, async (req, res) => {
  const id = Number(req.params.id);
  const existing = await prisma.booking.findUnique({ where: { id } });
  if (!existing) return res.status(404).json({ error: 'Booking not found' });
  if (!ensureSelfOrAdmin(req, res, existing.clientMatricula)) return;
  await prisma.booking.delete({ where: { id } });
  res.json({ deleted: true });
});

// Itineraries
app.post('/itineraries', requireAuth, async (req, res) => {
  const { name, notes, clientMatricula = req.matricula } = req.body;
  if (!ensureSelfOrAdmin(req, res, clientMatricula)) return;
  const itinerary = await prisma.itinerary.create({
    data: { name, notes, clientMatricula },
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
  if (!ensureSelfOrAdmin(req, res, itinerary.clientMatricula)) return;
  res.json(itinerary);
});

app.delete('/itineraries/:id', requireAuth, async (req, res) => {
  const id = Number(req.params.id);
  const itinerary = await prisma.itinerary.findUnique({ where: { id } });
  if (!itinerary) return res.status(404).json({ error: 'Itinerary not found' });
  if (!ensureSelfOrAdmin(req, res, itinerary.clientMatricula)) return;
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
  const logs = await prisma.usageLog.findMany({
    where: matricula ? { matricula: String(matricula) } : undefined,
    orderBy: { createdAt: 'desc' },
    take: 200,
  });
  res.json(logs);
});

// Auth helper
app.post('/auth/login', async (req, res) => {
  const { matricula } = req.body;
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

app.listen(PORT, () => {
  console.log(`API running on port ${PORT}`);
});
